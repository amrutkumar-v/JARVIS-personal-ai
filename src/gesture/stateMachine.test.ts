import { describe, expect, it } from 'vitest'
import { GestureGate } from './stateMachine'
import type { GestureCandidate } from './types'

const CAND: GestureCandidate = { gesture: 'crush', confidence: 0.9 }

describe('GestureGate', () => {
  it('accepts a confident candidate and advances to fired', () => {
    const gate = new GestureGate(1000)
    const intent = gate.accept([CAND], 1000, 1, 'good', 0.6)
    expect(intent).not.toBeNull()
    expect(intent?.gesture).toBe('crush')
    expect(gate.phase).toBe('fired')
  })

  it('rejects candidates below the confidence floor', () => {
    const gate = new GestureGate()
    const intent = gate.accept([{ gesture: 'crush', confidence: 0.3 }], 1000, 1, 'good', 0.6)
    expect(intent).toBeNull()
  })

  it('applies the per-gesture cooldown after firing', () => {
    const gate = new GestureGate(1000)
    expect(gate.accept([CAND], 1000, 1, 'good', 0.6)).not.toBeNull()
    expect(gate.accept([CAND], 1100, 1, 'good', 0.6)).toBeNull()
    expect(gate.phase).toBe('cooldown')
    expect(gate.accept([CAND], 2200, 1, 'good', 0.6)).not.toBeNull()
  })

  it('cooldown is per-gesture: other gestures are not blocked', () => {
    const gate = new GestureGate(1000)
    gate.accept([{ gesture: 'crush', confidence: 0.9 }], 1000, 1, 'good', 0.6)
    const intent = gate.accept([{ gesture: 'theme_change', confidence: 0.9 }], 1050, 1, 'good', 0.6)
    expect(intent?.gesture).toBe('theme_change')
  })

  it('selects the highest-confidence candidate', () => {
    const gate = new GestureGate(100) // explicit window so 1000ms timestamps never get blocked by default 1400
    const intent = gate.accept(
      [{ gesture: 'zoom_in', confidence: 0.7 }, { gesture: 'crush', confidence: 0.95 }],
      1000,
      1,
      'good',
      0.6,
    )
    expect(intent?.gesture).toBe('crush')
  })

  it('returns to unknown when no hands are present', () => {
    const gate = new GestureGate(100)
    gate.accept([CAND], 1000, 2, 'good', 0.6)
    gate.accept([], 2000, 0, 'none', 0.6)
    expect(gate.phase).toBe('unknown')
  })
})