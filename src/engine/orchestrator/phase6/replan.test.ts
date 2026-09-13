import { describe, it, expect } from 'vitest'
import { decideReplan, isReplayOf, replanLimitReached } from './replan'
import type { ReplanContext } from './replan'

const ctx: ReplanContext = {
  failedStepIndex: 1,
  capability: 'open_application',
  failedKind: 'tool_unavailable',
  summary: 'app.launch failed: tool unavailable',
}

describe('Phase 6 — bounded replanning', () => {
  it('never replans past the ceiling', () => {
    expect(decideReplan({ ctx, replansUsed: 3, maxReplans: 3 })).toMatchObject({
      action: 'stop',
      reason: expect.stringContaining('replan limit reached'),
    })
    expect(decideReplan({ ctx, replansUsed: 2, maxReplans: 3 }).action).toBe('stop')
    expect(replanLimitReached(0, 3)).toBe(false)
    expect(replanLimitReached(3, 3)).toBe(true)
  })

  it('stops honestly when no alternative resolver exists', () => {
    const d = decideReplan({ ctx, replansUsed: 0, maxReplans: 3 })
    expect(d.action).toBe('stop')
    expect(d.reason).toContain('no genuinely supported alternative')
  })

  it('stops honestly when the resolver reports no genuine alternative', () => {
    const d = decideReplan({
      ctx,
      replansUsed: 0,
      maxReplans: 3,
      alternatives: () => undefined,
    })
    expect(d.action).toBe('stop')
    expect(d.reason).toContain('no genuinely supported alternative exists')
  })

  it('continues with a bounded corrected step when a genuine alternative exists', () => {
    const d = decideReplan({
      ctx,
      replansUsed: 0,
      maxReplans: 3,
      alternatives: () => ({
        capability: 'application_status',
        payload: { application_id: 'notepad' },
        note: 'verify application state instead',
      }),
    })
    expect(d.action).toBe('continue')
    expect(d.replansUsed).toBe(1)
    expect(d.corrected?.capability).toBe('application_status')
  })

  it('increments the replan counter across calls', () => {
    const d1 = decideReplan({
      ctx,
      replansUsed: 0,
      maxReplans: 3,
      alternatives: () => ({
        capability: 'x',
        payload: {},
        note: 'n',
      }),
    })
    const d2 = decideReplan({
      ctx,
      replansUsed: d1.replansUsed,
      maxReplans: 3,
      alternatives: () => ({
        capability: 'x',
        payload: {},
        note: 'n',
      }),
    })
    expect(d2.replansUsed).toBe(2)
  })

  it('detects replay of an identical (capability, payload) continuation', () => {
    const plan = [{ capability: 'open_application', payload: { application_id: 'notepad' } }]
    expect(isReplayOf(plan, { capability: 'open_application', payload: { application_id: 'notepad' }, note: 'x' })).toBe(true)
    expect(isReplayOf(plan, { capability: 'open_application', payload: { application_id: 'calc' }, note: 'x' })).toBe(false)
  })
})