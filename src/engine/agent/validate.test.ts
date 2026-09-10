import { describe, expect, it } from 'vitest'
import { validateToolArguments } from './validate'
import type { Tool } from '../../tools/Tool'

const tool: Tool = {
  id: 'greeter',
  category: 'compute',
  name: 'Greeter',
  description: 'greets',
  permission: 'low_risk',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      count: { type: 'number' },
      loud: { type: 'boolean' },
    },
    required: ['name'],
  },
  requiresPermission: false,
  canRun: () => true,
  execute: async () => ({ ok: true, message: 'hi' }),
}

describe('validateToolArguments', () => {
  it('accepts fully valid arguments', () => {
    expect(validateToolArguments(tool, { name: 'Gina', count: 3, loud: true })).toEqual({ ok: true })
  })

  it('accepts extra keys beyond the contract', () => {
    expect(validateToolArguments(tool, { name: 'Gina', unknown: 'fine' })).toEqual({ ok: true })
  })

  it('rejects a missing required argument', () => {
    const result = validateToolArguments(tool, {})
    expect(result).not.toEqual({ ok: true })
    expect('reason' in result && result.reason).toContain('name')
  })

  it('rejects empty-string required values as missing', () => {
    const result = validateToolArguments(tool, { name: '' })
    expect('ok' in result && result.ok).toBe(false)
  })

  it('rejects wrong scalar types', () => {
    expect('ok' in validateToolArguments(tool, { name: 'a', count: 'not-a-number' }) && (validateToolArguments(tool, { name: 'a', count: 'x' }) as { ok: false }).ok).toBe(false)
    expect((validateToolArguments(tool, { name: 42 }) as { ok: false }).ok).toBe(false)
    expect((validateToolArguments(tool, { name: 'a', loud: 'yes' }) as { ok: false }).ok).toBe(false)
  })

  it('rejects unknown tools and missing schemas', () => {
    expect((validateToolArguments(undefined, {}) as { ok: false }).ok).toBe(false)
    const noSchema: Tool = { ...tool, inputSchema: undefined as never }
    expect((validateToolArguments(noSchema, { name: 'a' }) as { ok: false }).ok).toBe(false)
  })

  it('treats missing payload as an empty object', () => {
    const result = validateToolArguments(tool, undefined as never)
    expect((result as { ok: false }).ok).toBe(false)
  })
})