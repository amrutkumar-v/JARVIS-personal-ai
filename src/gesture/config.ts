/**
 * Phase 10 — recognition & gating configuration.
 *
 * Single tunable source for every threshold the pipeline uses. Kept as one
 * export so tuning is a one-file operation and tests can override with
 * precision instead of magic numbers.
 */

export const GESTURE_CONFIG = {
  /** Minimum interval between two MediaPipe inference calls (ms) — ≈12 fps. */
  inferenceIntervalMs: 80,
  /** Rolling history window used by movement detectors (ms). */
  historyWindowMs: 1400,
  /** Minimum samples in the window before any movement verdict. */
  minSamples: 6,

  /** ZOOM — two-hand separation (units of frame width). */
  zoomSepDeltaMin: 0.16,
  /** Separation velocity (per ms) under which a movement counts as settled. */
  zoomSettleVMax: 0.00012,
  /** Fraction of direction-consistent samples required to trust the move. */
  zoomMonotonicMin: 0.6,
  /** Separation delta that re-arms a fired zoom (hands have truly returned). */
  zoomResetDelta: 0.05,

  /** CRUSH — single-hand open→fist→hold transition. */
  crushOpenScoreHigh: 0.65,
  crushOpenScoreLow: 0.35,
  /** How long the fist must be held before firing (ms). */
  crushHoldMs: 320,

  /** THEME CHANGE — open-palm horizontal sweep. */
  sweepDxMin: 0.32,
  sweepDyMax: 0.28,
  sweepOpenMin: 0.55,
  sweepMonotonicMin: 0.6,
  /** Sweep velocity (per ms) under which the swipe counts as finished. */
  sweepSettleVMax: 0.0006,

  /** Minimum confidence for an intent to leave the pipeline. */
  minConfidence: 0.6,
  /** Per-gesture cooldown after firing (ms). */
  gestureCooldownMs: 1400,
} as const

export function withConfig(overrides: Partial<typeof GESTURE_CONFIG>): typeof GESTURE_CONFIG {
  return { ...GESTURE_CONFIG, ...overrides }
}