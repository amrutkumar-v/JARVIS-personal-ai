import { describe, expect, it } from 'vitest'
import { visualBudgetBucket, visualBudgetExceeded, visualBudgetLabel } from './budget'
import { VISUAL_LIMITS } from './limits'

const VISUAL_IDS = ['desktop.visualInspect', 'desktop.visualClick', 'desktop.visualType']

describe('visualBudgetBucket', () => {
  it.each(VISUAL_IDS)('maps %s to the visual bucket', (id) => {
    expect(visualBudgetBucket(id)).toBe('visual')
  })

  it('leaves non-visual ids bucketless', () => {
    expect(visualBudgetBucket('desktop.click')).toBeUndefined()
    expect(visualBudgetBucket('desktop.key_press')).toBeUndefined()
    expect(visualBudgetBucket('filesystem.read')).toBeUndefined()
    expect(visualBudgetBucket('unknown')).toBeUndefined()
  })
})

describe('visualBudgetExceeded', () => {
  it('allows actions below the ceiling', () => {
    expect(visualBudgetExceeded(0)).toBe(false)
    expect(visualBudgetExceeded(VISUAL_LIMITS.MAX_VISUAL_ACTIONS_PER_RUN - 1)).toBe(false)
  })

  it('blocks at and above the ceiling', () => {
    expect(visualBudgetExceeded(VISUAL_LIMITS.MAX_VISUAL_ACTIONS_PER_RUN)).toBe(true)
    expect(visualBudgetExceeded(VISUAL_LIMITS.MAX_VISUAL_ACTIONS_PER_RUN + 5)).toBe(true)
  })
})

describe('visualBudgetLabel', () => {
  it('labels the budget', () => {
    expect(visualBudgetLabel()).toBe('actions')
  })
})