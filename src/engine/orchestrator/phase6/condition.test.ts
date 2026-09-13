import { describe, it, expect } from 'vitest'
import { evalPrecondition, decideStepReadiness, deepEqualValue } from './condition'
import type { Phase6Precondition } from './planTypes'

const steps: Array<{ state: string }> = [
  { state: 'verified' },
  { state: 'executed' },
  { state: 'skipped' },
  { state: 'failed' },
  { state: 'blocked' },
  { state: 'cancelled' },
  { state: 'planned' },
]

const lookup = (_i: number, _p?: string): undefined => undefined

describe('Phase 6 — condition + readiness gates', () => {
  it('depends_on_success passes for verified/executed sources', () => {
    const p: Phase6Precondition = { kind: 'depends_on_success', sources: [0, 1] }
    expect(evalPrecondition(p, steps, lookup).passed).toBe(true)
    const p2: Phase6Precondition = { kind: 'depends_on_success', sources: [0] }
    expect(evalPrecondition(p2, steps, lookup)).toMatchObject({ passed: true })
  })

  it('depends_on_success fails for uncompleted sources', () => {
    for (const idx of [2, 3, 4, 5, 6]) {
      const p: Phase6Precondition = { kind: 'depends_on_success', sources: [idx] }
      expect(evalPrecondition(p, steps, lookup).passed).toBe(false)
    }
    expect(evalPrecondition({ kind: 'depends_on_success', sources: [] }, steps, lookup).passed).toBe(false)
    expect(evalPrecondition({ kind: 'depends_on_success', sources: [0] }, [], lookup).passed).toBe(false)
    const pOut: Phase6Precondition = { kind: 'depends_on_success', sources: [0, 5] }
    expect(evalPrecondition(pOut, steps, lookup).passed).toBe(false)
  })

  it('context_matches compares deep values through the lookup', () => {
    const p: Phase6Precondition = {
      kind: 'context_matches',
      sources: [0],
      source: 0,
      path: 'status',
      expect: 'completed',
    }
    expect(evalPrecondition(p, steps, () => 'completed')).toMatchObject({ passed: true })
    expect(evalPrecondition(p, steps, () => 'running')).toMatchObject({ passed: false })
    expect(evalPrecondition(p, steps, () => undefined)).toMatchObject({ passed: false })
  })

  it('decideStepReadiness blocks when dependencies failed/skipped/blocked/cancelled/pending', () => {
    for (const dep of [2, 3, 4, 5, 6]) {
      const d = decideStepReadiness(7, [dep], undefined, steps, lookup)
      expect(d.gate).toBe('block')
      expect(d.reason.length).toBeGreaterThan(0)
    }
  })

  it('decideStepReadiness skips when a precondition fails', () => {
    const p: Phase6Precondition = {
      kind: 'context_matches',
      sources: [0],
      source: 0,
      path: 'status',
      expect: 'ready',
    }
    const d = decideStepReadiness(7, undefined, p, steps, () => 'running')
    expect(d.gate).toBe('skip')
  })

  it('decideStepReadiness runs when gates pass', () => {
    const p: Phase6Precondition = { kind: 'depends_on_success', sources: [0] }
    expect(decideStepReadiness(7, undefined, undefined, steps, lookup).gate).toBe('run')
    expect(decideStepReadiness(7, [0], p, steps, lookup).gate).toBe('run')
  })

  it('blocks on missing dependency entries', () => {
    const d = decideStepReadiness(7, [9], undefined, steps, lookup)
    expect(d.gate).toBe('block')
  })

  it('deepEqualValue handles nested scalar structures', () => {
    expect(deepEqualValue({ a: [1, 2, { b: true }] }, { a: [1, 2, { b: true }] })).toBe(true)
    expect(deepEqualValue({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false)
    expect(deepEqualValue([1, 2], {})).toBe(false)
    expect(deepEqualValue(5, '5')).toBe(false)
    expect(deepEqualValue(null, undefined)).toBe(false)
    expect(deepEqualValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(deepEqualValue({ a: 1 }, { a: 2 })).toBe(false)
  })
})