import type { ToolPermission } from '../../tools/Tool'

/**
 * Phase 2.6 — deterministic execution policy (§10).
 *
 * SAFE / CONFIRMATION_REQUIRED / BLOCKED. This is an engine-side POLICY PLAN
 * surfaced for routing and honest reporting; it NEVER replaces the existing
 * enforcement (`decidePermission` + confirmation gates + argument validation
 * remain the real authority, unchanged).
 */

export type ExecutionPolicy = 'safe' | 'confirmation_required' | 'blocked'

/** Map the tool permission tier onto the §10 tri-state policy. */
export function determineExecutionPolicy(permission: ToolPermission): ExecutionPolicy {
  switch (permission) {
    case 'read_only':
    case 'low_risk':
      return 'safe'
    case 'user_confirmation':
    case 'high_risk':
      return 'confirmation_required'
    default:
      return 'confirmation_required'
  }
}

export interface RequestPolicyEvaluation {
  policy: ExecutionPolicy
  /** Human reason when the policy is not `safe` (bounded, user-safe). */
  reason?: string
}

/**
 * Whole-request policy evaluation. `capabilityConnected` reflects whether the
 * mechanism behind the request is actually attached in this environment; when
 * it is known to be absent, the request is BLOCKED rather than silently
 * pretending an implementation exists.
 */
export function evaluateRequestPolicy(opts: {
  permission?: ToolPermission
  capabilityConnected: boolean
  domain?: string
}): RequestPolicyEvaluation {
  if (!opts.capabilityConnected) {
    return {
      policy: 'blocked',
      reason: opts.domain
        ? `The capability for ${opts.domain} is not connected in this environment.`
        : 'The capability needed for that is not connected in this environment.',
    }
  }
  if (!opts.permission) {
    return { policy: 'blocked', reason: 'No registered mechanism is available for that request.' }
  }
  const policy = determineExecutionPolicy(opts.permission)
  return {
    policy,
    reason: policy === 'confirmation_required' ? 'This action needs your confirmation before it runs.' : undefined,
  }
}