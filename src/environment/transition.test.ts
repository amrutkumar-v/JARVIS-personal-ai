import { describe, expect, it } from 'vitest'
import { pickTransition, resolveTransitionTimings } from './transition'
import type { TransitionKind } from './transition'
import type { VisualEnvironmentId } from './types'

const ALL: readonly VisualEnvironmentId[] = [
  'arc',
  'astra',
  'control',
  'space',
  'tunnel',
  'neural',
]

describe('pickTransition', () => {
  it('returns none for the same environment', () => {
    for (const id of ALL) {
      expect(pickTransition(id, id)).toBe('none')
    }
  })

  it('uses radial when entering or leaving the reactor', () => {
    expect(pickTransition('arc', 'astra')).toBe('radial')
    expect(pickTransition('astra', 'arc')).toBe('radial')
    expect(pickTransition('arc', 'tunnel')).toBe('radial')
    expect(pickTransition('control', 'arc')).toBe('radial')
  })

  it('uses hud-scan between the tactical panels', () => {
    expect(pickTransition('astra', 'control')).toBe('hud-scan')
    expect(pickTransition('control', 'astra')).toBe('hud-scan')
  })

  it('uses dissolve between the deep-field corridors', () => {
    expect(pickTransition('space', 'tunnel')).toBe('dissolve')
    expect(pickTransition('tunnel', 'space')).toBe('dissolve')
  })

  it('cross-fades adjacent unrelated environments', () => {
    expect(pickTransition('control', 'space')).toBe('fade')
  })

  it('sweeps across distant unrelated environments', () => {
    expect(pickTransition('space', 'astra')).toBe('sweep')
    expect(pickTransition('tunnel', 'control')).toBe('sweep')
  })

  it('always picks a known kind for every pair', () => {
    const kinds: readonly TransitionKind[] = [
      'none',
      'fade',
      'radial',
      'sweep',
      'hud-scan',
      'dissolve',
    ]
    for (const from of ALL) {
      for (const to of ALL) {
        expect(kinds).toContain(pickTransition(from, to))
      }
    }
  })
})

describe('resolveTransitionTimings', () => {
  it('zeroes timings for none', () => {
    expect(resolveTransitionTimings('none')).toEqual({
      inMs: 0,
      holdMs: 0,
      outMs: 0,
      totalMs: 0,
    })
  })

  it('produces positive, short, sub-second transitions', () => {
    for (const kind of ['fade', 'radial', 'sweep', 'hud-scan', 'dissolve'] as const) {
      const t = resolveTransitionTimings(kind)
      expect(t.inMs).toBeGreaterThan(0)
      expect(t.holdMs).toBeGreaterThan(0)
      expect(t.outMs).toBeGreaterThan(0)
      expect(t.totalMs).toBe(t.inMs + t.holdMs + t.outMs)
      expect(t.totalMs).toBeLessThan(1200)
    }
  })
})