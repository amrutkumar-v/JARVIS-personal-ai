import type { Tool, ToolContext, ToolInput, ToolResult, ToolVerification } from '../../tools/Tool'
import type { ToolExecutionResult } from './runTool'
import type { AgentVerification, VerificationStatus } from './types'

/**
 * Verification system (Phase 1.0) — the "never claim it worked unless you can
 * confirm it" rail.
 *
 * A tool MAY declare `verifiable: true` and provide a `verify(input, result,
 * ctx)` method that produces its own confirmation signal (a future file tool
 * re-checks that the file exists under the new name after a rename; a future
 * messaging tool waits for the delivery/echo confirmation). The engine runs
 * the verifier on every execution of a verifiable tool and records the outcome
 * on the observation, plan step and trace — and feeds a `[verified]` /
 * `[unverified]` / `[verification failed]` note back to the reasoning loop so
 * the model cannot honestly report a confirmed action when none was confirmed.
 *
 * The verifier never crashes the loop: any throw or malformed answer degrades
 * to `unverified` (the action is not claimed as confirmed).
 */

/**
 * False only when a verifiable tool executes and its verifier REFUTES it.
 * An `unverified` outcome means "executed but not confirmed" — the action
 * still ran, so it is not a hard failure; the `[unverified]` suffix on the
 * provider message carries the honesty signal.
 */
export function verificationPassed(verification: AgentVerification | undefined): boolean {
  if (!verification) return true
  return verification.status !== 'failed'
}

/**
 * Run the tool's optional verifier and fold the outcome into a structured
 * `AgentVerification`. Never throws.
 */
export async function runToolVerification(
  tool: Tool,
  input: ToolInput,
  result: ToolExecutionResult,
  ctx: ToolContext,
): Promise<AgentVerification> {
  const startedAt = Date.now()

  if (!tool.verifiable || typeof tool.verify !== 'function') {
    return { status: 'not_applicable', message: 'Tool does not declare a verifier.', durationMs: 0 }
  }

  const toolResult: ToolResult = {
    ok: result.success,
    message: result.summary,
    data: result.output,
  }

  try {
    const check = await tool.verify(input, toolResult, ctx)
    if (!check || typeof check.ok !== 'boolean') {
      throw new Error('verifier returned an invalid result')
    }
    const status: VerificationStatus = check.status ?? (check.ok ? 'verified' : 'failed')
    if (
      !['verified', 'failed', 'unverified'].includes(status) ||
      check.ok !== (status === 'verified')
    ) {
      throw new Error('verifier returned an inconsistent status')
    }
    const checks = Array.isArray(check.checks) ? check.checks.map(String) : undefined
    return {
      status,
      message: status === 'verified'
        ? check.message || 'Verification succeeded.'
        : check.message || (status === 'unverified' ? 'Verification could not confirm the result.' : 'Verification failed.'),
      checks,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    console.warn(`[agent] verifier for "${tool.id}" failed, treating as unverified:`, error)
    return {
      status: 'unverified',
      message: 'The verifier could not confirm the result.',
      durationMs: Date.now() - startedAt,
    }
  }
}

/**
 * Compact, provider-safe tail appended to tool result messages so the model
 * reasons over the verification state without exposing internals.
 */
export function verificationSuffix(verification: AgentVerification | undefined): string {
  if (!verification) return ''
  switch (verification.status) {
    case 'verified':
      return '[verified]'
    case 'failed':
      return `[verification failed: ${verification.message}]`
    case 'unverified':
      return '[unverified]'
    default:
      return ''
  }
}

/** Re-export the tool contract's verification type for downstream users. */
export type { ToolVerification }
