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
  /** Phase 6 — queued behind an unmet dependency or precondition. */
  | 'pending'
  /** Phase 6 — all gates passed; ready to execute. */
  | 'ready'
  /** Phase 6 — blocked by a failed/skipped dependency. Never runs. */
  | 'blocked'
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
  /** Phase 6 — bounded replanning counter and ceiling. Replans are NEVER a
   * budget reset; every executed step and recovery still counts. */
  replanAttempts: number
  maxReplans: number
  /** Phase 6 — optional wall-clock goal deadline (ms from start). */
  deadlineMs?: number
  startedAt: number
  completedAt?: number
  finalResult?: {
    status: 'completed' | 'partial' | 'failed' | 'cancelled'
    summary: string
    verifiedSteps: number
    failedSteps: number
    totalSteps: number
    skippedSteps?: number
    blockedSteps?: number
    replannedSteps?: number
    cancelledSteps?: number
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

const VALID_TRANSITIONS = new Map<AgenticPhase, ReadonlySet<AgenticPhase>>([
  ['thinking', new Set<AgenticPhase>(['planning', 'failed', 'cancelled'])],
  ['planning', new Set<AgenticPhase>(['executing', 'completed', 'failed', 'cancelled'])],
  ['executing', new Set<AgenticPhase>(['observing', 'verifying', 'completed', 'failed', 'cancelled'])],
  ['observing', new Set<AgenticPhase>(['verifying', 'replanning', 'completed', 'failed', 'cancelled'])],
  ['verifying', new Set<AgenticPhase>(['completed', 'recovering', 'replanning', 'failed', 'cancelled'])],
  ['recovering', new Set<AgenticPhase>(['replanning', 'executing', 'failed', 'cancelled'])],
  ['replanning', new Set<AgenticPhase>(['executing', 'completed', 'failed', 'cancelled'])],
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
  opts: { maxReplans?: number; deadlineMs?: number } = {},
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
    replanAttempts: 0,
    maxReplans: opts.maxReplans ?? 3,
    deadlineMs: opts.deadlineMs,
    startedAt: Date.now(),
  }
}

/** Phase 6 — wall-clock deadline check against the run start time. */
export function deadlineReached(state: Pick<AgenticExecutionState, 'startedAt' | 'deadlineMs'>, now = Date.now()): boolean {
  if (!state.deadlineMs || state.deadlineMs <= 0) return false
  return now - state.startedAt >= state.deadlineMs
}

/** Phase 6 — elapsed execution time (ms) from the run start. */
export function elapsedMs(state: Pick<AgenticExecutionState, 'startedAt'>, now = Date.now()): number {
  return Math.max(0, now - state.startedAt)
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
    newState === 'blocked' ||
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
  const skipped = state.steps.filter((s) => s.state === 'skipped').length
  const blocked = state.steps.filter((s) => s.state === 'blocked').length
  const cancelled = state.steps.filter((s) => s.state === 'cancelled').length
  const replanned = state.steps.filter((s) => s.state === 'replanned').length
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
  } else if (blocked > 0) {
    status = verified > 0 ? 'partial' : 'failed'
    summary = `${verified}/${total} steps verified, ${blocked} blocked by failed dependencies.`
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
    skippedSteps: skipped,
    blockedSteps: blocked,
    replannedSteps: replanned,
    cancelledSteps: cancelled,
  }
}
