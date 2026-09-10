import { describe, expect, it } from 'vitest'
import { REPLAN_LIMITS, requestSignature, planSignature, identicalReplan, repeatedFailureDetected } from './replan'

/**
 * Phase 2.2 — replan guards. Pure hashes over (toolId + stable payload) and
 * consecutive-history checks bound the replan loop while never touching
 * budgets, evidence or the plan.
 */
describe('Phase 2.2 — replan guards (pure)', () => {
  it('signatures are deterministic and payload-sensitive', () => {
    expect(requestSignature('desktop.click', { window_id: '1', x: 1, y: 1 })).toBe(
      requestSignature('desktop.click', { window_id: '1', x: 1, y: 1 }),
    )
    expect(requestSignature('desktop.click', { x: 1, y: 1, window_id: '1' })).toBe(
      requestSignature('desktop.click', { window_id: '1', x: 1, y: 1 }),
    )
    expect(requestSignature('desktop.click', { window_id: '1', x: 1, y: 1 })).not.toBe(
      requestSignature('desktop.click', { window_id: '1', x: 2, y: 2 }),
    )
  })

  it('plan signatures distinguish step ORDER and payload', () => {
    const a = [{ toolId: 'desktop.click', payload: { x: 1 } }, { toolId: 'notes.get' }]
    const b = [{ toolId: 'desktop.click', payload: { x: 1 } }, { toolId: 'notes.get' }]
    const c = [{ toolId: 'notes.get' }, { toolId: 'desktop.click', payload: { x: 1 } }]
    expect(planSignature(a)).toBe(planSignature(b))
    expect(planSignature(a)).not.toBe(planSignature(c))
  })

  it('identicalReplan detects a previously failed round signature', () => {
    const sig = planSignature([{ toolId: 'desktop.click', payload: { x: 1 } }])
    expect(identicalReplan([sig], sig)).toBe(true)
    expect(identicalReplan([sig], planSignature([{ toolId: 'desktop.click', payload: { x: 2 } }]))).toBe(false)
    expect(identicalReplan([], sig)).toBe(false)
  })

  it('repeatedFailureDetected requires MAX_IDENTICAL_FAILURES consecutive failures', () => {
    const sig = requestSignature('desktop.click', { x: 1 })
    expect(repeatedFailureDetected([sig], sig)).toBe(false)
    expect(repeatedFailureDetected([sig, sig], sig)).toBe(true)
    // An intervening DISTINCT failure breaks the consecutive run.
    expect(repeatedFailureDetected([sig, requestSignature('notes.get', {}), sig], sig)).toBe(false)
  })

  it('constants are the documented small bounds', () => {
    expect(REPLAN_LIMITS.MAX_IDENTICAL_REPLANS).toBe(1)
    expect(REPLAN_LIMITS.MAX_IDENTICAL_FAILURES).toBe(2)
  })
})