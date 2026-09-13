import { describe, expect, it } from 'vitest'
import { computeDrive, normalizeVisualState, speechEnergy } from './visualState'
import type { EngineSignal } from './visualState'
import type { VisualState } from './types'

function signal(overrides: Partial<EngineSignal> = {}): EngineSignal {
  return {
    status: 'idle',
    isSpeaking: false,
    goalRun: null,
    backendPhase: 'idle',
    ...overrides,
  }
}

describe('normalizeVisualState — engine status mapping', () => {
  const cases: Array<[string, VisualState]> = [
    ['idle', 'idle'],
    ['listening', 'listening'],
    ['thinking', 'thinking'],
    ['understanding', 'thinking'],
    ['planning', 'planning'],
    ['executing', 'executing'],
    ['observing', 'observing'],
    ['verifying', 'verifying'],
    ['waiting_for_confirmation', 'waiting'],
    ['recovering', 'recovering'],
    ['retrying', 'recovering'],
    ['success', 'completed'],
    ['warning', 'recovering'],
    ['error', 'failed'],
    ['failed', 'failed'],
    ['cancelling', 'cancelled'],
    ['cancelled', 'cancelled'],
  ]

  for (const [status, expected] of cases) {
    it(`maps ${status} → ${expected}`, () => {
      expect(normalizeVisualState(signal({ status: status as EngineSignal['status'], backendPhase: 'connected' }))).toBe(expected)
    })
  }

  it('keeps the base state while really speaking', () => {
    expect(normalizeVisualState(signal({ status: 'executing', isSpeaking: true }))).toBe('executing')
    expect(normalizeVisualState(signal({ status: 'speaking' }))).toBe('idle')
  })
})

describe('normalizeVisualState — goal verdict precedence', () => {
  const runWith = (verdict: string) =>
    signal({ goalRun: { task: { status: verdict } } as EngineSignal['goalRun'] })

  it('applies terminal goal verdicts over the transient status', () => {
    expect(normalizeVisualState(runWith('completed'))).toBe('completed')
    expect(normalizeVisualState(runWith('failed'))).toBe('failed')
    expect(normalizeVisualState(runWith('unverified'))).toBe('failed')
    expect(normalizeVisualState(runWith('blocked'))).toBe('failed')
    expect(normalizeVisualState(runWith('cancelled'))).toBe('cancelled')
  })

  it('ignores unfinished (planning) verdicts', () => {
    expect(normalizeVisualState(runWith('planning'))).toBe('idle')
  })

  it('ignores live (executing/recovering) verdict markers', () => {
    expect(normalizeVisualState(runWith('executing'))).toBe('idle')
    expect(normalizeVisualState(runWith('recovering'))).toBe('idle')
  })
})

describe('normalizeVisualState — backend reconnect override', () => {
  it('flags recovery while the backend reconnects behind an idle engine', () => {
    for (const phase of ['connecting', 'waiting', 'giving_up'] as const) {
      expect(normalizeVisualState(signal({ status: 'idle', backendPhase: phase }))).toBe('recovering')
    }
  })

  it('keeps idle when the backend is connected or unstarted', () => {
    expect(normalizeVisualState(signal({ status: 'idle', backendPhase: 'idle' }))).toBe('idle')
    expect(normalizeVisualState(signal({ status: 'idle', backendPhase: 'connected' }))).toBe('idle')
  })

  it('never overrides a genuinely active engine state', () => {
    expect(normalizeVisualState(signal({ status: 'executing', backendPhase: 'waiting' }))).toBe('executing')
  })
})

describe('computeDrive', () => {
  it('orders energy by intensity (idle < observing < executing)', () => {
    const idle = computeDrive('idle', false, null, 'idle', false, 0)
    const observe = computeDrive('observing', false, null, 'idle', false, 0)
    const execute = computeDrive('executing', false, null, 'idle', false, 0)
    expect(idle.energy).toBeLessThan(observe.energy)
    expect(observe.energy).toBeLessThan(execute.energy)
  })

  it('scales motion down for reduced-motion users', () => {
    const normal = computeDrive('executing', false, null, 'idle', false, 0)
    const reduced = computeDrive('executing', false, null, 'idle', true, 0)
    expect(reduced.speed).toBeLessThan(normal.speed)
    expect(reduced.pulse).toBeLessThan(normal.pulse)
  })

  it('flags speaking only when the engine reports real speech', () => {
    expect(computeDrive('idle', true, null, 'idle', false, 0).speaking).toBe(true)
    expect(computeDrive('speaking', false, null, 'idle', false, 0).speaking).toBe(true)
    expect(computeDrive('executing', false, null, 'idle', false, 0).speaking).toBe(false)
  })

  it('returns zero speech energy when not speaking', () => {
    expect(computeDrive('idle', false, null, 'idle', false, 1).speech).toBe(0)
  })

  it('produces bounded deterministic speech energy when speaking', () => {
    for (const t of [0, 0.1, 0.7, 2, 9]) {
      const d = computeDrive('executing', true, null, 'idle', false, t)
      expect(d.speech).toBeGreaterThanOrEqual(0)
      expect(d.speech).toBeLessThanOrEqual(1)
    }
  })

  it('carries the real status through unchanged', () => {
    expect(computeDrive('verifying', false, null, 'idle', false, 0).status).toBe('verifying')
  })
})

describe('speechEnergy', () => {
  it('is bounded to [0, 1]', () => {
    for (let i = 0; i < 40; i++) {
      const v = speechEnergy(i * 0.5)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('is deterministic for a given time', () => {
    expect(speechEnergy(1.234)).toBe(speechEnergy(1.234))
  })
})