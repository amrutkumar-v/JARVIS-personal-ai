import type { JarvisStatus } from '../engine/types'

/**
 * Phase 8 — LIVE VISUAL ENVIRONMENT SYSTEM.
 *
 * The environment layer is the immersive, full-viewport backdrop of JARVIS.
 * It is a PRESENTATION layer only: every environment is driven by the REAL
 * engine/backend state mirrored in the zustand store — never by fabricated
 * telemetry. The Arc Reactor, Astra, Control, Space and Tunnel environments
 * all consume the same normalized visual drive (see visualState.ts).
 */

/** Canonical environment ids. Kept stable across versions for persistence. */
export type VisualEnvironmentId = 'arc' | 'astra' | 'control' | 'space' | 'tunnel' | 'neural'

export type EnvironmentKind = 'webgl' | 'canvas' | 'dom'

export interface EnvironmentDefinition {
  id: VisualEnvironmentId
  label: string
  description: string
  kind: EnvironmentKind
  glyph: string
}

/**
 * Normalized visual state produced from real engine signals. This is the
 * shared vocabulary every environment reacts to (energy, speed, pulse).
 */
export type VisualState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'planning'
  | 'executing'
  | 'observing'
  | 'verifying'
  | 'recovering'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * The per-frame visual "drive" consumed by environment animation loops.
 * Computed each animation frame from the real store snapshot — it is
 * animation-local state, never React state.
 */
export interface EnvironmentDrive {
  state: VisualState
  /** The REAL engine status this frame was derived from. */
  status: JarvisStatus
  /** True only while the engine genuinely reports speech. */
  speaking: boolean
  /** 0..1 overall energy level (calm → intense). */
  energy: number
  /** Motion speed multiplier (already reduced for reduced-motion users). */
  speed: number
  /** Pulse amplitude multiplier. */
  pulse: number
  /** 0..1 speech energy; non-zero only for REAL speech. */
  speech: number
}