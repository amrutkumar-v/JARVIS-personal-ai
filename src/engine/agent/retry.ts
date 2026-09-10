import type { ToolRetryPolicy } from '../../tools/Tool'
import type { AgentErrorKind } from './types'

/**
 * Controlled retry policy.
 *
 * Retries happen ONLY when:
 * - the tool explicitly declares a retry policy, AND
 * - the failure is transient (tool failure / timeout), AND
 * - we have not exhausted `maxRetries`.
 *
 * Never retried: invalid input, permission denials, user cancellations,
 * provider failures, orchestration limits, or anything destructive/high-risk.
 */

/** Kind flags the policy is willing to retry. Transient machinery failures. */
const RETRYABLE_KINDS: ReadonlySet<AgentErrorKind> = new Set<AgentErrorKind>([
  'tool_failure',
  'timeout',
])

export interface RetryDecision {
  shouldRetry: boolean
  /** Number of attempts already performed (0 = first execution). */
  attempt: number
  /** Milliseconds to wait before the next attempt. */
  backoffMs: number
  reason: string
}

export function shouldRetry(kind: AgentErrorKind | undefined, attempt: number, policy?: ToolRetryPolicy): RetryDecision {
  if (!policy || !policy.retryable) {
    return { shouldRetry: false, attempt, backoffMs: 0, reason: 'tool does not allow retries' }
  }
  if (attempt >= policy.maxRetries) {
    return { shouldRetry: false, attempt, backoffMs: 0, reason: 'retry budget exhausted' }
  }
  if (!kind || !RETRYABLE_KINDS.has(kind)) {
    return { shouldRetry: false, attempt, backoffMs: 0, reason: 'failure is not retryable' }
  }
  const backoffMs = policy.backoffMs ?? 80
  return { shouldRetry: true, attempt, backoffMs: backoffMs * (attempt + 1), reason: 'transient failure' }
}

/** A failure that reached its retry budget becomes a plain reported failure. */
export function exhaustedReason(kind: AgentErrorKind | undefined): string {
  return kind === 'timeout' ? 'The tool timed out on every attempt.' : 'The tool kept failing, so I stopped retrying.'
}