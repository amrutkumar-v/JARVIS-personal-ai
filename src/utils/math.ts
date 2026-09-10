/** Scale a look-up using a delta-time baseline. */
export function damp(target: number, current: number, lambda: number, dt: number): number {
  return current + lambda * (target - current) * dt
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Map `t` through a smoothstep for easing. */
export function smoothstep(t: number): number {
  const v = clamp(t, 0, 1)
  return v * v * (3 - 2 * v)
}

export const TAU = Math.PI * 2

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180
}

/** Pseudo-random in [0,1). */
export function rand(): number {
  return Math.random()
}

export function randRange(min: number, max: number): number {
  return min + (max - min) * Math.random()
}