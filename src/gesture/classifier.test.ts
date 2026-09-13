import { describe, expect, it } from 'vitest'
import { GestureRecognizer } from './classifier'
import type { GestureCandidate, NormalizedHand, RawHandSample } from './types'

/**
 * Phase 10 — recognizer tests.
 *
 * Fully synthetic landmark streams that reproduce the EXACT user-defined
 * gestures: two-hand expand/contract, open→fist→hold crush, open-palm sweep.
 * The pipeline is stateful, so tests verify both firing AND the
 * "leave the active state" anti-repeat behaviour at the detector level.
 */

let seq = 0

function hand(
  palmCenter: { x: number; y: number },
  openScore: number,
  index = 0,
  confidence = 0.9,
): NormalizedHand {
  return {
    handIndex: index,
    handedness: 'Right',
    confidence,
    wrist: { x: palmCenter.x - 0.02, y: palmCenter.y + 0.03 },
    palmCenter,
    palmSize: 0.12,
    openScore,
    thumbOpen: openScore,
    landmarks: [{ x: palmCenter.x, y: palmCenter.y }],
    fingerOpen: [
      openScore > 0.5,
      openScore > 0.5,
      openScore > 0.5,
      openScore > 0.5,
    ],
  }
}

function sample(ts: number, hands: NormalizedHand[]): RawHandSample {
  seq += 1
  return { t: seq, ts, hands, quality: 0.9 }
}

function ingestAll(
  recognizer: GestureRecognizer,
  frames: RawHandSample[],
): GestureCandidate[][] {
  const steps: GestureCandidate[][] = []
  for (const f of frames) steps.push(recognizer.ingest(f))
  return steps
}

function flatCandidates(steps: GestureCandidate[][]): GestureCandidate[] {
  return steps.flat()
}

describe('GestureRecognizer', () => {
  it('detects ZOOM IN: two hands start close and move apart, once it settles', () => {
    const recognizer = new GestureRecognizer()
    const frames: RawHandSample[] = []
    // Start close together, move apart across ~0.6s, then hold still.
    for (let i = 0; i <= 6; i += 1) {
      const sep = 0.15 + (i / 6) * 0.3 // 0.15 → 0.45
      frames.push(sample(i * 100, [
        hand({ x: 0.5 - sep / 2, y: 0.5 }, 0.4, 0),
        hand({ x: 0.5 + sep / 2, y: 0.5 }, 0.4, 1),
      ]))
    }
    for (let i = 7; i <= 12; i += 1) {
      frames.push(sample(i * 100, [
        hand({ x: 0.275, y: 0.5 }, 0.4, 0),
        hand({ x: 0.725, y: 0.5 }, 0.4, 1),
      ]))
    }

    const steps = ingestAll(recognizer, frames)
    const fired: GestureCandidate[] = []
    for (const list of steps) {
      const zoom = list.find((c) => c.gesture.startsWith('zoom'))
      if (zoom) fired.push(zoom)
    }
    expect(fired.length).toBeGreaterThanOrEqual(1)
    // It fired after the move settled (not while still moving).
    const firstFireIndex = steps.findIndex((l) => l.some((c) => c.gesture.startsWith('zoom')))
    expect(firstFireIndex).toBeGreaterThan(6)
  })

  it('detects ZOOM OUT: two hands start apart and move together', () => {
    const recognizer = new GestureRecognizer()
    const frames: RawHandSample[] = []
    for (let i = 0; i <= 6; i += 1) {
      const sep = 0.45 - (i / 6) * 0.3
      frames.push(sample(i * 100, [
        hand({ x: 0.5 - sep / 2, y: 0.5 }, 0.4, 0),
        hand({ x: 0.5 + sep / 2, y: 0.5 }, 0.4, 1),
      ]))
    }
    // Hold the CONTRACTED position (sep 0.15 → x = 0.425 / 0.575), mirroring
    // the hold-at-target of the ZOOM IN test.
    for (let i = 7; i <= 12; i += 1) {
      frames.push(sample(i * 100, [
        hand({ x: 0.425, y: 0.5 }, 0.4, 0),
        hand({ x: 0.575, y: 0.5 }, 0.4, 1),
      ]))
    }

    const zoom = flatCandidates(ingestAll(recognizer, frames)).filter((c) =>
      c.gesture === 'zoom_out',
    )
    expect(zoom.length).toBeGreaterThanOrEqual(1)
  })

  it('ZOOM honors "leave the active state": no refire while held apart, fires again after return', () => {
    const recognizer = new GestureRecognizer()
    const frames: RawHandSample[] = []
    for (let i = 0; i <= 6; i += 1) {
      const sep = 0.15 + (i / 6) * 0.3
      frames.push(sample(i * 100, [
        hand({ x: 0.5 - sep / 2, y: 0.5 }, 0.4, 0),
        hand({ x: 0.5 + sep / 2, y: 0.5 }, 0.4, 1),
      ]))
    }
    for (let i = 7; i <= 12; i += 1) {
      frames.push(sample(i * 100, [
        hand({ x: 0.275, y: 0.5 }, 0.4, 0),
        hand({ x: 0.725, y: 0.5 }, 0.4, 1),
      ]))
    }

    // Fire-tracking must run INLINE with ingestion: the detector only knows a
    // zoom fired after notifyFired, so candidates produced on later frames of a
    // pre-ingested batch would wrongly look like refires.
    let firedCount = 0
    for (const f of frames) {
      const list = recognizer.ingest(f)
      const zoom = list.find((c) => c.gesture.startsWith('zoom'))
      if (zoom) {
        firedCount += 1
        recognizer.notifyFired(zoom.gesture as 'zoom_in' | 'zoom_out')
      }
    }
    expect(firedCount).toBe(1)

    // STILL held apart — more frames, no new fire.
    for (let i = 13; i <= 20; i += 1) {
      const out = recognizer.ingest(sample(i * 100, [
        hand({ x: 0.275, y: 0.5 }, 0.4, 0),
        hand({ x: 0.725, y: 0.5 }, 0.4, 1),
      ]))
      const fire = out.find((c: GestureCandidate) => c.gesture.startsWith('zoom'))
      expect(fire).toBeUndefined()
    }

    // RETURN toward close (the hands truly came back), then hold there.
    const returnFrames: RawHandSample[] = []
    for (let i = 21; i <= 27; i += 1) {
      const sep = 0.45 - ((i - 21) / 6) * 0.3
      returnFrames.push(sample(i * 100, [
        hand({ x: 0.5 - sep / 2, y: 0.5 }, 0.4, 0),
        hand({ x: 0.5 + sep / 2, y: 0.5 }, 0.4, 1),
      ]))
    }
    for (let i = 28; i <= 33; i += 1) {
      returnFrames.push(sample(i * 100, [
        hand({ x: 0.425, y: 0.5 }, 0.4, 0),
        hand({ x: 0.575, y: 0.5 }, 0.4, 1),
      ]))
    }

    let rearmed = false
    for (const s of returnFrames) {
      const out = recognizer.ingest(s)
      const fire = out.find((c: GestureCandidate) => c.gesture.startsWith('zoom'))
      if (fire) {
        rearmed = true
        recognizer.notifyFired(fire.gesture as 'zoom_in' | 'zoom_out')
      }
    }
    expect(rearmed).toBe(true)
  })

  it('detects CRUSH only on a REAL open→fist→hold transition', () => {
    const recognizer = new GestureRecognizer()
    const frames: RawHandSample[] = []
    // Open hand, stationary.
    for (let i = 0; i <= 2; i += 1) {
      frames.push(sample(i * 100, [hand({ x: 0.5, y: 0.5 }, 0.85)]))
    }
    // Closes into a fist at 300ms and holds.
    for (let i = 3; i <= 8; i += 1) {
      frames.push(sample(i * 100, [hand({ x: 0.5, y: 0.5 }, 0.15)]))
    }

    const steps = ingestAll(recognizer, frames)
    const crushFrames = steps.map((list) => list.find((c) => c.gesture === 'crush'))
    // No crush during the open phase.
    expect(crushFrames.slice(0, 3).every((c) => c === undefined)).toBe(true)
    // Crush fires AFTER the fist was held long enough (>=320ms hold).
    const firstCrush = crushFrames.findIndex((c) => c !== undefined)
    expect(firstCrush).toBeGreaterThanOrEqual(6) // ts >= 600ms (300 + 320)
  })

  it('a fist that appears already-closed never fires CRUSH (must observe open first)', () => {
    const recognizer = new GestureRecognizer()
    const frames: RawHandSample[] = []
    for (let i = 0; i <= 10; i += 1) {
      frames.push(sample(i * 100, [hand({ x: 0.5, y: 0.5 }, 0.15)]))
    }
    const crush = flatCandidates(ingestAll(recognizer, frames)).filter((c) => c.gesture === 'crush')
    expect(crush).toHaveLength(0)
  })

  it('CRUSH honors "leave the active state": no refire while held, fires again only after reopening', () => {
    const recognizer = new GestureRecognizer()
    let fired = 0

    const open = (ts: number) => sample(ts, [hand({ x: 0.5, y: 0.5 }, 0.85)])
    const fist = (ts: number) => sample(ts, [hand({ x: 0.5, y: 0.5 }, 0.15)])

    // Open → fist → hold → FIRE (once).
    let ts = 0
    for (let i = 0; i < 3; i += 1, ts += 100) recognizer.ingest(open(ts))
    for (let i = 0; i < 6; i += 1, ts += 100) {
      const out = recognizer.ingest(fist(ts))
      if (out.some((c) => c.gesture === 'crush')) {
        fired += 1
        recognizer.notifyFired('crush')
      }
    }
    expect(fired).toBe(1)

    // Keep holding — no re-fire.
    for (let i = 0; i < 5; i += 1, ts += 100) {
      const out = recognizer.ingest(fist(ts))
      expect(out.some((c) => c.gesture === 'crush')).toBe(false)
    }

    // Reopen → fist → hold → fires again.
    for (let i = 0; i < 3; i += 1, ts += 100) recognizer.ingest(open(ts))
    for (let i = 0; i < 6; i += 1, ts += 100) {
      const out = recognizer.ingest(fist(ts))
      if (out.some((c) => c.gesture === 'crush')) {
        fired += 1
        recognizer.notifyFired('crush')
      }
    }
    expect(fired).toBe(2)
  })

  it('detects THEME CHANGE: an open palm sweeps horizontally and settles', () => {
    const recognizer = new GestureRecognizer()
    const frames: RawHandSample[] = []
    // Sweep open palm from x=0.75 → 0.2 (dx = -0.55) with tiny y drift.
    for (let i = 0; i <= 6; i += 1) {
      const x = 0.75 - (i / 6) * 0.55
      frames.push(sample(i * 100, [hand({ x, y: 0.5 }, 0.8)]))
    }
    for (let i = 7; i <= 12; i += 1) {
      frames.push(sample(i * 100, [hand({ x: 0.2, y: 0.5 }, 0.8)]))
    }

    const steps = ingestAll(recognizer, frames)
    const sweep = flatCandidates(steps).filter((c) => c.gesture === 'theme_change')
    expect(sweep.length).toBeGreaterThanOrEqual(1)
    // Not while the palm is still moving fast.
    expect(steps.findIndex((l) => l.some((c) => c.gesture === 'theme_change'))).toBeGreaterThan(6)
  })

  it('THEME CHANGE ignores a vertical-only motion', () => {
    const recognizer = new GestureRecognizer()
    const frames: RawHandSample[] = []
    for (let i = 0; i <= 6; i += 1) {
      const y = 0.2 + (i / 6) * 0.5
      frames.push(sample(i * 100, [hand({ x: 0.5, y }, 0.8)]))
    }
    for (let i = 7; i <= 12; i += 1) {
      frames.push(sample(i * 100, [hand({ x: 0.5, y: 0.7 }, 0.8)]))
    }
    const sweep = flatCandidates(ingestAll(recognizer, frames)).filter((c) => c.gesture === 'theme_change')
    expect(sweep).toHaveLength(0)
  })

  it('THEME CHANGE honors the return-stroke reset', () => {
    const recognizer = new GestureRecognizer()
    let fired = 0
    const sweepRun = (fromX: number, toX: number, startTs: number) => {
      for (let i = 0; i <= 6; i += 1) {
        const x = fromX + ((toX - fromX) * i) / 6
        const out = recognizer.ingest(sample(startTs + i * 100, [hand({ x, y: 0.5 }, 0.8)]))
        if (out.some((c) => c.gesture === 'theme_change')) {
          fired += 1
          recognizer.notifyFired('theme_change')
        }
      }
      // hold at destination (settle + window drains)
      for (let i = 7; i <= 14; i += 1) {
        const out = recognizer.ingest(sample(startTs + i * 100, [hand({ x: toX, y: 0.5 }, 0.8)]))
        if (out.some((c) => c.gesture === 'theme_change')) {
          fired += 1
          recognizer.notifyFired('theme_change')
        }
      }
    }
    // Departure stroke right → left fires once.
    sweepRun(0.75, 0.2, 0)
    expect(fired).toBe(1)
    // Holding at 0.2 while still at the destination should not fire again.
    // Return stroke left → right is a DELIBERATE new swipe: fires again.
    sweepRun(0.2, 0.75, 3000)
    expect(fired).toBe(2)
  })
})