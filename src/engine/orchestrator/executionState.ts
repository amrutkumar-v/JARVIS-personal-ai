/**
 * Phase 5 — Structured execution state tracker.
 *
 * Tracks the full lifecycle of an agentic goal execution:
 *   thinking → planning → executing → observing → verifying →
 *   recovering → replanning → completed/failed/cancelled
 *
 * Every state transition is recorded. The state is queryable at any point.
 * This is NOT the existing AgentStateMachine (which tracks the engine-level
 * provider loop). This tracks the AGENTIC LOOP: goal → plan → execute →
 * observe → verify → replan.
 */

export type AgenticPhase =
  | 'thinking'
  | 'planning'
  | 'executing'
  | 'observing'
  | 'verifying'
  | 'recovering'
  | 'replanning'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type StepExecutionState =
  | 'planned'
  | 'permission_pending'
  | 'executing'
  | 'executed'
  | 'observing'
  | 'observed'
  | 'verifying'
  | 'verified'
  | 'verification_failed'
  | 'failed'
  | 'recovery'
  | 'replanned'
  | 'skipped'
  | 'cancelled'

export interface StepState {
  readonly stepIndex: number
  readonly toolId: string
  readonly capability?: string
  readonly description: string
  readonly input: Record<string, unknown>
  state: StepExecutionState
  result?: { success: boolean; summary: string; output: unknown }
  observation?: { kind: string; summary: string; data?: unknown }
  verification?: { passed: boolean; message: string }
  error?: string
  errorKind?: string
  recoveryAction?: string
  startedAt?: number
  completedAt?: number
}

export interface PhaseTransition {
  readonly phase: AgenticPhase
  readonly at: number
  readonly detail?: string
}

export interface AgenticExecutionState {
  readonly executionId: string
  readonly goal: string
  phase: AgenticPhase
  readonly steps: StepState[]
  readonly phaseLog: PhaseTransition[]
  readonly permissionEvents: Array<{
    toolId: string
    decision: string
    at: number
  }>
  readonly recoveryAttempts: number
  readonly maxRecoveries: number
  startedAt: number
  completedAt?: number
  finalResult?: {
    status: 'completed' | 'partial' | 'failed' | 'cancelled'
    summary: string
    verifiedSteps: number
    failedSteps: number
    totalSteps: number
  }
}

const TERMINAL_PHASES: ReadonlySet<AgenticPhase> = new Set([
  'completed',
  'failed',
  'cancelled',
])

export function isTerminalPhase(phase: AgenticPhase): boolean {
  return TERMINAL_PHASES.has(phase)
}

const VALID_TRANSITIONS: ReadonlyMap<AgenticPhase, ReadonlySet<AgenticPhase>> = new Map([
  ['thinking', new Set(['planning', 'failed', 'cancelled'])],
  ['planning', new Set(['executing', 'completed', 'failed', 'cancelled'])],
  ['executing', new Set(['observing', 'verifying', 'failed', 'cancelled'])],
  ['observing', new Set(['verifying', 'replanning', 'completed', 'failed', 'cancelled'])],
  ['verifying', new Set(['completed', 'recovering', 'replanning', 'failed', 'cancelled'])],
  ['recovering', new Set(['replanning', 'executing', 'failed', 'cancelled'])],
  ['replanning', new Set(['executing', 'completed', 'failed', 'cancelled'])],
])

export function canTransitionPhase(from: AgenticPhase, to: AgenticPhase): boolean {
  if (isTerminalPhase(from)) return false
  if (from === to) return true
  return VALID_TRANSITIONS.get(from)?.has(to) ?? false
}

let executionCounter = 0

export function createExecutionState(
  goal: string,
  maxRecoveries: number = 2,
): AgenticExecutionState {
  const id = `exec-${Date.now().toString(36)}-${++executionCounter}`
  return {
    executionId: id,
    goal,
    phase: 'thinking',
    steps: [],
    phaseLog: [{ phase: 'thinking', at: Date.now() }],
    permissionEvents: [],
    recoveryAttempts: 0,
    maxRecoveries,
    startedAt: Date.now(),
  }
}

export function transitionPhase(
  state: AgenticExecutionState,
  phase: AgenticPhase,
  detail?: string,
): boolean {
  if (!canTransitionPhase(state.phase, phase)) return false
  state.phase = phase
  state.phaseLog.push({ phase, at: Date.now(), detail })
  if (isTerminalPhase(phase)) {
    state.completedAt = Date.now()
  }
  return true
}

export function addStep(
  state: AgenticExecutionState,
  opts: {
    toolId: string
    capability?: string
    description: string
    input: Record<string, unknown>
  },
): StepState {
  const step: StepState = {
    stepIndex: state.steps.length,
    toolId: opts.toolId,
    capability: opts.capability,
    description: opts.description,
    input: opts.input,
    state: 'planned',
  }
  state.steps.push(step)
  return step
}

export function updateStepState(
  step: StepState,
  newState: StepExecutionState,
): void {
  step.state = newState
  if (newState === 'executing' || newState === 'observing' || newState === 'verifying') {
    step.startedAt = step.startedAt ?? Date.now()
  }
  if (
    newState === 'verified' ||
    newState === 'failed' ||
    newState === 'verification_failed' ||
    newState === 'skipped' ||
    newState === 'cancelled'
  ) {
    step.completedAt = Date.now()
  }
}

export function buildFinalResult(state: AgenticExecutionState): void {
  const verified = state.steps.filter((s) => s.state === 'verified').length
  const failed = state.steps.filter(
    (s) => s.state === 'failed' || s.state === 'verification_failed',
  ).length
  const executed = state.steps.filter(
    (s) =>
      s.state === 'verified' ||
      s.state === 'observed' ||
      s.state === 'executed' ||
      s.state === 'verification_failed' ||
      s.state === 'failed',
  ).length
  const total = state.steps.length

  let status: 'completed' | 'partial' | 'failed' | 'cancelled'
  let summary: string

  if (state.phase === 'cancelled') {
    status = 'cancelled'
    summary = `Execution cancelled after ${executed}/${total} steps.`
  } else if (state.phase === 'failed') {
    status = 'failed'
    summary =
      failed > 0
        ? `${failed}/${total} steps failed.`
        : `Execution did not complete (${total} steps).`
  } else if (failed > 0) {
    status = verified > 0 ? 'partial' : 'failed'
    summary = `${verified}/${total} steps verified, ${failed} failed.`
  } else if (executed === total) {
    status = 'completed'
    summary = `All ${total} steps executed${verified === total ? ' and verified' : ''}.`
  } else {
    status = 'partial'
    summary = `${executed}/${total} steps executed before the plan ended.`
  }

  state.finalResult = {
    status,
    summary,
    verifiedSteps: verified,
    failedSteps: failed,
    totalSteps: total,
  }
}
