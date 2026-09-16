import type { VisualEnvironmentId } from './types'

/**
 * Phase 8 — environment transition selection.
 *
 * Switching environments never reloads the page: the old environment unmounts
 * cleanly (its rAF/WebGL resources are released) and a CSS/GPU transition veil
 * bridges the swap. This module chooses WHICH transition fits a given pair and
 * the exact durations — pure, so it is unit-tested.
 */

export type TransitionKind = 'none' | 'fade' | 'radial' | 'sweep' | 'hud-scan' | 'dissolve'

const ORDER: Record<VisualEnvironmentId, number> = {
  arc: 0,
  astra: 1,
  control: 2,
  space: 3,
  tunnel: 4,
  neural: 5,
}

export function pickTransition(
  from: VisualEnvironmentId,
  to: VisualEnvironmentId,
): TransitionKind {
  if (from === to) return 'none'

  // Entering/leaving the reactor: a radial expansion/collapse reads best.
  if (to === 'arc' || from === 'arc') return 'radial'

  // Tactical panels share a scanning lineage.
  if (
    (from === 'astra' && to === 'control') ||
    (from === 'control' && to === 'astra')
  ) {
    return 'hud-scan'
  }

  // Corridors dissolve into one another.
  if (
    (from === 'space' && to === 'tunnel') ||
    (from === 'tunnel' && to === 'space')
  ) {
    return 'dissolve'
  }

  // Neural ↔ networked envs use the scan transition.
  if (to === 'neural' || from === 'neural') return 'hud-scan'

  // Adjacent environments cross-fade; distant ones get a directional sweep.
  const distance = Math.abs(ORDER[to] - ORDER[from])
  return distance <= 1 ? 'fade' : 'sweep'
}

export interface TransitionTimings {
  inMs: number
  holdMs: number
  outMs: number
  totalMs: number
}

const TIMINGS_BY_KIND: Record<Exclude<TransitionKind, 'none'>, { in: number; hold: number; out: number }> = {
  fade: { in: 260, hold: 120, out: 360 },
  radial: { in: 300, hold: 120, out: 420 },
  sweep: { in: 320, hold: 100, out: 380 },
  'hud-scan': { in: 300, hold: 140, out: 300 },
  dissolve: { in: 280, hold: 120, out: 340 },
}

export function resolveTransitionTimings(kind: TransitionKind): TransitionTimings {
  if (kind === 'none') return { inMs: 0, holdMs: 0, outMs: 0, totalMs: 0 }
  const t = TIMINGS_BY_KIND[kind]
  const totalMs = t.in + t.hold + t.out
  return { inMs: t.in, holdMs: t.hold, outMs: t.out, totalMs }
}