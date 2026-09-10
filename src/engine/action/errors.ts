import type { AgentErrorKind } from '../agent/types'
import type { ExecutionErrorKind, ExecutionErrorEntry } from './types'

/**
 * Phase 2.6 — structured execution errors (§18). Maps the execution errors the
 * pipeline already records onto a stable vocabulary and produces user-safe
 * phrasing. NEVER renders raw exceptions or stack traces to the user.
 */

export const EXECUTION_ERROR_PHRASES: Record<ExecutionErrorKind, string> = {
  invalid_input: 'The request had invalid or missing parameters.',
  tool_unavailable: 'The tool needed for that is not registered in this environment.',
  permission_denied: 'That action was not permitted.',
  target_not_found: 'The file or folder you meant could not be found.',
  execution_failure: 'The action failed while it was being executed.',
  timeout: 'The action did not finish in time.',
  verification_failure: 'The action ran, but its expected effect could not be confirmed.',
  cancelled: 'The action was cancelled before it completed.',
  unsupported: 'That capability is not connected in this environment.',
}

/** User-safe, provider-safe phrase for one execution error kind. */
export function executionErrorPhrase(kind: ExecutionErrorKind): string {
  return EXECUTION_ERROR_PHRASES[kind]
}

/** Map the engine/agent error vocabulary onto the §18 execution kinds. */
export function executionKindFromAgent(kind?: AgentErrorKind): ExecutionErrorKind | undefined {
  if (!kind) return undefined
  switch (kind) {
    case 'invalid_input':
      return 'invalid_input'
    case 'permission_denied':
      return 'permission_denied'
    case 'user_cancelled':
      return 'cancelled'
    case 'tool_failure':
      return 'execution_failure'
    case 'timeout':
      return 'timeout'
    case 'provider_failure':
    case 'orchestration_limit':
    case 'plan_rejected':
      return 'execution_failure'
    default:
      return 'execution_failure'
  }
}

/** Build a bounded, safe error entry (never a raw exception). */
export function makeExecutionError(partial: {
  kind: ExecutionErrorKind
  toolId?: string
  message?: string
  at?: number
}): ExecutionErrorEntry {
  return {
    kind: partial.kind,
    toolId: partial.toolId,
    message: partial.message?.slice(0, 240) ?? executionErrorPhrase(partial.kind),
    at: partial.at ?? Date.now(),
  }
}