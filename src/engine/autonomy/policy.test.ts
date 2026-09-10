import { describe, expect, it } from 'vitest'
import {
  AUTONOMY_LEVELS,
  AUTONOMY_LEVEL_LABELS,
  defaultAutonomy,
  isAutonomyLevel,
  autonomyAllowsAuto,
} from './policy'
import type { ToolCategory, ToolPermission } from '../../tools/Tool'

function tool(permission: ToolPermission, category: ToolCategory) {
  return { permission, category } as { permission: ToolPermission; category: ToolCategory }
}

describe('autonomy/policy', () => {
  it('exposes the closed level set with an honest default of "assisted"', () => {
    expect(AUTONOMY_LEVELS).toEqual(['assisted', 'safe_automation', 'controlled_autonomy'])
    expect(defaultAutonomy()).toBe('assisted')
    expect(isAutonomyLevel('assisted')).toBe(true)
    expect(isAutonomyLevel('safe_automation')).toBe(true)
    expect(isAutonomyLevel('controlled_autonomy')).toBe(true)
    expect(isAutonomyLevel('whatever')).toBe(false)
    expect(Object.keys(AUTONOMY_LEVEL_LABELS)).toEqual(AUTONOMY_LEVELS)
  })

  it('assisted never waives any confirmation', () => {
    expect(autonomyAllowsAuto('assisted', tool('user_confirmation', 'memory'))).toBe(false)
    expect(autonomyAllowsAuto('assisted', tool('user_confirmation', 'info'))).toBe(false)
  })

  it('safe_automation waives confirmations only for bounded local categories', () => {
    expect(autonomyAllowsAuto('safe_automation', tool('user_confirmation', 'info'))).toBe(true)
    expect(autonomyAllowsAuto('safe_automation', tool('user_confirmation', 'memory'))).toBe(true)
    expect(autonomyAllowsAuto('safe_automation', tool('user_confirmation', 'compute'))).toBe(true)
  })

  it('the hard floor is NEVER bypassed, even at the max autonomy level', () => {
    for (const category of ['communication', 'system', 'future'] as ToolCategory[]) {
      expect(autonomyAllowsAuto('controlled_autonomy', tool('user_confirmation', category))).toBe(false)
      expect(autonomyAllowsAuto('safe_automation', tool('user_confirmation', category))).toBe(false)
    }
  })

  it('only the user_confirmation tier is deratable; readers and high_risk are untouched', () => {
    expect(autonomyAllowsAuto('controlled_autonomy', tool('read_only', 'info'))).toBe(false)
    expect(autonomyAllowsAuto('controlled_autonomy', tool('low_risk', 'memory'))).toBe(false)
    expect(autonomyAllowsAuto('controlled_autonomy', tool('high_risk', 'info'))).toBe(false)
  })
})