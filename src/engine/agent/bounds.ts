import { AGENT_LIMITS } from '../limits'

/**
 * Loop bounds & repeated-action guard (Phase 1.0).
 *
 * Pure, testable evalulators behind the agent's safety rails:
 *
 *  - `evaluateLoopState` decides, before each provider round, whether the run
 *    may continue or must stop (cancelled / orchestration limit). The engine
 *    never loops without this check — no uncontrolled tool loops.
 *  - `stableKey` / `isRepeatedActionBlocked` stop the model from repeating the
 *    exact same (tool, payload) action more than `maxRepeats` times per run.
 */

export type LoopVerdict = 'continue' | 'cancelled' | 'limit'

export interface LoopState {
  /** Zero-based count of completed reasoning rounds. */
  round: number
  /** Tool steps recorded so far in the plan. */
  totalSteps: number
  /** Wall-clock deadline (ms epoch) for the whole task. */
  deadline: number
  now: number
  cancelled: boolean
  maxRounds?: number
  maxSteps?: number
}

/** Bounded-loop decision for the next iteration of the agent loop. */
export function evaluateLoopState(state: LoopState): LoopVerdict {
  const maxRounds = state.maxRounds ?? AGENT_LIMITS.MAX_TOOL_ROUNDS
  const maxSteps = state.maxSteps ?? AGENT_LIMITS.MAX_AGENT_STEPS

  if (state.cancelled) return 'cancelled'
  if (state.now > state.deadline) return 'limit'
  if (state.totalSteps >= maxSteps) return 'limit'
  if (state.round >= maxRounds) return 'limit'
  return 'continue'
}

/** Stable, order-insensitive fingerprint of a payload for dup detection. */
export function stableKey(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(sortValue(payload ?? {}))
  } catch {
    return '<unserializable>'
  }
}

/**
 * True when executing `(toolId, payload)` again would exceed `maxRepeats`
 * identical executed requests in this run. `maxRepeats <= 0` disables the
 * guard.
 */
export function isRepeatedActionBlocked(
  prior: Array<{ toolId: string; input?: Record<string, unknown> }>,
  toolId: string,
  payload: Record<string, unknown>,
  maxRepeats?: number,
): boolean {
  const cap = maxRepeats ?? AGENT_LIMITS.MAX_REPEATED_ACTIONS
  if (cap <= 0) return false
  const key = stableKey(payload)
  let seen = 0
  for (const entry of prior) {
    if (entry.toolId === toolId && stableKey(entry.input ?? {}) === key) {
      seen += 1
      if (seen >= cap) return true
    }
  }
  return false
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key])
    }
    return sorted
  }
  return value
}