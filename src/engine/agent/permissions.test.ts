import { describe, expect, it } from 'vitest'
import { decidePermission, isReader, summarizeParams, errorForDecision } from './permissions'
import type { Tool } from '../../tools/Tool'

function tool(permission: Tool['permission']): Tool {
  return {
    id: `t-${permission}`,
    category: 'info',
    name: `Tool ${permission}`,
    description: 'x',
    permission,
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission: permission !== 'read_only' && permission !== 'low_risk',
    canRun: () => true,
    execute: async () => ({ ok: true, message: 'done' }),
  }
}

describe('decidePermission', () => {
  it('auto-runs read_only and low_risk tools', () => {
    expect(decidePermission(tool('read_only'), 'hi', {})).toEqual({ kind: 'auto' })
    expect(decidePermission(tool('low_risk'), 'hi', {})).toEqual({ kind: 'auto' })
  })

  it('asks for confirmation on user_confirmation tools', () => {
    const decision = decidePermission(tool('user_confirmation'), 'send it', { to: 'a' })
    expect(decision.kind).toBe('confirm')
    if (decision.kind === 'confirm') {
      expect(decision.reason).toContain('Run')
      expect(decision.impact).toContain('to=a')
    }
  })

  it('denies high_risk tools until a future policy covers them', () => {
    const decision = decidePermission(tool('high_risk'), 'go', {})
    expect(decision.kind).toBe('denied')
    if (decision.kind === 'denied') expect(decision.reason).toContain('approval')
  })

  it('denies unknown tools', () => {
    const decision = decidePermission(undefined, 'x', {})
    expect(decision.kind).toBe('denied')
  })
})

describe('isReader / summarizeParams / errorForDecision', () => {
  it('classifies reader tiers', () => {
    expect(isReader('read_only')).toBe(true)
    expect(isReader('low_risk')).toBe(true)
    expect(isReader('user_confirmation')).toBe(false)
    expect(isReader('high_risk')).toBe(false)
  })

  it('summarizes params compactly and safely', () => {
    expect(summarizeParams({ to: 'a', count: 2, loud: true, nested: { x: 1 } })).toContain('to=a')
    expect(summarizeParams({ to: 'a', count: 2, loud: true, nested: { x: 1 } })).toContain('count=2')
    expect(summarizeParams({ to: 'a', count: 2, loud: true, nested: { x: 1 } })).toContain('loud=true')
    expect(summarizeParams({})).toBe('')
  })

  it('maps decisions to failure kinds', () => {
    expect(errorForDecision({ kind: 'confirm', reason: 'r', why: 'w', impact: 'i' })).toBe('user_cancelled')
    expect(errorForDecision({ kind: 'denied', reason: 'r' })).toBe('permission_denied')
  })
})