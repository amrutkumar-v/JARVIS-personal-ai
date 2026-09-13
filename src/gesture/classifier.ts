import type { GestureCandidate, GestureId, NormalizedHand, RawHandSample } from './types'
import { GESTURE_CONFIG } from './config'
import { distancePx } from './landmarks'

/**
 * Phase 10 — movement/pose classification (mission #1).
 *
 * Each detector is a small state machine over the rolling hand history. A
 * detector only emits a CANDIDATE — it never fires an action. Candidates are
 * gated (confidence + per-gesture cooldown + lifecycle) by the pipeline.
 *
 * "Leave the active state" is enforced at the detector level, so a held pose
 * can never machine-gun actions even after the global gate cooled down:
 *
 *  - ZOOM: a fired expansion/contraction must first return before a new one
 *    can be voted again.
 *  - CRUSH: after firing, the hand must open again before a new crunch.
 *  - THEME: after firing, the palm must sweep back across a minimum distance.
 */

export interface Detector {
  readonly gesture: GestureId
  evaluate(history: readonly RawHandSample[]): GestureCandidate | null
}

function separationOf(hands: readonly NormalizedHand[]): number {
  const [a, b] = hands
  if (!a || !b) return 0
  return distancePx(a.palmCenter, b.palmCenter)
}

/** Best-confidence hand of a sample (primary = most reliably tracked). */
function bestHand(sample: RawHandSample): NormalizedHand | null {
  let best: NormalizedHand | null = null
  for (const h of sample.hands) {
    if (!best || h.confidence > best.confidence) best = h
  }
  return best
}

/** Trailing samples inside the configured history window. */
function windowOf(history: readonly RawHandSample[], windowMs: number): RawHandSample[] {
  const last = history[history.length - 1]
  if (!last) return []
  const from = last.ts - windowMs
  return history.filter((s) => s.ts >= from)
}

/** Fraction of adjacent deltas sharing the series net direction. */
function monotonicFraction(values: readonly number[]): number {
  if (values.length < 2) return 1
  const net = values[values.length - 1]! - values[0]!
  if (net === 0) return 0
  let same = 0
  for (let i = 1; i < values.length; i += 1) {
    const d = values[i]! - values[i - 1]!
    if (d === 0) same += 0.5
    else if (Math.sign(d) === Math.sign(net)) same += 1
  }
  return same / (values.length - 1)
}

function clampConfidence(score: number): number {
  return Math.max(0.6, Math.min(0.98, score))
}

/** Recent frame count used to judge "movement has settled/completed". */
const ZOOM_RECENT_FRAMES = 4
const SWEEP_RECENT_FRAMES = 4

/**
 * Two-hand filter/expand. Hands start close and move apart → zoom_in; start far
 * and move together → zoom_out. Fires ONCE after the movement clearly completes
 * (velocity settles); will not re-fire until the separation truly returns.
 */
class ZoomDetector implements Detector {
  readonly gesture: GestureId = 'zoom_in'
  private fired: { dir: 1 | -1; sep: number } | null = null
  private readonly config: typeof GESTURE_CONFIG

  constructor(config: typeof GESTURE_CONFIG) {
    this.config = config
  }

  evaluate(history: readonly RawHandSample[]): GestureCandidate | null {
    const win = windowOf(history, this.config.historyWindowMs)
    if (win.length < this.config.minSamples) return null
    const two = win.filter((s) => s.hands.length === 2)
    if (two.length < this.config.minSamples) return null

    const series = two.map((s) => ({ ts: s.ts, sep: separationOf(s.hands) }))
    const first = series[0]!
    const last = series[series.length - 1]!

    // Re-arm: a fired zoom must return toward its start before voting again.
    if (this.fired) {
      const reset = this.fired.dir > 0
        ? last.sep <= this.fired.sep - this.config.zoomResetDelta
        : last.sep >= this.fired.sep + this.config.zoomResetDelta
      if (!reset) return null
      this.fired = null
    }

    const delta = last.sep - first.sep
    const magnitude = Math.abs(delta)
    if (magnitude < this.config.zoomSepDeltaMin) return null

    const dir: 1 | -1 = delta > 0 ? 1 : -1
    if (monotonicFraction(series.map((s) => s.sep)) < this.config.zoomMonotonicMin) return null

    // The movement is "clearly completed" once the RECENT separation stops
    // changing (the near-term velocity falls below the floor) — measuring over
    // the whole window would wait for the window to drain instead of firing
    // right when the hands settle.
    const recent = series.slice(-ZOOM_RECENT_FRAMES)
    const recentDt = Math.max(1, recent[recent.length - 1]!.ts - recent[0]!.ts)
    if (Math.abs(recent[recent.length - 1]!.sep - recent[0]!.sep) / recentDt > this.config.zoomSettleVMax) {
      return null
    }

    const confidence = clampConfidence(
      0.6 + (magnitude - this.config.zoomSepDeltaMin) * 1.6 + monotonicFraction(series.map((s) => s.sep)) * 0.1,
    )
    return { gesture: dir > 0 ? 'zoom_in' : 'zoom_out', confidence }
  }

  /** Called by the pipeline when a zoom intent was actually accepted. */
  markFired(history: readonly RawHandSample[]): void {
    const two = history.filter((s) => s.hands.length === 2)
    const last = two[two.length - 1]
    const sep = last ? separationOf(last.hands) : 0
    const at = two[two.length - 2]
    const dir: 1 | -1 =
      at && last ? (separationOf(last.hands) >= separationOf(at.hands) ? 1 : -1) : 1
    this.fired = { dir, sep }
  }

  reset(): void {
    this.fired = null
  }
}

/**
 * Single-hand open→fist→hold transition. Recognized on the transition itself:
 * the hand MUST be observed open first, close into a fist, and HOLD the fist
 * for the required window before a crush candidate is voted.
 */
class CrushDetector implements Detector {
  readonly gesture: GestureId = 'crush'
  private state: 'waiting' | 'open' | 'fisted' | 'drained' = 'waiting'
  private fistedAt = 0
  private readonly config: typeof GESTURE_CONFIG

  constructor(config: typeof GESTURE_CONFIG) {
    this.config = config
  }

  evaluate(history: readonly RawHandSample[]): GestureCandidate | null {
    const win = windowOf(history, this.config.historyWindowMs)
    const sample = win[win.length - 1]
    if (!sample || sample.hands.length < 1) return null
    const hand = bestHand(sample)
    if (!hand) return null
    const s = hand.openScore

    switch (this.state) {
      case 'waiting':
      case 'drained':
        if (s >= this.config.crushOpenScoreHigh) this.state = 'open'
        return null
      case 'open':
        if (s <= this.config.crushOpenScoreLow) {
          this.state = 'fisted'
          this.fistedAt = sample.ts
        }
        return null
      case 'fisted':
        if (s > this.config.crushOpenScoreLow) {
          // Opened before the hold window elapsed — back to waiting.
          this.state = s >= this.config.crushOpenScoreHigh ? 'open' : 'waiting'
          return null
        }
        if (sample.ts - this.fistedAt < this.config.crushHoldMs) return null
        return { gesture: 'crush', confidence: 0.85 }
      default:
        return null
    }
  }

  /** After an accepted crush, the hand must open again before the next. */
  markFired(): void {
    this.state = 'drained'
  }

  reset(): void {
    this.state = 'waiting'
    this.fistedAt = 0
  }
}

/**
 * Open-palm horizontal sweep. Voted once per DEPARTURE stroke; the palm must
 * meaningfully leave its resting spot (return-stroke / anti-repeat) before a
 * new departure vote can be claimed, so a held swipe never machine-guns.
 */
class SweepDetector implements Detector {
  readonly gesture: GestureId = 'theme_change'
  private fired: { dir: 1 | -1; refX: number } | null = null
  private readonly config: typeof GESTURE_CONFIG

  constructor(config: typeof GESTURE_CONFIG) {
    this.config = config
  }

  evaluate(history: readonly RawHandSample[]): GestureCandidate | null {
    const win = windowOf(history, this.config.historyWindowMs)
    const series: Array<{ ts: number; x: number; y: number }> = []
    for (const s of win) {
      const hand = bestHand(s)
      if (hand && hand.openScore >= this.config.sweepOpenMin) {
        series.push({ ts: s.ts, x: hand.palmCenter.x, y: hand.palmCenter.y })
      }
    }
    if (series.length < this.config.minSamples) return null

    const first = series[0]!
    const last = series[series.length - 1]!

    if (this.fired) {
      // Re-arm as soon as the palm meaningfully leaves its resting spot — a
      // held palm never fires again, but a genuine return stroke is a new
      // deliberate swipe.
      const leftRest = Math.abs(last.x - this.fired.refX) >= this.config.sweepDxMin * 0.2
      if (!leftRest) return null
      this.fired = null
    }

    const dx = last.x - first.x
    if (Math.abs(dx) < this.config.sweepDxMin) return null
    if (Math.abs(last.y - first.y) > this.config.sweepDyMax) return null
    if (monotonicFraction(series.map((s) => s.x)) < this.config.sweepMonotonicMin) return null

    const recent = series.slice(-SWEEP_RECENT_FRAMES)
    const recentDt = Math.max(1, recent[recent.length - 1]!.ts - recent[0]!.ts)
    if (Math.abs(recent[recent.length - 1]!.x - recent[0]!.x) / recentDt > this.config.sweepSettleVMax) {
      return null // still sweeping — wait for it to finish
    }

    const confidence = clampConfidence(0.6 + (Math.abs(dx) - this.config.sweepDxMin) * 1.3)
    return { gesture: 'theme_change', confidence }
  }

  markFired(history: readonly RawHandSample[]): void {
    const win = windowOf(history, this.config.historyWindowMs)
    const series: Array<{ x: number; y: number }> = []
    for (const s of win) {
      const hand = bestHand(s)
      if (hand) series.push(hand.palmCenter)
    }
    if (series.length >= 2) {
      const first = series[0]!
      const last = series[series.length - 1]!
      this.fired = { dir: last.x - first.x > 0 ? 1 : -1, refX: last.x }
    } else {
      this.fired = { dir: 1, refX: 0 }
    }
  }

  reset(): void {
    this.fired = null
  }
}

/**
 * Aggregates per-gesture detectors over the rolling history and prunes stale
 * samples. Produces candidates for the gate; never fires in itself.
 */
export class GestureRecognizer {
  private readonly config: typeof GESTURE_CONFIG
  private readonly zoom: ZoomDetector
  private readonly crush: CrushDetector
  private readonly sweep: SweepDetector
  private history: RawHandSample[] = []

  constructor(config: Partial<typeof GESTURE_CONFIG> = {}) {
    this.config = { ...GESTURE_CONFIG, ...config }
    this.zoom = new ZoomDetector(this.config)
    this.crush = new CrushDetector(this.config)
    this.sweep = new SweepDetector(this.config)
  }

  ingest(sample: RawHandSample): GestureCandidate[] {
    this.history.push(sample)
    const cutoff = sample.ts - this.config.historyWindowMs * 2
    this.history = this.history.filter((s) => s.ts >= cutoff)

    const out: GestureCandidate[] = []
    const z = this.zoom.evaluate(this.history)
    if (z) out.push(z)
    const c = this.crush.evaluate(this.history)
    if (c) out.push(c)
    const s = this.sweep.evaluate(this.history)
    if (s) out.push(s)
    return out
  }

  /** Inform the detectors that an intent was accepted and fired. */
  notifyFired(gesture: GestureId): void {
    if (gesture === 'zoom_in' || gesture === 'zoom_out') this.zoom.markFired(this.history)
    if (gesture === 'crush') this.crush.markFired()
    if (gesture === 'theme_change') this.sweep.markFired(this.history)
  }

  reset(): void {
    this.history = []
    this.zoom.reset()
    this.crush.reset()
    this.sweep.reset()
  }
}