import { describe, it, expect } from 'vitest'
import {
  normalizeRetryPolicy,
  normalizePhase6StepMeta,
  normalizePrecondition,
  normalizeContextInputs,
  normalizePhase6PlanMeta,
  clampInt,
  PHASE6_LIMITS,
} from './planTypes'

describe('Phase 6 — planTypes normalization', () => {
  it('clamps retry policy numbers and never trusts unbounded values', () => {
    expect(normalizeRetryPolicy({ retryable: true, maxRetries: 99, backoffMs: 1e9 })).toEqual({
      retryable: true,
      maxRetries: PHASE6_LIMITS.maxRetries,
      backoffMs: PHASE6_LIMITS.maxBackoffMs,
    })
    expect(normalizeRetryPolicy({ retryable: false })).toEqual({
      retryable: false,
      maxRetries: 0,
      backoffMs: 80,
    })
    expect(normalizeRetryPolicy('garbage')).toBeUndefined()
    expect(normalizeRetryPolicy({ retryable: 'yes' })).toEqual({
      retryable: false,
      maxRetries: 0,
      backoffMs: 80,
    })
  })

  it('falls back to safe defaults for unknown/untrusted policy strings', () => {
    const meta = normalizePhase6StepMeta(
      { verification: 'run-everything', failurePolicy: 'loop-forever', risk: 'extreme' },
      3,
    )
    expect(meta?.verification).toBe('tool_owned')
    expect(meta?.failurePolicy).toBe('replan')
    expect(meta?.risk).toBe('low')
  })

  it('rejects preconditions referencing out-of-range steps', () => {
    expect(normalizePrecondition({ kind: 'depends_on_success', sources: [0] }, 0)).toBeUndefined()
    expect(normalizePrecondition({ kind: 'depends_on_success', sources: [4] }, 2)).toBeUndefined()
    expect(normalizePrecondition({ kind: 'depends_on_success', sources: [] }, 2)).toBeUndefined()
  })

  it('caps precondition sources at a bounded count', () => {
    const p = normalizePrecondition({ kind: 'depends_on_success', sources: [0, 1, 2, 3, 4, 5] }, 6)
    expect(p?.sources.length).toBe(PHASE6_LIMITS.maxPreconditionSources)
  })

  it('requires a safe expect value for context_matches preconditions', () => {
    const ok = normalizePrecondition(
      { kind: 'context_matches', sources: [0], source: 0, path: 'status', expect: 'completed' },
      2,
    )
    expect(ok?.kind).toBe('context_matches')
    expect(ok?.source).toBe(0)
    expect(
      normalizePrecondition(
        { kind: 'context_matches', sources: [0], source: 0, path: 'status', expect: { a: () => 1 } },
        2,
      ),
    ).toBeUndefined()
    expect(normalizePrecondition({ kind: 'context_matches', sources: [0], source: 0 }, 2)).toBeUndefined()
  })

  it('caps context input wiring per step', () => {
    const inputs = Array.from({ length: 20 }, (_, i) => ({ name: `k${i}`, fromStep: 0, path: 'a' }))
    const result = normalizeContextInputs(inputs, 2)
    expect(result?.length).toBe(PHASE6_LIMITS.maxContextInputs)
  })

  it('drops context inputs with junk names, steps or paths', () => {
    expect(normalizeContextInputs([{ name: 3, fromStep: 0, path: 'a' }], 2)).toBeUndefined()
    expect(normalizeContextInputs([{ name: 'a', fromStep: 9, path: 'b' }], 2)).toBeUndefined()
    expect(normalizeContextInputs([{ name: 'a', fromStep: 0, path: '' }], 2)).toBeUndefined()
    expect(normalizeContextInputs('nope', 2)).toBeUndefined()
  })

  it('normalizes the full step meta deterministically', () => {
    const meta = normalizePhase6StepMeta(
      {
        expectedOutcome: '   outcome  ',
        verification: 'post_action',
        risk: 'high',
        retryPolicy: { retryable: true, maxRetries: 1, backoffMs: 200 },
        failurePolicy: 'skip_dependents',
        precondition: { kind: 'depends_on_success', sources: [0] },
        contextInputs: [{ name: 'url', fromStep: 0, path: 'result.url' }],
      },
      2,
    )
    expect(meta?.expectedOutcome).toBe('   outcome  ')
    expect(meta?.verification).toBe('post_action')
    expect(meta?.retryPolicy?.maxRetries).toBe(1)
    expect(meta?.failurePolicy).toBe('skip_dependents')
    expect(meta?.precondition?.sources).toEqual([0])
    expect(meta?.contextInputs).toHaveLength(1)
  })

  it('normalizes plan meta with bounded strings', () => {
    const meta = normalizePhase6PlanMeta({
      planId: 'p',
      goal: 'g',
      intent: 'i',
      assumptions: ['x'],
      constraints: ['y'],
      expectedOutcome: 'o',
      verificationStrategy: 'tool_owned_then_post_action',
      risk: 'medium',
    })
    expect(meta.verificationStrategy).toBe('tool_owned_then_post_action')
    expect(meta.risk).toBe('medium')
  })

  it('clampInt handles non-finite and out-of-range values', () => {
    expect(clampInt(NaN, 5, 0, 10)).toBe(5)
    expect(clampInt(Infinity, 5, 0, 10)).toBe(5)
    expect(clampInt('7', 5, 0, 10)).toBe(5)
    expect(clampInt(3.9, 5, 0, 10)).toBe(3)
  })
})