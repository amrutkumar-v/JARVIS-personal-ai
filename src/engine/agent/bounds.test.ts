import { describe, expect, it } from 'vitest'
import { evaluateLoopState, isRepeatedActionBlocked, stableKey } from './bounds'
import { AGENT_LIMITS } from '../limits'

describe('evaluateLoopState', () => {
  const base = {
    round: 0,
    totalSteps: 0,
    deadline: Date.now() + 10_000,
    now: Date.now(),
    cancelled: false,
  }

  it('continues while inside every bound', () => {
    expect(evaluateLoopState(base)).toBe('continue')
  })

  it('stops when cancelled — regardless of budget', () => {
    expect(evaluateLoopState({ ...base, cancelled: true })).toBe('cancelled')
  })

  it('stops when the wall-clock deadline passes', () => {
    expect(evaluateLoopState({ ...base, now: base.deadline + 1 })).toBe('limit')
  })

  it('stops at the step cap', () => {
    expect(evaluateLoopState({ ...base, totalSteps: AGENT_LIMITS.MAX_AGENT_STEPS })).toBe('limit')
  })

  it('stops at the round cap', () => {
    expect(evaluateLoopState({ ...base, round: AGENT_LIMITS.MAX_TOOL_ROUNDS })).toBe('limit')
  })

  it('honours overrides', () => {
    expect(evaluateLoopState({ ...base, maxRounds: 1, round: 1 })).toBe('limit')
    expect(evaluateLoopState({ ...base, maxSteps: 2, totalSteps: 2 })).toBe('limit')
  })
})

describe('stableKey', () => {
  it('is order-insensitive', () => {
    expect(stableKey({ a: 1, b: 2 })).toBe(stableKey({ b: 2, a: 1 }))
  })

  it('nests arrays and objects deterministically', () => {
    expect(stableKey({ list: [3, 1, 2], x: { z: 1, y: 2 } })).toBe(
      stableKey({ x: { y: 2, z: 1 }, list: [3, 1, 2] }),
    )
  })

  it('never throws on weird payloads', () => {
    const circular: Record<string, unknown> = { loop: {} }
    circular.loop = circular
    expect(stableKey(circular)).toBe('<unserializable>')
  })
})

describe('isRepeatedActionBlocked', () => {
  const prior = [
    { toolId: 'send', input: { to: 'a' } },
    { toolId: 'send', input: { to: 'a' } },
    { toolId: 'send', input: { to: 'a' } },
  ]

  it('allows the first, second and third identical execution', () => {
    expect(isRepeatedActionBlocked(prior.slice(0, 0), 'send', { to: 'a' })).toBe(false)
    expect(isRepeatedActionBlocked(prior.slice(0, 1), 'send', { to: 'a' })).toBe(false)
    expect(isRepeatedActionBlocked(prior.slice(0, 2), 'send', { to: 'a' })).toBe(false)
  })

  it('blocks the fourth identical execution', () => {
    expect(isRepeatedActionBlocked(prior, 'send', { to: 'a' })).toBe(true)
  })

  it('does not block a different payload or tool', () => {
    expect(isRepeatedActionBlocked(prior, 'send', { to: 'b' })).toBe(false)
    expect(isRepeatedActionBlocked(prior, 'other', { to: 'a' })).toBe(false)
  })

  it('defaults to the AGENT_LIMITS cap and honours a custom cap', () => {
    expect(isRepeatedActionBlocked(prior, 'send', { to: 'a' }, AGENT_LIMITS.MAX_REPEATED_ACTIONS)).toBe(true)
    expect(isRepeatedActionBlocked(prior, 'send', { to: 'a' }, 5)).toBe(false)
    expect(isRepeatedActionBlocked(prior, 'send', { to: 'a' }, 0)).toBe(false)
  })
})