/**
 * Filesystem operation bounds (Phase 1.1).
 *
 * Every filesystem action is bounded: listings and searches cap their result
 * count and traversal depth, reads cap bytes, writes cap content size, and
 * copies cap total bytes. Bounds are enforced by the tools AND re-checked by
 * the production provider so no caller can bypass them.
 */
export const FS_LIMITS = {
  /** Max entries a single list call may return. */
  MAX_LIST_RESULTS: 200,
  /** Max matches a single search call may return. */
  MAX_SEARCH_RESULTS: 100,
  /** Max directory nesting a recursive search traverses below the root. */
  MAX_SEARCH_DEPTH: 4,
  /** Max bytes a single read may load into memory. */
  MAX_READ_BYTES: 512 * 1024,
  /** Max characters a single write may persist. */
  MAX_WRITE_CHARS: 100_000,
  /** Max bytes a copy/move may transfer in one operation. */
  MAX_COPY_BYTES: 4 * 1024 * 1024,
  /** Max length of a search query. */
  MAX_SEARCH_QUERY_LENGTH: 120,
  /** Max wall time a search may spend walking the tree (ms). */
  MAX_SEARCH_TIME_MS: 4000,
} as const

/**
 * Clamp a caller-supplied limit into `1..cap`; anything absent/invalid
 * resolves to the cap (never unlimited).
 */
export function boundedLimit(requested: unknown, cap: number): number {
  const n = Number(requested)
  if (Number.isFinite(n) && n >= 1) return Math.min(Math.floor(n), cap)
  return cap
}

/**
 * Clamp a caller-supplied depth into `0..cap`; anything absent/invalid
 * resolves to the fallback. 0 means the starting directory itself only.
 */
export function boundedDepth(requested: unknown, fallback: number, cap: number): number {
  const n = Number(requested)
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.floor(n), cap)
  return fallback
}

export function clampedLength(text: string, cap: number): boolean {
  return typeof text === 'string' && text.length <= cap
}