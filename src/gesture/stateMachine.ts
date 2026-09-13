import type { GestureCandidate, GestureIntent, GesturePhase, GestureTrackingQuality } from './types'
import { GestureCooldown } from './cooldown'

/**
 * Phase 10 — gesture lifecycle gate (mission #2).
 *
 * UNKNOWN → TRACKING → CANDIDATE → CONFIRMED → ACTION FIRED → COOLDOWN → READY
 *
 * The gate is a pure local state machine that sits between the detector (which
 * votes candidates) and the engine executor (which runs real actions). It
 * applies confidence gating, lifecycle tracking, and per-gesture cooldowns so
 * that every intent leaving the gate has already cleared every fast,
 * deterministic filter without blocking the UI thread.
 */
export class GestureGate {
  private cooldown: GestureCooldown
  phase: GesturePhase = 'unknown'
  handCount = 0
  trackingQuality: GestureTrackingQuality = 'none'
  lastGesture: GestureIntent | null = null

  constructor(cooldownMs?: number) {
    this.cooldown = new GestureCooldown(cooldownMs)
  }

  /**
   * Feed one round of candidates. Returns a single accepted intent (the
   * highest-confidence candidate that clears all gates), or null when nothing
   * qualifies this tick. `minConfidence` is configurable per run so the caller
   * can tune per-environment.
   */
  accept(
    candidates: readonly GestureCandidate[],
    now: number,
    handCount: number,
    trackingQuality: GestureTrackingQuality,
    minConfidence: number,
  ): GestureIntent | null {
    this.handCount = handCount
    this.trackingQuality = trackingQuality

    if (handCount === 0) {
      this.phase = 'unknown'
      return null
    }

    if (candidates.length === 0) {
      if (this.phase !== 'fired' && this.phase !== 'cooldown') {
        this.phase = 'tracking'
      }
      return null
    }

    const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence)

    for (const cand of sorted) {
      if (cand.confidence < minConfidence) continue
      if (this.cooldown.isBlocked(cand.gesture, now)) {
        this.phase = 'cooldown'
        continue
      }

      this.phase = 'fired'
      this.cooldown.setFired(cand.gesture, now)
      const intent: GestureIntent = {
        gesture: cand.gesture,
        confidence: cand.confidence,
        timestamp: now,
        handCount,
        trackingQuality,
      }
      this.lastGesture = intent
      return intent
    }

    // Candidates were present but none cleared the confidence or cooldown gates.
    if (this.phase !== 'fired' && this.phase !== 'cooldown') this.phase = 'candidate'
    return null
  }

  reset(): void {
    this.phase = 'unknown'
    this.handCount = 0
    this.trackingQuality = 'none'
    this.lastGesture = null
  }
}