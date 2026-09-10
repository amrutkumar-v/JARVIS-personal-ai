import { describe, it, expect } from 'vitest'
import { arcReactorPresentation, ARC_REACTOR_SPEECH_BOUNDS } from './arcReactorModel'
import { JARVIS_THEMES, DEFAULT_THEME, isJarvisTheme, THEME_META } from '../../themes'

describe('arcReactorPresentation', () => {
  it('maps every engine status to a bounded variant + label', () => {
    const statuses = [
      'idle',
      'listening',
      'understanding',
      'planning',
      'executing',
      'observing',
      'verifying',
      'speaking',
      'waiting_for_confirmation',
      'success',
      'warning',
      'error',
      'failed',
      'cancelled',
    ] as const
    for (const s of statuses) {
      const p = arcReactorPresentation(s, false)
      expect(p.variant).toBeTruthy()
      expect(p.label).toBeTruthy()
    }
  })

  it('flags speaking only on real speaking state', () => {
    expect(arcReactorPresentation('executing', false).speaking).toBe(false)
    expect(arcReactorPresentation('executing', true).speaking).toBe(true)
    expect(arcReactorPresentation('speaking', false).speaking).toBe(true)
  })

  it('binds speech pulse within safe motion bounds', () => {
    expect(ARC_REACTOR_SPEECH_BOUNDS.min).toBeGreaterThan(0)
    expect(ARC_REACTOR_SPEECH_BOUNDS.max).toBeGreaterThan(ARC_REACTOR_SPEECH_BOUNDS.min)
  })
})

describe('themes', () => {
  it('exposes exactly the five JARVIS themes', () => {
    expect(JARVIS_THEMES).toEqual(['classic', 'cyber', 'stealth', 'holographic', 'minimal'])
  })

  it('has a valid default', () => {
    expect(DEFAULT_THEME).toBe('classic')
  })

  it('recognises theme ids and rejects others', () => {
    expect(isJarvisTheme('cyber')).toBe(true)
    expect(isJarvisTheme('neon')).toBe(false)
  })

  it('describes every theme', () => {
    for (const t of JARVIS_THEMES) {
      expect(THEME_META[t].label.length).toBeGreaterThan(0)
    }
  })
})