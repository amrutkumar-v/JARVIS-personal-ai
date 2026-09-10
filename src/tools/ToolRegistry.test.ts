import { describe, expect, it } from 'vitest'
import { ToolRegistry, ClockTool } from '../tools'
import type { Tool, ToolContext } from '../tools'

describe('ToolRegistry', () => {
  it('can run a real registered tool and return structured data', async () => {
    const registry = new ToolRegistry()
    registry.register(new ClockTool())

    expect(registry.size).toBe(1)
    const found = registry.findForQuery('what time is it')
    expect(found?.id).toBe('clock')

    const ctx: ToolContext = { requestId: 'test-1' }
    const result = await (found as Tool).execute({ query: 'what time is it', params: {} }, ctx)
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/local time/)
    expect(result.data).toHaveProperty('time')
  })

  it('does not match irrelevant queries', () => {
    const registry = new ToolRegistry()
    registry.register(new ClockTool())
    expect(registry.findForQuery('call john')).toBeUndefined()
  })

  it('unregister removes a bridge tool so it no longer exists or matches', () => {
    const registry = new ToolRegistry()
    registry.register(new ClockTool())
    expect(registry.get('clock')).toBeDefined()
    registry.unregister('clock')
    expect(registry.get('clock')).toBeUndefined()
    expect(registry.size).toBe(0)
    expect(registry.findForQuery('what time is it')).toBeUndefined()
  })
})