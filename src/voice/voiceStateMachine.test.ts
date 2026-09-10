import { describe, expect, it } from 'vitest'
import { canVoiceTransition, voiceStateRecoverable, VoiceStateMachine } from './types'
import type { VoiceState } from './types'

const ALL: VoiceState[] = [
  'SLEEPING',
  'LISTENING_FOR_WAKE',
  'AWAKE',
  'LISTENING_FOR_COMMAND',
  'PROCESSING',
  'SPEAKING',
  'CANCELLED',
  'ERROR',
]

describe('canVoiceTransition (Phase 1.6)', () => {
  it('accepts self-transitions for every state', () => {
    for (const s of ALL) expect(canVoiceTransition(s, s)).toBe(s)
  })

  it('only allows SLEEPING → LISTENING_FOR_WAKE (SLEEPING is the root)', () => {
    expect(canVoiceTransition('SLEEPING', 'LISTENING_FOR_WAKE')).toBe('LISTENING_FOR_WAKE')
    for (const s of ALL.filter((x) => x !== 'SLEEPING' && x !== 'LISTENING_FOR_WAKE')) {
      expect(canVoiceTransition('SLEEPING', s)).toBeUndefined()
    }
  })

  it('walks the full happy loop', () => {
    expect(canVoiceTransition('LISTENING_FOR_WAKE', 'AWAKE')).toBe('AWAKE')
    expect(canVoiceTransition('AWAKE', 'LISTENING_FOR_COMMAND')).toBe('LISTENING_FOR_COMMAND')
    expect(canVoiceTransition('LISTENING_FOR_COMMAND', 'PROCESSING')).toBe('PROCESSING')
    expect(canVoiceTransition('PROCESSING', 'SPEAKING')).toBe('SPEAKING')
    expect(canVoiceTransition('SPEAKING', 'LISTENING_FOR_COMMAND')).toBe('LISTENING_FOR_COMMAND')
  })

  it('recovers CANCELLED/ERROR only to sleep or wake listening', () => {
    expect(canVoiceTransition('CANCELLED', 'SLEEPING')).toBe('SLEEPING')
    expect(canVoiceTransition('CANCELLED', 'LISTENING_FOR_WAKE')).toBe('LISTENING_FOR_WAKE')
    expect(canVoiceTransition('ERROR', 'SLEEPING')).toBe('SLEEPING')
    expect(canVoiceTransition('ERROR', 'LISTENING_FOR_WAKE')).toBe('LISTENING_FOR_WAKE')
    expect(canVoiceTransition('ERROR', 'AWAKE')).toBeUndefined()
    expect(canVoiceTransition('CANCELLED', 'AWAKE')).toBeUndefined()
  })
})

describe('voiceStateRecoverable (Phase 1.6)', () => {
  it('treats CANCELLED/ERROR/SLEEPING as recoverable, others as live', () => {
    expect(voiceStateRecoverable('SLEEPING')).toBe(true)
    expect(voiceStateRecoverable('CANCELLED')).toBe(true)
    expect(voiceStateRecoverable('ERROR')).toBe(true)
    expect(voiceStateRecoverable('LISTENING_FOR_WAKE')).toBe(false)
    expect(voiceStateRecoverable('SPEAKING')).toBe(false)
  })
})

describe('VoiceStateMachine (Phase 1.6)', () => {
  it('starts asleep and rejects illegal moves', () => {
    const m = new VoiceStateMachine()
    expect(m.state).toBe('SLEEPING')
    expect(m.transition('AWAKE')).toBe(false)
    expect(m.state).toBe('SLEEPING')
  })

  it('wraps the pure rule for a full session', () => {
    const m = new VoiceStateMachine()
    expect(m.transition('LISTENING_FOR_WAKE')).toBe(true)
    expect(m.transition('AWAKE')).toBe(true)
    expect(m.transition('LISTENING_FOR_COMMAND')).toBe(true)
    expect(m.transition('PROCESSING')).toBe(true)
    expect(m.transition('SPEAKING')).toBe(true)
    expect(m.transition('CANCELLED')).toBe(true)
    expect(m.transition('SLEEPING')).toBe(true)
  })

  it('resets to SLEEPING', () => {
    const m = new VoiceStateMachine()
    m.transition('LISTENING_FOR_WAKE')
    m.transition('ERROR')
    m.reset()
    expect(m.state).toBe('SLEEPING')
  })
})