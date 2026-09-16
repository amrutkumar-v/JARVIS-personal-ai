import { describe, expect, it } from 'vitest'
import { voiceStatusPresentation } from './voiceStatusPresentation'
import type { VoiceState } from '../../voice/types'

const STATE: VoiceState[] = [
  'SLEEPING',
  'LISTENING_FOR_WAKE',
  'AWAKE',
  'LISTENING_FOR_COMMAND',
  'PROCESSING',
  'SPEAKING',
  'CANCELLED',
  'ERROR',
]

describe('voiceStatusPresentation', () => {
  it('collapses to OFFLINE when no voice capability exists at all', () => {
    const p = voiceStatusPresentation('SLEEPING', false, false, false)
    expect(p.mode).toBe('offline')
    expect(p.label).toBe('OFFLINE')
  })

  it('LISTENING wins over every other marker while the recognizer is hot', () => {
    for (const state of STATE) {
      const p = voiceStatusPresentation(state, true, true, true)
      expect(p.mode).toBe('listening')
      expect(p.label).toBe('LISTENING')
    }
  })

  it('shows the REAL resting state when armed but idle', () => {
    const p = voiceStatusPresentation('LISTENING_FOR_WAKE', true, false, true)
    expect(p.mode).toBe('armed')
    expect(p.label).toBe('LISTENING_FOR_WAKE')
  })

  it('distinguishes PROCESSING and SPEAKING without fabricating a label', () => {
    const processing = voiceStatusPresentation('PROCESSING', true, false, true)
    expect(processing.mode).toBe('armed')
    expect(processing.label).toBe('PROCESSING')

    const speaking = voiceStatusPresentation('SPEAKING', true, false, true)
    expect(speaking.mode).toBe('armed')
    expect(speaking.label).toBe('SPEAKING')
  })

  it('flags voice errors as recovering instead of pretending readiness', () => {
    const p = voiceStatusPresentation('ERROR', true, false, true)
    expect(p.mode).toBe('recovering')
    expect(p.label).toContain('ERROR')
  })

  it('reports honest STANDBY when unarmed but the session is resting', () => {
    const p = voiceStatusPresentation('SLEEPING', false, false, true)
    expect(p.mode).toBe('standby')
    expect(p.label).toBe('STANDBY')
  })

  it('reports RECOVERING when unarmed after a cancelled session', () => {
    const p = voiceStatusPresentation('CANCELLED', false, false, true)
    expect(p.mode).toBe('recovering')
    expect(p.label).toBe('RECOVERING')
  })
})