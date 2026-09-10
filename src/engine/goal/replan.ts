import { stableKey } from '../agent/bounds'
import type { PlanStepRequest } from './validatePlan'

/**
 * Phase 2.2 — replan guards.
 *
 * Replanning is a BOUNDED, deterministic operation: the engine may ask the
 * model for a corrected continuation a finite number of times, and every
 * replan inherits the same trace, evidence and budget counters (nothing is
 * ever reset). Two pure guards prevent infinite loops:
 *
 *  - `identicalReplan` — the failed round's plan signature may not be
 *    proposed again verbatim; repeating it aborts the goal.
 *  - `repeatedFailureDetected` — the same (tool, payload) signature failing
 *    consecutively beyond a small bound signals a genuine loop and aborts.
 *
 * Signatures are hashes of (toolId + stable payload), never raw prompts.
 */

export const REPLAN_LIMITS = {
  /**
   * Consecutive rounds whose plan signature exactly repeats the previous
   * failed round's signature before we abort the goal.
   */
  MAX_IDENTICAL_REPLANS: 1,
  /**
   * Consecutive recorded failures of the SAME (tool, payload) signature
   * before we declare a loop and abort the goal.
   */
  MAX_IDENTICAL_FAILURES: 2,
} as const

/** Deterministic signature of one request. */
export function requestSignature(toolId: string, payload: Record<string, unknown>): string {
  return `${toolId}:${stableKey(payload)}`
}

/** Deterministic signature of a round's plan (stringified step order). */
export function planSignature(steps: PlanStepRequest[]): string {
  return steps
    .map((s) => requestSignature(s.toolId, s.payload ?? {}))
    .join('|')
}

/** True when `signature` was already proposed/failed earlier this run. */
export function identicalReplan(priorSignatures: readonly string[], signature: string): boolean {
  return priorSignatures.includes(signature)
}

/**
 * True when the same signature has failed `bound` times in a row (including
 * the incoming failure). Pure over the recorded history; the engine pushes
 * every failed step's signature then checks BEFORE any replan is issued.
 */
export function repeatedFailureDetected(
  history: readonly string[],
  signature: string,
  bound: number = REPLAN_LIMITS.MAX_IDENTICAL_FAILURES,
): boolean {
  let run = 0
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i] === signature) run += 1
    else break
  }
  return run >= bound
}