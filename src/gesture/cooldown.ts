import type { GestureId } from './types'
import { GESTURE_CONFIG } from './config'

/**
 * Phase 10 — per-gesture anti-repeat window (mission #4).
 *
 * A recognized gesture is held; the cooldown guarantees a single action per
 * deliberate pose/movement even if the camera keeps seeing it. Detector-level
 * "leave the active state" resets in the classifier complement this timer.
 */
export class GestureCooldown {
  private readonly lastFired: Record<GestureId, number>
  private readonly windowMs: number

  constructor(windowMs: number = GESTURE_CONFIG.gestureCooldownMs) {
    this.windowMs = windowMs
    this.lastFired = { zoom_in: 0, zoom_out: 0, crush: 0, theme_change: 0 }
  }

  isBlocked(gesture: GestureId, now: number): boolean {
    return now - this.lastFired[gesture] < this.windowMs
  }

  remaining(gesture: GestureId, now: number): number {
    return Math.max(0, this.windowMs - (now - this.lastFired[gesture]))
  }

  setFired(gesture: GestureId, now: number): void {
    this.lastFired[gesture] = now
  }
}