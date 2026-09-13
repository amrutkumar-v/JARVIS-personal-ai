import { describe, expect, it } from 'vitest'
import { normalizeHand, OPEN_FINGER_RATIO } from './landmarks'
import type { RawHand } from './landmarks'

/** Build a 21-point raw hand where the four fingertips sit at `tipY`. */
function rawHand(tipY: number): RawHand {
  const pts = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.6 }))
  pts[0] = { x: 0.5, y: 0.6 } // wrist
  pts[5] = { x: 0.48, y: 0.47 }
  pts[9] = { x: 0.52, y: 0.47 }
  pts[13] = { x: 0.56, y: 0.47 }
  pts[17] = { x: 0.6, y: 0.47 }
  ;[8, 12, 16, 20].forEach((i) => {
    pts[i] = { x: 0.5, y: tipY }
  })
  pts[4] = { x: 0.5, y: tipY } // thumb
  return {
    handIndex: 0,
    handedness: 'Right',
    confidence: 0.94,
    landmarks: pts,
  }
}

describe('normalizeHand', () => {
  it('marks an outstretched hand as open (openScore 1)', () => {
    const h = normalizeHand(rawHand(0.25))
    expect(h.openScore).toBe(1)
    expect(h.fingerOpen).toEqual([true, true, true, true])
    expect(h.palmSize).toBeGreaterThan(0)
  })

  it('marks a fist as closed (openScore 0)', () => {
    const h = normalizeHand(rawHand(0.48))
    expect(h.openScore).toBe(0)
    expect(h.fingerOpen).toEqual([false, false, false, false])
  })

  it('produces a palm center near the hand body', () => {
    const h = normalizeHand(rawHand(0.25))
    expect(h.palmCenter.x).toBeGreaterThan(0.45)
    expect(h.palmCenter.x).toBeLessThan(0.6)
  })

  it('keeps the wrist/palm/labels honest', () => {
    const h = normalizeHand(rawHand(0.25))
    expect(h.handedness).toBe('Right')
    expect(h.confidence).toBe(0.94)
    expect(h.wrist.x).toBe(0.5)
  })

  it('expresses open-finger threshold consistently with the constant', () => {
    const h = normalizeHand(rawHand(0.25))
    const ratio =
      Math.hypot(h.wrist.x - 0.5, h.wrist.y - 0.25) / h.palmSize
    expect(h.fingerOpen[0]).toBe(ratio >= OPEN_FINGER_RATIO)
  })
})