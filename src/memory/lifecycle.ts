import type { MemoryItem } from './MemoryManager'

/**
 * Phase 0.7 — memory lifecycle (forgetting & consolidation).
 *
 * Lifecycle decisions are PURE, DETERMINISTIC functions of time + importance.
 * Embeddings never participate: an item's vector can never make it
 * "forgettable" or "important" on its own. Everything here is a safety net
 * that ARCHIVES (recoverable) rather than destroys, and every archiving rule
 * is explicit and auditable in this single file.
 *
 * Rules:
 * - Time-based forgetting archives items older than `forgetAfterDays` whose
 *   importance is at/below `importanceFloor`. Items with importance at/above
 *   `protectImportance` are NEVER archived by age.
 * - Overflow trimming (optional `maxItems`) archives the lowest-priority
 *   items beyond the cap, again never touching protected items while any
 *   unprotected candidate exists.
 */

export interface LifecycleConfig {
  /** Master switch. When false, no consolidation ever runs. */
  enabled: boolean
  /** Archive items older than this, in days. */
  forgetAfterDays: number
  /** Age-based forgetting only touches items at/below this importance. */
  importanceFloor: number
  /** Items at/above this importance are never archived by lifecycle rules. */
  protectImportance: number
  /** Optional cap on active items; the lowest-priority excess is archived. */
  maxItems?: number
  /** Minimum gap between automatic runs (ms); 0 means "always due". */
  intervalMs: number
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  enabled: true,
  forgetAfterDays: 365,
  importanceFloor: 0.5,
  protectImportance: 0.8,
  maxItems: undefined,
  intervalMs: 7 * 24 * 60 * 60 * 1000,
}

export type ArchiveReason = 'stale' | 'overflow'

/** A memory moved out of the active set, kept recoverable. */
export interface ArchivedMemory extends MemoryItem {
  archivedAt: string
  archivedReason: ArchiveReason | 'manual'
}

export interface LifecycleReport {
  archived: ArchivedMemory[]
  archivedCount: number
  /** Remaining active items after consolidation. */
  kept: number
  /** Active + archived before consolidation (i.e. total items considered). */
  total: number
  lastRunAt: string
}

export interface ArchiveCandidacy {
  item: MemoryItem
  reason: ArchiveReason
  ageDays: number
}

/** Days since `updatedAt` (falling back to `createdAt`); malformed → 0. */
export function itemAgeDays(item: MemoryItem, nowMs: number): number {
  const t = Date.parse(item.updatedAt || item.createdAt)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, (nowMs - t) / 86_400_000)
}

/** True when an item qualifies for time-based (stale) archiving. */
export function isStaleCandidate(item: MemoryItem, nowMs: number, cfg: LifecycleConfig): boolean {
  if (!cfg.enabled) return false
  if (item.importance >= cfg.protectImportance) return false
  if (item.importance > cfg.importanceFloor) return false
  return itemAgeDays(item, nowMs) >= cfg.forgetAfterDays
}

/**
 * Excess items beyond `maxItems` that should be archived, lowest priority
 * first (importance asc, then oldest first). Protected items are avoided
 * unless every item is protected.
 */
export function overflowCandidates(
  items: readonly MemoryItem[],
  nowMs: number,
  cfg: LifecycleConfig,
): MemoryItem[] {
  if (!cfg.enabled || cfg.maxItems === undefined || cfg.maxItems < 0) return []
  const max = Math.floor(cfg.maxItems)
  if (items.length <= max) return []
  const sorted = [...items].sort(
    (a, b) =>
      a.importance - b.importance || itemAgeDays(b, nowMs) - itemAgeDays(a, nowMs),
  )
  const protectedCount = sorted.filter((i) => i.importance >= cfg.protectImportance).length
  const canUseProtected = protectedCount === sorted.length
  const pool = canUseProtected
    ? sorted
    : sorted.filter((i) => i.importance < cfg.protectImportance)
  return pool.slice(0, items.length - max)
}

/**
 * Full recommendation: stale first, then overflow on the remainder. Returns
 * candidates in a stable, reason-tagged order.
 */
export function archiveCandidates(
  items: readonly MemoryItem[],
  nowMs: number,
  cfg: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): ArchiveCandidacy[] {
  if (!cfg.enabled) return []
  const stale = items
    .filter((i) => isStaleCandidate(i, nowMs, cfg))
    .map((item) => ({ item, reason: 'stale' as const, ageDays: itemAgeDays(item, nowMs) }))
  const staleIds = new Set(stale.map((c) => c.item.id))
  const rest = items.filter((i) => !staleIds.has(i.id))
  const overflow = overflowCandidates(rest, nowMs, cfg).map(
    (item) => ({ item, reason: 'overflow' as const, ageDays: itemAgeDays(item, nowMs) }),
  )
  return [...stale, ...overflow]
}

/** True when enough wall time has passed since the last lifecycle run. */
export function isLifecycleDue(
  lastRunAt: string | undefined,
  nowMs: number,
  cfg: LifecycleConfig,
): boolean {
  if (!cfg.enabled) return false
  if (!lastRunAt) return true
  const last = Date.parse(lastRunAt)
  if (!Number.isFinite(last)) return true
  return nowMs - last >= cfg.intervalMs
}

/**
 * Lifecycle defaults, optionally overridden through environment variables
 * (follows the `VITE_JARVIS_*` convention; placeholders only). An explicit
 * `envSource` allows tests to pass an env snapshot without mutating
 * `import.meta.env`.
 */
export function defaultLifecycleConfig(envSource?: Record<string, unknown>): LifecycleConfig {
  const env = envSource ?? (import.meta as { env?: Record<string, unknown> }).env
  const readBool = (key: string, fallback: boolean): boolean => {
    const v = env?.[key]
    if (typeof v !== 'string' || v.trim() === '') return fallback
    return v.trim() === 'true' || v.trim() === '1'
  }
  const readPositiveNumber = (key: string, fallback: number): number => {
    const v = env?.[key]
    const n = Number(v)
    return typeof v === 'string' && Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    ...DEFAULT_LIFECYCLE_CONFIG,
    enabled: readBool('VITE_JARVIS_MEMORY_LIFECYCLE_ENABLED', DEFAULT_LIFECYCLE_CONFIG.enabled),
    forgetAfterDays: readPositiveNumber(
      'VITE_JARVIS_MEMORY_FORGET_AFTER_DAYS',
      DEFAULT_LIFECYCLE_CONFIG.forgetAfterDays,
    ),
  }
}