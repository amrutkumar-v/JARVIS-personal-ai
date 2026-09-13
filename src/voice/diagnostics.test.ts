import { describe, expect, it } from 'vitest'
import { VoiceDiagnostics, assessVoiceHealth, ALL_VOICE_COUNTERS } from './diagnostics'

function ttsStub(over: Partial<{ supported: boolean; available: boolean; reason?: string }> = {}) {
  const supported = over.supported ?? true
  const available = over.available ?? false
  const reason = over.reason
  return {
    supported,
    capabilities: () => (available ? { available: true } : { available: false, reason }),
  }
}

const wakeStub = (supported = true, available = true): unknown => ({
  supported,
  capabilities: () => (available ? { available: true } : { available: false, reason: 'denied' }),
})

const sttStub = (available = true): unknown => ({
  capabilities: () => (available ? { available: true } : { available: false, reason: 'no mic' }),
})

describe('VoiceDiagnostics counters', () => {
  it('starts with every counter at zero and a stable startedAt', () => {
    const diag = new VoiceDiagnostics()
    const snap = diag.snapshot()
    for (const name of ALL_VOICE_COUNTERS) {
      expect(snap.counters[name]).toBe(0)
    }
    expect(snap.startedAt).toBe(diag.startedAt)
    expect(snap.lastError).toBeNull()
    expect(snap.state).toBe('SLEEPING')
  })

  it('counts forward-only events and does not mutate the snapshot on later increments', () => {
    const diag = new VoiceDiagnostics()
    diag.increment('wakeAccepted')
    diag.increment('commandsSubmitted')
    const snap = diag.snapshot()
    diag.increment('commandsSubmitted')
    expect(snap.counters.commandsSubmitted).toBe(1)
    expect(diag.snapshot().counters.commandsSubmitted).toBe(2)
  })

  it('records state and error, and reset clears everything', () => {
    const diag = new VoiceDiagnostics()
    diag.setState('SPEAKING')
    diag.setError('mic denied')
    diag.increment('inputErrors')
    diag.reset()
    const snap = diag.snapshot()
    expect(snap.lastError).toBeNull()
    expect(snap.state).toBe('SLEEPING')
    for (const name of ALL_VOICE_COUNTERS) {
      expect(snap.counters[name]).toBe(0)
    }
  })
})

describe('assessVoiceHealth', () => {
  it('never claims tts available when unsupported', () => {
    const report = assessVoiceHealth({
      tts: ttsStub({ supported: false, available: false }),
      wake: wakeStub(true, true) as never,
      stt: sttStub(true) as never,
    })
    expect(report.tts).toEqual({ supported: false, available: false, reason: undefined })
    expect(report.wake.available).toBe(true)
    expect(report.stt.available).toBe(true)
  })

  it('reports tts/wake/stt availability and reasons honestly', () => {
    const diag = new VoiceDiagnostics()
    diag.increment('speechRescued')
    const report = assessVoiceHealth({
      tts: ttsStub({ supported: true, available: false, reason: 'no audio device' }),
      wake: wakeStub(true, false) as never,
      stt: sttStub(false) as never,
      diagnostics: diag,
    })
    expect(report.tts.available).toBe(false)
    expect(report.tts.reason).toBe('no audio device')
    expect(report.wake.available).toBe(false)
    expect(report.stt.available).toBe(false)
    expect(report.diagnostics.counters.speechRescued).toBe(1)
  })

  it('is conservative when providers are absent (no fake availability)', () => {
    const report = assessVoiceHealth({})
    expect(report.tts).toEqual({ supported: false, available: false, reason: undefined })
    expect(report.wake.available).toBe(false)
    expect(report.stt.available).toBe(false)
  })
})