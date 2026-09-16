import type { VisualEnvironmentId } from './types'

/**
 * Phase 10 — normalized environment zoom domain.
 *
 * Zoom is a bounded, per-environment scale factor applied to the ACTIVE visual
 * environment. It is real, user-controlled presentation state with honest
 * bounds: every level is clamped to the active environment's `[min, max]`
 * window, and callers learn when a boundary was reached instead of being told
 * a move succeeded that did not happen.
 *
 * The domain is pure data + math so the store, the gesture/voice surfaces and
 * the tests all share one source of truth. No React state lives here.
 */

/** 1 = default scale (100%). Levels are multiplicative steps around 1. */
export type ZoomLevel = number

export const DEFAULT_ZOOM: ZoomLevel = 1

/** Multiplicative factor applied per zoom step (in → *STEP, out → /STEP). */
export const ZOOM_STEP_FACTOR = 1.12

/** Normalized (fraction-of-frame width) scale the recognition thresholds use. */
export interface ZoomBounds {
  min: ZoomLevel
  max: ZoomLevel
}

/**
 * Per-environment zoom windows. Kept close to identity so zoom stays a subtle
 * camera pull, never an editor-level transform. Bounds are registry-scoped:
 * each environment defines its own envelope (single source, never guessed).
 */
export const ENVIRONMENT_ZOOM_BOUNDS: Record<VisualEnvironmentId, ZoomBounds> = {
  arc: { min: 0.55, max: 1.9 },
  astra: { min: 0.55, max: 1.7 },
  control: { min: 0.6, max: 1.6 },
  space: { min: 0.5, max: 1.8 },
  tunnel: { min: 0.55, max: 1.75 },
  neural: { min: 0.5, max: 1.8 },
}

export function zoomBoundsFor(environmentId: VisualEnvironmentId): ZoomBounds {
  return ENVIRONMENT_ZOOM_BOUNDS[environmentId] ?? ENVIRONMENT_ZOOM_BOUNDS.arc
}

/** Clamp a raw level to the environment's window (never NaN → default). */
export function clampZoom(level: number, bounds: ZoomBounds): ZoomLevel {
  if (!Number.isFinite(level)) return DEFAULT_ZOOM
  if (level < bounds.min) return bounds.min
  if (level > bounds.max) return bounds.max
  return level
}

/** One zoom step in the given direction, clamped to the bounds. */
export function stepZoom(
  level: number,
  dir: 1 | -1,
  bounds: ZoomBounds,
): { level: ZoomLevel; clamped: boolean } {
  const next = dir > 0 ? level * ZOOM_STEP_FACTOR : level / ZOOM_STEP_FACTOR
  const clamped = clampZoom(next, bounds)
  return { level: clamped, clamped: clamped !== next }
}

/** True when a given level is already sitting on a bound (no room to move). */
export function atBounds(
  level: number,
  dir: 1 | -1,
  bounds: ZoomBounds,
): 'min' | 'max' | null {
  if (level <= bounds.min && dir < 0) return 'min'
  if (level >= bounds.max && dir > 0) return 'max'
  return null
}