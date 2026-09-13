import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { BrowserVoiceOutput } from './VoiceOutput'
import { BrowserTextToSpeechProvider } from './ttsProvider'

class MockUtterance {
  text: string
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  voice: any = null
  rate = 1
  pitch = 1
  volume = 1
  constructor(text: string) { this.text = text }
}
vi.stubGlobal('SpeechSynthesisUtterance', MockUtterance)

/** Minimal fake SpeechSynthesis that never fires onend. */
function fakeSynth(voices: Array<{ voiceURI: string; name: string; lang: string }> = [], opts: { resume?: boolean; pending?: boolean } = {}): any {
  let _speaking = false
  let _lastUtterance: any = null
  const resumed: number[] = []
  const cancelLog: number[] = []
  return {
    get speaking() { return _speaking },
    get pending() { return opts.pending ?? false },
    getVoices: () => voices,
    cancel() { _speaking = false; _lastUtterance = null; cancelLog.push(Date.now()) },
    speak(utterance: any) {
      _speaking = true
      _lastUtterance = utterance
    },
    resume: opts.resume ? () => { resumed.push(Date.now()); _speaking = false } : undefined,
    /** Counters of recovery + reconcile calls (for un-wedge tests). */
    get resumeCount() { return resumed.length },
    get cancelCount() { return cancelLog.length },
    /** Test helper: manually fire onend / onerror of the pending utterance. */
    flush(event: 'onend' | 'onerror') {
      const u = _lastUtterance
      _speaking = false
      _lastUtterance = null
      if (u) u[event]()
    },
  }
}

describe('BrowserVoiceOutput watchdog', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires onDone via watchdog when speechSynthesis never fires onend', () => {
    const synth = fakeSynth()
    const out = new BrowserVoiceOutput(synth)
    const done = vi.fn()
    out.speak('hello world', done, 1)
    expect(out.speaking).toBe(true)
    expect(done).not.toHaveBeenCalled()
    vi.advanceTimersByTime(BrowserVoiceOutput.WATCHDOG_MS - 1)
    expect(done).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('does NOT fire watchdog again once settled early (onend fires normally)', () => {
    const synth = fakeSynth()
    const out = new BrowserVoiceOutput(synth)
    const done = vi.fn()
    out.speak('early settle', done, 1)
    synth.flush('onend')
    expect(done).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(BrowserVoiceOutput.WATCHDOG_MS + 1000)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('stop() cancels the watchdog and does not call onDone', () => {
    const synth = fakeSynth()
    const out = new BrowserVoiceOutput(synth)
    const done = vi.fn()
    out.speak('will stop', done, 1)
    out.stop()
    vi.advanceTimersByTime(BrowserVoiceOutput.WATCHDOG_MS + 1000)
    expect(done).not.toHaveBeenCalled()
  })

  it('new speak() cancels the prior watchdog (no double onDone)', () => {
    const synth = fakeSynth()
    const out = new BrowserVoiceOutput(synth)
    const done1 = vi.fn()
    const done2 = vi.fn()
    out.speak('first', done1, 1)
    out.speak('second', done2, 1)
    vi.advanceTimersByTime(BrowserVoiceOutput.WATCHDOG_MS)
    expect(done1).not.toHaveBeenCalled()
    expect(done2).toHaveBeenCalledTimes(1)
  })

  it('onerror also settles and cancels the watchdog', () => {
    const synth = fakeSynth()
    const out = new BrowserVoiceOutput(synth)
    const done = vi.fn()
    out.speak('error path', done, 1)
    synth.flush('onerror')
    expect(done).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(BrowserVoiceOutput.WATCHDOG_MS + 1000)
    expect(done).toHaveBeenCalledTimes(1)
  })
})

describe('BrowserVoiceOutput un-wedge + rescue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('calls resume() before speaking when the engine supports it (Chromium fix)', () => {
    const synth = fakeSynth([], { resume: true })
    const out = new BrowserVoiceOutput(synth)
    const done = vi.fn()
    out.speak('un-wedge me', done, 1)
    expect(synth.resumeCount).toBe(1)
    expect(out.speaking).toBe(true)
  })

  it('never calls resume() on engines that do not implement it', () => {
    const synth = fakeSynth()
    const out = new BrowserVoiceOutput(synth)
    out.speak('plain engine', vi.fn(), 1)
    expect(synth.resumeCount).toBe(0)
  })

  it('watchdog rescues a wedged engine (still speaking) and fires onRescued', () => {
    const synth = fakeSynth([], { resume: true })
    const rescued = vi.fn()
    const out = new BrowserVoiceOutput(synth, { onRescued: rescued })
    const done = vi.fn()
    out.speak('stuck forever', done, 1)
    // Engine is still "speaking" when the watchdog fires.
    vi.advanceTimersByTime(BrowserVoiceOutput.WATCHDOG_MS)
    expect(done).toHaveBeenCalledTimes(1)
    expect(rescued).toHaveBeenCalledTimes(1)
    expect(synth.cancelCount).toBeGreaterThanOrEqual(1)
    expect(synth.resumeCount).toBeGreaterThanOrEqual(1)
  })

  it('watchdog does NOT fire onRescued when the engine settled normally', () => {
    const synth = fakeSynth([])
    const rescued = vi.fn()
    const out = new BrowserVoiceOutput(synth, { onRescued: rescued })
    const done = vi.fn()
    out.speak('fine', done, 1)
    synth.flush('onend')
    vi.advanceTimersByTime(BrowserVoiceOutput.WATCHDOG_MS + 1000)
    expect(done).toHaveBeenCalledTimes(1)
    expect(rescued).not.toHaveBeenCalled()
  })
})

describe('BrowserTextToSpeechProvider watchdog integration', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('calls provider-level onDone via watchdog when utterance never completes', () => {
    const synth = fakeSynth()
    const out = new BrowserVoiceOutput(synth)
    const provider = new BrowserTextToSpeechProvider(out)
    const done = vi.fn()
    provider.speak('integration test', { onDone: done })
    vi.advanceTimersByTime(BrowserVoiceOutput.WATCHDOG_MS)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('forwards onRescued from the output layer', () => {
    const synth = fakeSynth([], { resume: true })
    const out = new BrowserVoiceOutput(synth)
    const provider = new BrowserTextToSpeechProvider(out)
    const forwarded = vi.fn()
    provider.onRescued = forwarded
    provider.speak('rescue me', { onDone: vi.fn() })
    vi.advanceTimersByTime(BrowserVoiceOutput.WATCHDOG_MS)
    expect(forwarded).toHaveBeenCalledTimes(1)
  })
})
