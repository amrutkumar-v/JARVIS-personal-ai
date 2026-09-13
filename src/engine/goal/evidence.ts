import type { AgentStep, AgentTrace, TraceStep } from '../agent/types'
import type { GoalEvidenceOutcome, GoalStepStatus, GoalTaskResult, GoalTaskStatus } from './types'
import { GOAL_LIMITS, recoveryBudgetExceeded } from './budget'

/**
 * Evidence-based goal verdict (Phase 2.0).
 *
 * Turns the deterministic per-run trace into an honest goal verdict. The
 * engine reports this through `lastRunTrace().task` and `taskResult()`, so
 * "the goal was achieved" is NEVER inferred from the model claiming success —
 * only from the recorded observation/verification outcomes.
 *
 * Actionable = performed an injective (hands) action on the desktop/app. A
 * run that only answered questions or inspected is read-only: its answer IS
 * the deliverable (existing Q&A semantics are preserved).
 */

/** Injective (hands) tool ids. Eyes (window.*, desktop.screenshot,
 *  desktop.visualInspect) and read-only tools are deliberately excluded. */
export const ACTIONABLE_TOOL_IDS: ReadonlySet<string> = new Set([
  'desktop.click',
  'desktop.double_click',
  'desktop.right_click',
  'desktop.scroll',
  'desktop.key_press',
  'desktop.hotkey',
  'desktop.type',
  'desktop.move',
  'desktop.visualClick',
  'desktop.visualType',
  'app.launch',
])

export function isActionableToolId(toolId: string): boolean {
  return ACTIONABLE_TOOL_IDS.has(toolId)
}

/** Deterministic per-step goal status derived from the recorded evidence. */
export function classifyTaskStep(step: TraceStep): GoalStepStatus {
  switch (step.status) {
    case 'CANCELLED':
      return 'cancelled'
    case 'SKIPPED':
      return 'blocked'
    case 'FAILED': {
      const obs = step.observation
      const kind = obs?.errorKind
      // The verifier REFUTED the claimed effect (a contradiction, not a
      // tool error) — the step executed but the goal moved backwards.
      if (obs?.kind === 'verification') return 'refuted'
      // Refused by a safety rail (plan rejection / any budget / guard).
      if (kind === 'plan_rejected' || kind === 'orchestration_limit') return 'blocked'
      if (kind === 'user_cancelled') return 'cancelled'
      return 'failed'
    }
    case 'COMPLETED': {
      const v = step.verification
      if (v?.status === 'verified') return 'verified'
      if (v?.status === 'failed') return 'refuted'
      return 'unverified'
    }
    default:
      // PENDING / RUNNING never appear on a finished trace; stay honest.
      return 'planned'
  }
}

/**
 * Bounded recovery counter: how many steps were refuted or left unverified.
 * The engine stops the run once this crosses `maxRecoveryAttempts`.
 */
export function countRecoveries(steps: TraceStep[]): number {
  return steps.filter(
    (s) => s.observation?.kind === 'verification' || s.observation?.kind === 'partial',
  ).length
}

const VERDICT_MESSAGES: Record<GoalTaskStatus, string> = {
  planning: 'The goal is still being planned.',
  executing: 'The goal is still being executed.',
  recovering: 'A step failed verification; recovery is in progress.',
  completed: 'The goal was achieved and the result was confirmed.',
  partial: 'Some requested steps were completed and verified, but the goal was NOT fully achieved.',
  failed: 'The goal was not achieved.',
  unverified: 'Step results could not be confirmed, so the goal is NOT declared complete.',
  blocked: 'A safety rail stopped the goal before it could be completed.',
  cancelled: 'The goal was cancelled.',
}

/**
 * Per-step goal status for the PLAN TRACKER view (Phase 2.1 UI). Mirrors
 * `classifyTaskStep` semantics but reads the mutable plan step, so PENDING /
 * RUNNING steps are representable too. The GOAL VERDICT always comes from
 * `evaluateGoalTask` (the trace); this only labels one requested step.
 */
export function classifyPlanStep(step: AgentStep): GoalStepStatus {
  if (step.observation?.kind === 'verification') return 'refuted'
  switch (step.status) {
    case 'PENDING':
      return 'planned'
    case 'RUNNING':
    case 'WAITING_CONFIRMATION':
      return 'executing'
    case 'CANCELLED':
      return 'cancelled'
    case 'SKIPPED':
      return 'blocked'
    case 'COMPLETED': {
      const v = step.verification
      if (v?.status === 'verified') return 'verified'
      if (v?.status === 'failed') return 'refuted'
      return 'unverified'
    }
    case 'FAILED': {
      const kind = step.result?.errorKind
      // Refused by a safety rail (plan rejection / any budget / guard).
      if (kind === 'plan_rejected' || kind === 'orchestration_limit') return 'blocked'
      if (kind === 'user_cancelled') return 'cancelled'
      return 'failed'
    }
    default:
      return 'planned'
  }
}

function readOnlyResult(trace: AgentTrace): GoalTaskResult {
  return {
    status: 'completed',
    reason: VERDICT_MESSAGES.completed,
    evidence: { kind: 'read_only_answer' },
    actionable: false,
    executedSteps: trace.steps.length,
    verifiedSteps: 0,
    refutedSteps: 0,
    unverifiedSteps: 0,
    rejectedSteps: countRejected(trace),
    recoveries: 0,
  }
}

function countRejected(trace: AgentTrace): number {
  return trace.steps.filter(
    (s) => s.observation?.errorKind === 'plan_rejected' || s.observation?.errorKind === 'invalid_input',
  ).length
}

function counts(trace: AgentTrace, actionableSteps: TraceStep[]) {
  return {
    executedSteps: trace.steps.length,
    verifiedSteps: trace.steps.filter((s) => classifyTaskStep(s) === 'verified').length,
    refutedSteps: trace.steps.filter((s) => classifyTaskStep(s) === 'refuted').length,
    unverifiedSteps: trace.steps.filter((s) => classifyTaskStep(s) === 'unverified').length,
    rejectedSteps: countRejected(trace),
    recoveries: countRecoveries(trace.steps),
    actionableSteps,
  }
}

/** The honest, evidence-based verdict for one finished goal run. */
export function evaluateGoalTask(
  trace: AgentTrace,
  limits?: { maxRecoveryAttempts?: number; defaultMaxRecoveryAttempts?: number },
): GoalTaskResult {
  const actionableSteps = trace.steps.filter((s) => isActionableToolId(s.toolId))
  const c = counts(trace, actionableSteps)
  const hasActionable = c.actionableSteps.length > 0
  const evidence: GoalEvidenceOutcome = hasActionable ? { kind: 'action_verified' } : { kind: 'read_only_answer' }

  if (!trace.finalState || trace.finalState === 'planning') {
    return { status: 'planning', reason: VERDICT_MESSAGES.planning, evidence, actionable: hasActionable, ...omitSteps(c) }
  }

  if (trace.finalState === 'cancelled') {
    return cancelledResult(c)
  }

  if (trace.finalState === 'failed') {
    // A safety rail (plan rejection / any budget / recovery limit) stopped us.
    const limited = trace.steps.some(
      (s) => s.observation?.errorKind === 'plan_rejected' || s.observation?.errorKind === 'orchestration_limit',
    )
    const maxRecovery = limits?.maxRecoveryAttempts ?? GOAL_LIMITS.maxRecoveryAttempts
    const recoveryExhausted = recoveryBudgetExceeded(countRecoveries(trace.steps), maxRecovery)
    // Multi-step honesty: some steps verified + a later step failed → PARTIAL,
    // never plain failed, and NEVER complete. The counts carry the breakdown.
    if (c.verifiedSteps > 0) {
      const railStop = limited || recoveryExhausted
      return {
        status: 'partial',
        reason: railStop
          ? `${VERDICT_MESSAGES.partial} ${c.verifiedSteps} of ${c.executedSteps} executed step(s) were verified, and a safety rail stopped it before full completion.`
          : `${VERDICT_MESSAGES.partial} ${c.verifiedSteps} of ${c.executedSteps} executed step(s) were verified.`,
        evidence: { kind: 'none', reason: 'Some steps were verified, but the goal stopped before full completion.' },
        actionable: hasActionable,
        ...omitSteps(c),
      }
    }
    if (limited || recoveryExhausted) {
      return {
        status: 'blocked',
        reason: 'A safety rail stopped this goal before it could be completed (budget, plan rejection, or recovery limit).',
        evidence: { kind: 'none', reason: 'Execution stopped before verification.' },
        actionable: hasActionable,
        ...omitSteps(c),
      }
    }
    return {
      status: 'failed',
      reason: VERDICT_MESSAGES.failed,
      evidence: { kind: 'none', reason: 'Execution failed before the goal could be confirmed.' },
      actionable: hasActionable,
      ...omitSteps(c),
    }
  }

  // finalState === 'completed'
  if (!hasActionable) {
    // Nothing executed at all AND the only steps were safety-rail rejections →
    // the goal did NOT happen as "the answer is the text": it was refused.
    // Unknown/hallucinated capabilities never produce a completed read-only run.
    const refused = trace.steps.some(
      (s) => s.observation?.errorKind === 'plan_rejected' || s.observation?.errorKind === 'orchestration_limit',
    )
    const anythingExecuted = trace.steps.some((s) => s.status === 'COMPLETED')
    if (refused && !anythingExecuted) {
      return {
        status: 'blocked',
        reason: 'The requested action was refused before execution: it is not a registered capability or tool.',
        evidence: { kind: 'none', reason: 'Nothing executed — the plan was refused by a safety rail.' },
        actionable: false,
        ...omitSteps(c),
      }
    }
    return readOnlyResult(trace)
  }

  const last = actionableSteps[actionableSteps.length - 1]
  const classified = classifyTaskStep(last)
  // Earlier steps verified + the LAST step failed/refuted/blocked → partial.
  const partialFallback = (fallback: GoalTaskStatus, reason: string): GoalTaskResult =>
    c.verifiedSteps > 0
      ? {
          status: 'partial',
          reason:
            fallback === 'blocked'
              ? `${VERDICT_MESSAGES.partial} ${c.verifiedSteps} of ${c.executedSteps} executed step(s) were verified, and a safety rail stopped it before full completion.`
              : `${VERDICT_MESSAGES.partial} ${c.verifiedSteps} of ${c.executedSteps} executed step(s) were verified.`,
          evidence: { kind: 'none', reason },
          actionable: true,
          ...omitSteps(c),
        }
      : { status: fallback, reason, evidence: { kind: 'none', reason }, actionable: true, ...omitSteps(c) }

  switch (classified) {
    case 'verified':
      return {
        status: 'completed',
        reason: 'The final action was confirmed by its verifier, so the goal is verified.',
        evidence: { kind: 'action_verified' },
        actionable: true,
        ...omitSteps(c),
      }
    case 'refuted':
      return partialFallback(
        'failed',
        "The final action contradicted its expected effect, so the goal was NOT achieved.",
      )
    case 'blocked':
      return partialFallback(
        'blocked',
        'A safety rail stopped the final goal action before it could complete.',
      )
    case 'failed':
      return partialFallback(
        'failed',
        'The final goal action failed, so the goal was NOT achieved.',
      )
    case 'cancelled':
      return cancelledResult(c)
    default:
      return {
        status: 'unverified',
        reason: VERDICT_MESSAGES.unverified,
        evidence: { kind: 'none', reason: "The last action executed but its effect was never confirmed." },
        actionable: true,
        ...omitSteps(c),
      }
  }
}

function cancelledResult(c: ReturnType<typeof counts>): GoalTaskResult {
  return {
    status: 'cancelled',
    reason: VERDICT_MESSAGES.cancelled,
    evidence: { kind: 'none', reason: 'The run was stopped by cancellation.' },
    actionable: c.actionableSteps.length > 0,
    ...omitSteps(c),
  }
}

function omitSteps(c: ReturnType<typeof counts>) {
  return {
    executedSteps: c.executedSteps,
    verifiedSteps: c.verifiedSteps,
    refutedSteps: c.refutedSteps,
    unverifiedSteps: c.unverifiedSteps,
    rejectedSteps: c.rejectedSteps,
    recoveries: c.recoveries,
  }
}