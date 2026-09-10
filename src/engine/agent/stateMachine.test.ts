import { describe, expect, it } from 'vitest'
import { AgentStateMachine, canTransition, stateTerminal } from './stateMachine'

describe('stateMachine', () => {
  it('goes through the happy path idle → understanding → planning → executing → observing → verifying → completed', () => {
    const sm = new AgentStateMachine()
    expect(sm.state).toBe('idle')
    expect(sm.active).toBe(true)

    expect(sm.transition('understanding')).toBe(true)
    expect(sm.transition('planning')).toBe(true)
    expect(sm.transition('executing')).toBe(true)
    expect(sm.transition('observing')).toBe(true)
    expect(sm.transition('planning')).toBe(true)
    expect(sm.transition('verifying')).toBe(true)
    expect(sm.transition('completed')).toBe(true)

    expect(stateTerminal(sm.state)).toBe(true)
    expect(sm.active).toBe(false)
  })

  it('allows planning to finish directly without tools (verifying → completed)', () => {
    const sm = new AgentStateMachine()
    sm.transition('understanding')
    expect(sm.transition('planning')).toBe(true)
    expect(sm.transition('verifying')).toBe(true)
    expect(sm.transition('completed')).toBe(true)
  })

  it('allows planning to fail or be cancelled', () => {
    const failed = new AgentStateMachine()
    failed.transition('understanding')
    expect(failed.transition('planning')).toBe(true)
    expect(failed.transition('failed')).toBe(true)

    const cancelled = new AgentStateMachine()
    cancelled.transition('understanding')
    cancelled.transition('planning')
    expect(cancelled.transition('cancelled')).toBe(true)
  })

  it('rejects illegal transitions', () => {
    const sm = new AgentStateMachine()
    expect(sm.transition('completed')).toBe(false)
    expect(sm.transition('executing')).toBe(false)

    sm.transition('understanding')
    expect(sm.transition('executing')).toBe(false) // understanding must go to planning
    expect(sm.transition('cancelled')).toBe(true)
    expect(sm.transition('failed')).toBe(false) // terminal is final
  })

  it('never leaves a terminal state', () => {
    const sm = new AgentStateMachine()
    sm.transition('understanding')
    sm.transition('planning')
    sm.transition('verifying')
    sm.transition('completed')
    for (const s of ['understanding', 'planning', 'executing', 'observing', 'verifying', 'failed', 'cancelled'] as const) {
      expect(canTransition('completed', s)).toBeUndefined()
      expect(sm.transition(s)).toBe(false)
    }
  })

  it('finish forces any terminal state; reset returns to idle', () => {
    const sm = new AgentStateMachine()
    sm.finish('failed')
    expect(stateTerminal(sm.state)).toBe(true)
    sm.finish('cancelled')
    sm.reset()
    expect(sm.state).toBe('idle')
    expect(sm.active).toBe(true)
  })

  it('rejects same-state no-op when terminal', () => {
    const sm = new AgentStateMachine()
    sm.finish('failed')
    expect(sm.transition('failed')).toBe(false)
  })
})