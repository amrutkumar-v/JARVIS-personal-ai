import { describe, expect, it } from 'vitest'
import { classifyRecovery, consumesBudget } from './recovery'

/**
 * Phase 2.2 — deterministic failure classification. The mapping is pure and
 * total: verification signals dominate, then cancellation/budget/permission,
 * then the error kind. Budget-consuming actions are only `replan`/`reobserve`.
 */
describe('Phase 2.2 — recovery classification (pure)', () => {
  it('verification signals dominate and map to reobserve when a re-observer exists', () => {
    for (const kind of ['verification', 'partial'] as const) {
      const decision = classifyRecovery({ observationKind: kind, errorKind: 'tool_failure', canReobserve: true })
      expect(decision.action).toBe('reobserve')
      expect(decision.kind).toBe('stale_observation')
      expect(decision.consumesBudget).toBe(true)
    }
  })

  it('verification signals map to replan when no re-observer exists', () => {
    const decision = classifyRecovery({ observationKind: 'verification', errorKind: 'tool_failure', canReobserve: false })
    expect(decision.action).toBe('replan')
    expect(decision.kind).toBe('verification_failure')
    expect(decision.consumesBudget).toBe(true)
  })

  it('cancellation, budget exhaustion and permission denial are STOP (free)', () => {
    expect(classifyRecovery({ cancelled: true }).action).toBe('stop')
    expect(classifyRecovery({ budgetExhausted: true }).action).toBe('stop')
    expect(classifyRecovery({ errorKind: 'permission_denied' })).toMatchObject({ action: 'stop', kind: 'permission_denied' })
    expect(classifyRecovery({ errorKind: 'user_cancelled' }).action).toBe('stop')
    expect(classifyRecovery({ errorKind: 'orchestration_limit' }).action).toBe('stop')
  })

  it('a plan_rejected verdict with a budget code is a hard stop that never consumes replans', () => {
    expect(classifyRecovery({ errorKind: 'plan_rejected', planCode: 'budget' })).toMatchObject({
      action: 'stop',
      kind: 'budget_exhausted',
      consumesBudget: false,
    })
  })

  it('a plan_rejected availability veto maps to a bounded replan', () => {
    expect(classifyRecovery({ errorKind: 'plan_rejected', planCode: 'unavailable' })).toMatchObject({
      action: 'replan',
      kind: 'unsupported_capability',
      consumesBudget: true,
    })
  })

  it('Phase 2.3 — an unregistered or unimplementable capability name also maps to a bounded replan', () => {
    expect(classifyRecovery({ errorKind: 'plan_rejected', planCode: 'capability_unregistered' })).toMatchObject({
      action: 'replan',
      kind: 'unsupported_capability',
      consumesBudget: true,
    })
    expect(classifyRecovery({ errorKind: 'plan_rejected', planCode: 'capability_unavailable' })).toMatchObject({
      action: 'replan',
      kind: 'unsupported_capability',
      consumesBudget: true,
    })
  })

  it('other plan rejections and invalid input map to a bounded replan', () => {
    expect(classifyRecovery({ errorKind: 'plan_rejected' }).action).toBe('replan')
    expect(classifyRecovery({ errorKind: 'invalid_input' }).action).toBe('replan')
  })

  it('retryable provider/timeout/tool failures retry (free); non-retryable ones replan', () => {
    expect(classifyRecovery({ errorKind: 'provider_failure', retryable: true })).toMatchObject({ action: 'retry', consumesBudget: false })
    expect(classifyRecovery({ errorKind: 'timeout', retryable: true })).toMatchObject({ action: 'retry', consumesBudget: false })
    expect(classifyRecovery({ errorKind: 'tool_failure', retryable: true })).toMatchObject({ action: 'retry', consumesBudget: false })
    expect(classifyRecovery({ errorKind: 'provider_failure', retryable: false }).action).toBe('replan')
    expect(classifyRecovery({ errorKind: 'timeout', retryable: false }).action).toBe('replan')
    expect(classifyRecovery({ errorKind: 'tool_failure', retryable: false }).action).toBe('replan')
  })

  it('unknown error kinds are a fatal stop (total mapping)', () => {
    expect(classifyRecovery({})).toMatchObject({ kind: 'fatal', action: 'stop', consumesBudget: false })
  })

  it('only replan/reobserve consume a budget unit', () => {
    expect(consumesBudget('retry')).toBe(false)
    expect(consumesBudget('stop')).toBe(false)
    expect(consumesBudget('reobserve')).toBe(true)
    expect(consumesBudget('replan')).toBe(true)
  })
})