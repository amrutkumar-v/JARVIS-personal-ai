import { Color } from 'three'
import type { JarvisStatus } from '../engine/types'

export interface VisualParams {
  color: Color
  active: number
  speed: number
  pulse: number
  /** 0..1 speech-energy target; used ONLY while the engine reports speaking. */
  speech: number
}

/** Per-status energy profile for the 3D core (the Arc Reactor). */
export const PARAMS: Record<JarvisStatus, VisualParams> = {
  idle:                      { color: new Color('#4fd8f0'), active: 0.14, speed: 0.30, pulse: 1.45, speech: 0 },
  listening:                 { color: new Color('#6fe7ff'), active: 0.55, speed: 0.55, pulse: 1.75, speech: 0 },
  thinking:                  { color: new Color('#6f7dff'), active: 0.80, speed: 0.85, pulse: 2.05, speech: 0 },
  understanding:             { color: new Color('#6f7dff'), active: 0.66, speed: 0.70, pulse: 1.95, speech: 0 },
  planning:                  { color: new Color('#7d6fff'), active: 0.80, speed: 0.85, pulse: 2.05, speech: 0 },
  executing:                 { color: new Color('#ffae5c'), active: 1.25, speed: 1.15, pulse: 2.60, speech: 0 },
  observing:                 { color: new Color('#3ecfe0'), active: 0.95, speed: 0.90, pulse: 2.30, speech: 0 },
  verifying:                 { color: new Color('#57e0a2'), active: 1.05, speed: 0.72, pulse: 2.85, speech: 0 },
  speaking:                  { color: new Color('#62e3ff'), active: 1.00, speed: 0.70, pulse: 2.30, speech: 1 },
  waiting_for_confirmation:  { color: new Color('#ffd166'), active: 0.90, speed: 0.48, pulse: 2.10, speech: 0 },
  success:                   { color: new Color('#57e0a2'), active: 1.10, speed: 0.90, pulse: 3.10, speech: 0 },
  warning:                   { color: new Color('#ffd166'), active: 1.00, speed: 0.60, pulse: 2.20, speech: 0 },
  error:                     { color: new Color('#ff5c6c'), active: 1.35, speed: 1.00, pulse: 2.80, speech: 0 },
  failed:                    { color: new Color('#ff5c6c'), active: 1.20, speed: 0.90, pulse: 2.60, speech: 0 },
  cancelling:                { color: new Color('#8f9db0'), active: 0.70, speed: 0.40, pulse: 1.80, speech: 0 },
  cancelled:                 { color: new Color('#8f9db0'), active: 0.50, speed: 0.35, pulse: 1.60, speech: 0 },
}

export const IDLE: VisualParams = PARAMS.idle

/**
 * Mutable "live" target each frame. `StatusDriver` damps `live` toward
 * `PARAMS[status]`; the visual components read `live` in their useFrame.
 */
export const live: VisualParams = {
  color: IDLE.color.clone(),
  active: IDLE.active,
  speed: IDLE.speed,
  pulse: IDLE.pulse,
  speech: IDLE.speech,
}

/**
 * Bounded, deterministic speaking amplitude. Real mic/audio analysis is NOT
 * available, so while the engine reports that JARVIS is actually speaking we
 * produce a smooth, bounded 0.35..1 breathe pattern (no jitter); it returns to
 * the target immediately when speech is not real.
 */
export function speakingAmplitude(t: number, target: number): number {
  const drive = Math.sin(t * 5.2)
  const level = 0.35 + 0.65 * ((drive + 1) / 2)
  return target * level
}