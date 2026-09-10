import type { CapabilityReliability, CapabilityReliabilityIndex } from './types'
export type { CapabilityReliability, CapabilityReliabilityIndex }

/**
 * Phase 2.4 — bounded capability/tool reliability history (PURE).
 *
 * A minimal, application-owned success/failure ledger used ONLY as a weak
 * ranking signal when several implementations can satisfy the same capability.
 * Guarantees:
 *   - BOUNDED SIZE: entries are keyed by (capabilityId, toolId) — the key space
 *     is limited by the app-owned catalogue, never by free text.
 *   - BOUNDED COUNTERS: each counter clamps at a fixed ceiling (no unbounded
 *     growth of numbers).
 *   - CONTENT-FREE: stores only ids and derived counters — never user content,
 *     request bodies, secrets or conversation data.
 *   - DETERMINISTIC: updates and scores are pure functions of the current
 *     index and the recorded outcome.
 *
 * Reliability is a WEAK signal. It must NEVER override availability,
 * permission ceilings, risk ceilings, verification requirements, cancellation,
 * budgets or policy — the ranker places it strictly below those keys, and even
 * a previously successful tool can still be rejected by a stronger rule.
 */

/** Ceiling for every counter — numbers cannot grow without bound. */
export const MAX_RELIABILITY_COUNTER = 100_000

export type ReliabilityOutcome = 'success' | 'verified_success' | 'failure'

/** Stable map key for one (capability, tool) pair. Content-free by design. */
export function reliabilityKey(capabilityId: string, toolId: string): string {
  return `${capabilityId}::${toolId}`
}

function clampCounter(value: number): number {
  return value >= MAX_RELIABILITY_COUNTER ? MAX_RELIABILITY_COUNTER : value + 1
}

/**
 * Record one executed outcome, immutably: returns a NEW index with the
 * (capability, tool) entry updated. Counters clamp at MAX_RELIABILITY_COUNTER.
 */
export function recordReliability(
  index: CapabilityReliabilityIndex,
  capabilityId: string,
  toolId: string,
  outcome: ReliabilityOutcome,
): CapabilityReliabilityIndex {
  const key = reliabilityKey(capabilityId, toolId)
  const existing = index.get(key) ?? {
    capabilityId,
    toolId,
    verifiedSuccesses: 0,
    successes: 0,
    failures: 0,
  }
  const next: CapabilityReliability = {
    capabilityId,
    toolId,
    verifiedSuccesses:
      outcome === 'verified_success' ? clampCounter(existing.verifiedSuccesses) : existing.verifiedSuccesses,
    successes: outcome === 'success' ? clampCounter(existing.successes) : existing.successes,
    failures: outcome === 'failure' ? clampCounter(existing.failures) : existing.failures,
    lastOutcome: outcome,
  }
  const updated = new Map(index)
  updated.set(key, next)
  return updated
}

/**
 * Weak deterministic reliability score in [0,1]. Defaults to 0.5 (indifference)
 * when no history exists; verified outcomes weight twice as heavily as plain
 * successes, and the sequence is smoothed so a single sample never dominates.
 */
export function reliabilityScore(
  index: CapabilityReliabilityIndex,
  capabilityId: string,
  toolId: string,
): number {
  const record = index.get(reliabilityKey(capabilityId, toolId))
  if (!record) return 0.5
  const attempts = record.successes + record.verifiedSuccesses + record.failures
  if (attempts === 0) return 0.5
  const weighted = record.successes + 2 * record.verifiedSuccesses
  const raw = (weighted + 0.5) / (attempts + 1)
  return Math.min(1, Math.max(0, raw))
}