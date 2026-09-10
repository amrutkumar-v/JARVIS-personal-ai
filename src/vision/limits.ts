/**
 * Visual-understanding bounds (Phase 1.7) — browser-side mirror.
 *
 * Every visual surface is capped here so a malformed provider or a hostile
 * payload cannot grow memory/context without bound. The tool layer re-checks
 * these on every invocation; a request that would exceed a bound is reported
 * as an honest failure — never silently truncated into a half-answer.
 *
 * The per-RUN budget (MAX_VISUAL_ACTIONS_PER_RUN) is enforced by the Web
 * engine per JARVIS run (the same pattern as the desktop input budgets),
 * because the vision provider is stateless across requests.
 */
export const VISUAL_LIMITS = {
  /** Max elements one analysis may hand back to the tool layer. */
  MAX_VISUAL_ELEMENTS: 100,
  /** Max chars kept for any element label / text (bounds memory, redacts dumps). */
  MAX_VISUAL_TEXT_LENGTH: 256,
  /** Max wall time ONE screenshot analysis may take (ms). */
  MAX_VISUAL_ANALYSIS_MS: 5000,
  /** Max visual actions (inspect/click/type) per JARVIS run. */
  MAX_VISUAL_ACTIONS_PER_RUN: 20,
  /** Max candidates surfaced when the resolver reports `ambiguous`. */
  MAX_TARGET_CANDIDATES: 10,
} as const