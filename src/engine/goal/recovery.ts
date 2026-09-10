import type { AgentErrorKind, ObservationKind, RecoveryAction, RecoveryFailureKind } from '../agent/types'
import type { PlanVerdictCode } from './validatePlan'

/**
 * Phase 2.2 — deterministic failure classification & recovery policy.
 *
 * A failed step is reduced to ONE `RecoveryFailureKind`, then mapped to a
 * bounded `RecoveryAction`. The mapping is pure and total over known inputs;
 * it never rewrites budgets, history or the plan — the engine applies the
 * resulting action and accounts for any budget it consumes.
 *
 * Budget rules (enforced by the engine, documented here):
 *  - 'retry'          never consumes a budget unit (declared retry policy).
 *  - 'reobserve'      consumes a recovery unit — re-observation is a
 *                     verification attempt and is bounded the same way.
 *  - 'replan'         consumes a replan unit (bounded by maxReplans).
 *  - 'stop'           consumes nothing; it fires the run's stopping rails.
 */

export interface RecoveryDecision {
  kind: RecoveryFailureKind
  action: RecoveryAction
  reason: string
  consumesBudget: boolean
}

export interface RecoveryInput {
  errorKind?: AgentErrorKind
  observationKind?: ObservationKind
  retryable?: boolean
  canReobserve?: boolean
  budgetExhausted?: boolean
  cancelled?: boolean
  /** Code of the plan-validation failure, when `errorKind` is plan_rejected. */
  planCode?: PlanVerdictCode
}

export function classifyRecovery(input: RecoveryInput): RecoveryDecision {
  const {
    errorKind,
    observationKind,
    retryable = false,
    canReobserve = false,
    budgetExhausted = false,
    cancelled = false,
    planCode,
  } = input

  // Verification signals dominate: the tool ran, but the effect is unknown.
  // These must never be classified as a plain hardware failure.
  if (observationKind === 'verification' || observationKind === 'partial') {
    if (canReobserve) {
      return {
        kind: 'stale_observation',
        action: 'reobserve',
        reason: 'the effect may exist behind a stale or unreflected view — re-observe before deciding',
        consumesBudget: true,
      }
    }
    return {
      kind: 'verification_failure',
      action: 'replan',
      reason: 'the effect was not confirmed — plan a different, corrected continuation',
      consumesBudget: true,
    }
  }

  if (cancelled) {
    return { kind: 'cancellation', action: 'stop', reason: 'task cancelled', consumesBudget: false }
  }
  if (budgetExhausted) {
    return {
      kind: 'budget_exhausted',
      action: 'stop',
      reason: 'no goal task budget left for further steps',
      consumesBudget: false,
    }
  }

  switch (errorKind) {
    case 'permission_denied':
      return {
        kind: 'permission_denied',
        action: 'stop',
        reason: 'permission was denied — the step is never retried',
        consumesBudget: false,
      }
    case 'user_cancelled':
      return { kind: 'cancellation', action: 'stop', reason: 'the user declined the action', consumesBudget: false }
    case 'plan_rejected':
      // A budget-busting plan is a hard, non-recoverable stop; every other
      // plan rejection is a bounded plan_correction request.
      if (planCode === 'budget') {
        return {
          kind: 'budget_exhausted',
          action: 'stop',
          reason: 'the model proposed a step beyond the goal budget',
          consumesBudget: false,
        }
      }
      if (planCode === 'unavailable') {
        return {
          kind: 'unsupported_capability',
          action: 'replan',
          reason: 'the requested capability is not available here — request a different, corrected continuation',
          consumesBudget: true,
        }
      }
      // Phase 2.3 — a plan that named a capability that is NOT registered, or a
      // registered capability with no selectable implementation, is the same
      // honest unsupported-capability stop: a bounded replan request.
      if (planCode === 'capability_unregistered' || planCode === 'capability_unavailable') {
        return {
          kind: 'unsupported_capability',
          action: 'replan',
          reason: 'the requested capability is not registered or unimplementable here — request a different, corrected continuation',
          consumesBudget: true,
        }
      }
      return {
        kind: 'invalid_input',
        action: 'replan',
        reason: 'the plan step was rejected — request a corrected continuation',
        consumesBudget: true,
      }
    case 'orchestration_limit':
      return {
        kind: 'budget_exhausted',
        action: 'stop',
        reason: 'a safety rail stopped the step',
        consumesBudget: false,
      }
    case 'invalid_input':
      return {
        kind: 'invalid_input',
        action: 'replan',
        reason: 'the arguments were invalid — request a corrected continuation',
        consumesBudget: true,
      }
    case 'provider_failure':
      return retryable
        ? {
            kind: 'transient',
            action: 'retry',
            reason: 'a provider failure may be transient — retry per declared policy',
            consumesBudget: false,
          }
        : {
            kind: 'transient',
            action: 'replan',
            reason: 'a provider failure is not retryable here — request a different continuation',
            consumesBudget: true,
          }
    case 'timeout':
      return retryable
        ? {
            kind: 'transient',
            action: 'retry',
            reason: 'a timeout may be transient — retry per declared policy',
            consumesBudget: false,
          }
        : {
            kind: 'transient',
            action: 'replan',
            reason: 'a timeout is not retryable here — request a different continuation',
            consumesBudget: true,
          }
    case 'tool_failure':
      return retryable
        ? {
            kind: 'transient',
            action: 'retry',
            reason: 'a tool failure may be transient — retry per declared policy',
            consumesBudget: false,
          }
        : {
            kind: 'tool_unavailable',
            action: 'replan',
            reason: 'the tool failed without a retry policy — request a different continuation',
            consumesBudget: true,
          }
    default:
      return {
        kind: 'fatal',
        action: 'stop',
        reason: 'an unknown failure occurred — the goal stops',
        consumesBudget: false,
      }
  }
}

/** True when the engine must account for a decision against a budget. */
export function consumesBudget(action: RecoveryAction): boolean {
  return action === 'reobserve' || action === 'replan'
}