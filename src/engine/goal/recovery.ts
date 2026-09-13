import type { AgentErrorKind, ObservationKind, RecoveryAction, RecoveryFailureKind } from '../agent/types'
import type { DeviceErrorKind } from '../../backend/types'
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
  /** Structured device-error code (Work 11.9), when a device tool failed. */
  deviceCode?: DeviceErrorKind
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
    deviceCode,
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

  // Work 11.9 — structured device failures map to bounded, honest recovery.
  // Device recovery is NEVER a silent retry loop: only a declared-retryable
  // timeout/transfer may retry; offline/not-found always replans (refresh the
  // registry / choose an online device); untrusted and permission-required
  // always stop until the user explicitly re-authorizes.
  if (deviceCode) {
    switch (deviceCode) {
      case 'device_untrusted':
        return {
          kind: 'device_untrusted',
          action: 'stop',
          reason: 'the target device is not a trusted ecosystem device — stop and refuse until trust is explicitly granted',
          consumesBudget: false,
        }
      case 'device_permission_required':
        return {
          kind: 'device_permission_required',
          action: 'stop',
          reason: 'the device needs explicit permission — require the user\u2019s approval; never auto-expose it',
          consumesBudget: false,
        }
      case 'device_not_found':
        return {
          kind: 'device_not_found',
          action: 'replan',
          reason: 'no device matches that target — refresh the registry and re-ask which device, never guess',
          consumesBudget: true,
        }
      case 'device_disconnected':
        return {
          kind: 'device_disconnected',
          action: 'replan',
          reason: 'the device is offline right now — refresh its state and choose an online trusted device instead',
          consumesBudget: true,
        }
      case 'device_timeout':
        return retryable
          ? {
              kind: 'transient',
              action: 'retry',
              reason: 'the device timed out and the tool declares a retry policy — retry once per policy',
              consumesBudget: false,
            }
          : {
              kind: 'device_unavailable',
              action: 'replan',
              reason: 'the device timed out without a retry policy — refresh and plan a corrected continuation',
              consumesBudget: true,
            }
      case 'transfer_failed':
        return retryable
          ? {
              kind: 'transient',
              action: 'retry',
              reason: 'the transfer failed and the tool declares a retry policy — retry once per policy',
              consumesBudget: false,
            }
          : {
              kind: 'device_unavailable',
              action: 'replan',
              reason: 'the transfer could not complete — plan a corrected continuation',
              consumesBudget: true,
            }
      case 'verification_unavailable':
        return canReobserve
          ? {
              kind: 'stale_observation',
              action: 'reobserve',
              reason: 'the effect may exist but device verification is unavailable — re-observe before deciding',
              consumesBudget: true,
            }
          : {
              kind: 'verification_failure',
              action: 'replan',
              reason: 'the device effect could not be confirmed — plan a different, corrected continuation',
              consumesBudget: true,
            }
      case 'device_unavailable':
      case 'device_protocol_error':
      default:
        return {
          kind: 'device_unavailable',
          action: 'replan',
          reason: 'the device operation could not be completed — refresh and plan a corrected continuation',
          consumesBudget: true,
        }
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