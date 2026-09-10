import { describe, expect, it } from 'vitest'
import { GOAL_LIMITS, recoveryBudgetExceeded, taskBudgetExceeded, taskBudgetRemaining } from './budget'

describe('Phase 2.0 — goal task budget (pure)', () => {
  it('uses a conservative initial ceiling separate from the agent step cap', () => {
    expect(GOAL_LIMITS.maxTaskSteps).toBeGreaterThanOrEqual(2)
    expect(GOAL_LIMITS.maxTaskSteps).toBe(10)
    expect(GOAL_LIMITS.maxRecoveryAttempts).toBe(2)
  })

  it('exceeds only at the configured ceiling', () => {
    expect(taskBudgetExceeded(0)).toBe(false)
    expect(taskBudgetExceeded(9)).toBe(false)
    expect(taskBudgetExceeded(10)).toBe(true)
    expect(taskBudgetExceeded(11)).toBe(true)
  })

  it('honors a custom ceiling (admin-configurable, never model-written)', () => {
    expect(taskBudgetExceeded(2, 2)).toBe(true)
    expect(taskBudgetExceeded(1, 2)).toBe(false)
  })

  it('reports remaining headroom without going negative', () => {
    expect(taskBudgetRemaining(6)).toBe(4)
    expect(taskBudgetRemaining(10)).toBe(0)
    expect(taskBudgetRemaining(12)).toBe(0)
  })

  it('allows a bounded number of recoveries, then stops', () => {
    expect(recoveryBudgetExceeded(0)).toBe(false)
    expect(recoveryBudgetExceeded(2)).toBe(false)
    expect(recoveryBudgetExceeded(3)).toBe(true)
    expect(recoveryBudgetExceeded(3, GOAL_LIMITS.maxRecoveryAttempts)).toBe(true)
    expect(recoveryBudgetExceeded(3, 5)).toBe(false)
  })
})