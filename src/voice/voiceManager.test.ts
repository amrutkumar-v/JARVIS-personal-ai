import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { VoiceManager } from './voiceManager'
import { FakeWakeWordProvider, FakeSpeechToTextProvider, FakeTextToSpeechProvider } from './testing'
import { WAKE_COMMAND_TIMEOUT_MS } from './normalization'
import type { VoiceState } from './types'

interface Harness {
  manager: VoiceManager
  wake: FakeWakeWordProvider
  stt: FakeSpeechToTextProvider
  tts: FakeTextToSpeechProvider
  submit: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  onCommand: ReturnType<typeof vi.fn>
  states: VoiceState[]
  notices: Array<{ kind: 'info' | 'warning' | 'error'; text: string }>
}

function setup(
  wakeOverride: Partial<ConstructorParameters<typeof FakeWakeWordProvider>[0]> = {},
  sttOverride = {},
  userName?: () => string | undefined,
): Harness {
  const wake = new FakeWakeWordProvider(wakeOverride)
  const stt = new FakeSpeechToTextProvider(sttOverride)
  const tts = new FakeTextToSpeechProvider()
  const submit = vi.fn()
  const cancel = vi.fn()
  const onCommand = vi.fn()
  const states: VoiceState[] = []
  const notices: Harness['notices'] = []
  const manager = new VoiceManager({
    wake,
    stt,
    tts,
    ...(userName ? { userName } : {}),
    callbacks: {
      submitCommand: submit,
      cancelCurrent: cancel,
      onCommand,
      onStateChange: (s) => states.push(s),
      onNotice: (k, t) => notices.push({ kind: k, text: t }),
    },
  })
  return { manager, wake, stt, tts, submit, cancel, onCommand, states, notices }
}

/** Arm wake listening, wake up with no trailing command, finish the ack. */
function wakeToCommandListening(h: Harness): void {
  h.manager.arm()
  h.wake.emitWake({ phrase: 'wake up jarvis' })
  h.tts.finishLast()
  expect(h.manager.state).toBe('LISTENING_FOR_COMMAND')
}

describe('VoiceManager — arming and wake (Phase 1.6)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('arm() starts wake listening and records the mode', () => {
    const h = setup()
    expect(h.manager.arm()).toBe(true)
    expect(h.manager.state).toBe('LISTENING_FOR_WAKE')
    expect(h.wake.startModes).toEqual(['wake'])
    expect(h.states).toEqual(['LISTENING_FOR_WAKE'])
  })

  it('arm() refuses unsupported wake providers without side effects', () => {
    const h = setup({ supported: false })
    expect(h.manager.arm()).toBe(false)
    expect(h.manager.state).toBe('SLEEPING')
    expect(h.notices.length).toBe(1)
  })

  it('arm() refuses when the mic is denied and never retries', () => {
    const h = setup({ available: false, reason: 'Microphone permission denied.' })
    expect(h.manager.arm()).toBe(false)
    expect(h.manager.state).toBe('SLEEPING')
    expect(h.wake.startModes).toEqual([])
    expect(h.notices[0]?.text).toMatch(/permission/i)
  })

  it('wake phrase → AWAKE → spoken greeting → command listening', () => {
    const h = setup()
    h.manager.arm()
    h.wake.emitWake({ phrase: 'Wake up, JARVIS' })
    expect(h.manager.state).toBe('AWAKE')
    expect(h.tts.lastText).toBe("I'm here. How can I help?")
    h.tts.finishLast()
    expect(h.manager.state).toBe('LISTENING_FOR_COMMAND')
    expect(h.stt.listening).toBe(true)
  })

  it('the greeting is personalised with the operator name', () => {
    const h = setup({}, {}, () => 'Amrut')
    h.manager.arm()
    h.wake.emitWake({ phrase: 'Wake up, JARVIS' })
    expect(h.tts.lastText).toBe("I'm here, Amrut. How can I help?")
  })

  it('the default profile name is never spoken aloud', () => {
    const h = setup({}, {}, () => 'Operator')
    h.manager.arm()
    h.wake.emitWake({ phrase: 'Wake up, JARVIS' })
    expect(h.tts.lastText).toBe("I'm here. How can I help?")
  })

  it('greets exactly once per wake, even if the provider fires twice', () => {
    const h = setup()
    h.manager.arm()
    h.wake.emitWake({ phrase: 'Wake up, JARVIS' })
    h.wake.emitWake({ phrase: 'Wake up, JARVIS' })
    expect(h.tts.spoken.filter((s) => s.text.includes('How can I help'))).toHaveLength(1)
  })

  it('direct form "wake up jarvis open chrome" skips the ack and submits immediately', () => {
    const h = setup()
    h.manager.arm()
    h.wake.emitWake({ phrase: 'wake up jarvis open chrome', command: 'open chrome' })
    expect(h.manager.state).toBe('PROCESSING')
    expect(h.onCommand).toHaveBeenCalledWith('open chrome')
    expect(h.submit).toHaveBeenCalledWith('open chrome')
    expect(h.tts.lastText).toBeNull()
  })

  it('ignores duplicate wake events once awake', () => {
    const h = setup()
    wakeToCommandListening(h)
    h.wake.emitWake({ phrase: 'wake up jarvis' })
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.manager.state).toBe('LISTENING_FOR_COMMAND')
  })
})

describe('VoiceManager — command handling (Phase 1.6)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a spoken transcript during command listening is submitted as-is', () => {
    const h = setup()
    wakeToCommandListening(h)
    h.stt.emitTranscript('Open Chrome')
    expect(h.submit).toHaveBeenCalledWith('Open Chrome')
    expect(h.manager.state).toBe('PROCESSING')
  })

  it('a command spoken while still AWAKE (ack in flight) is submitted too', () => {
    const h = setup()
    h.manager.arm()
    h.wake.emitWake({ phrase: 'wake up jarvis' })
    h.stt.emitTranscript('what time is it')
    expect(h.submit).toHaveBeenCalledWith('what time is it')
    expect(h.manager.state).toBe('PROCESSING')
  })

  it('keeps a single queued command slot while processing (newest wins)', () => {
    const h = setup()
    h.manager.arm()
    h.wake.emitWake({ phrase: 'wake up jarvis open first', command: 'first' })
    h.stt.emitTranscript('second')
    h.stt.emitTranscript('third')
    expect(h.submit).toHaveBeenCalledTimes(1)

    // The single slot supersedes: the LAST utterance heard is the one that runs.
    h.manager.engineStatus('speaking')
    h.manager.engineStatus('idle')
    expect(h.submit).toHaveBeenCalledTimes(2)
    expect(h.submit.mock.calls[1]?.[0]).toBe('third')

    h.manager.engineStatus('idle')
    expect(h.manager.state).toBe('LISTENING_FOR_COMMAND')
    expect(h.stt.listening).toBe(true)
  })
})

describe('VoiceManager — session control phrases (Phase 1.6)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('"go to sleep" returns to sleep before any engine call', () => {
    const h = setup()
    wakeToCommandListening(h)
    h.stt.emitTranscript('go to sleep')
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.manager.state).toBe('SLEEPING')
    expect(h.tts.lastText).toBe('Going to sleep.')
  })

  it('sleep during PROCESSING cancels the active run', () => {
    const h = setup()
    h.manager.arm()
    h.wake.emitWake({ phrase: 'wake up jarvis open chrome', command: 'open chrome' })
    expect(h.manager.state).toBe('PROCESSING')
    h.stt.emitTranscript('stop listening')
    expect(h.cancel).toHaveBeenCalledTimes(1)
    expect(h.manager.state).toBe('SLEEPING')
    expect(h.tts.lastText).toBe('Going to sleep.')
  })

  it('"stop" during PROCESSING uses the existing cancellation mechanism', () => {
    const h = setup()
    h.manager.arm()
    h.wake.emitWake({ phrase: 'wake up jarvis open chrome', command: 'open chrome' })
    h.stt.emitTranscript('stop')
    expect(h.cancel).toHaveBeenCalledTimes(1)
    expect(h.manager.state).toBe('CANCELLED')
    expect(h.tts.lastText).toBe('Cancelled.')
    h.tts.finishLast()
    expect(h.manager.state).toBe('SLEEPING')
  })

  it('"cancel" while idle-listening ends the session without touching the engine', () => {
    const h = setup()
    wakeToCommandListening(h)
    h.stt.emitTranscript('cancel')
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.manager.state).toBe('CANCELLED')
    h.tts.finishLast()
    expect(h.manager.state).toBe('SLEEPING')
  })
})

describe('VoiceManager — timeouts (Phase 1.6)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the bounded command timeout speaks "I didn\'t hear a command." and sleeps', () => {
    const h = setup()
    wakeToCommandListening(h)
    vi.advanceTimersByTime(WAKE_COMMAND_TIMEOUT_MS)
    expect(h.manager.state).toBe('SLEEPING')
    expect(h.tts.lastText).toBe("I didn't hear a command.")
    expect(h.stt.listening).toBe(false)
    h.tts.finishLast()
    expect(h.manager.state).toBe('SLEEPING')
  })

it('the multi-turn session is bounded by the session ceiling even while busy', () => {
    const h = setup()
    wakeToCommandListening(h)
    // Singe-slot churn keeps the 8s "I didn't hear you" timer from firing:
    // a chatty user talks every ~1.5s, so only the single 30s session ceiling
    // (armed once at wake and never reset by activity) can end the session.
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(1000)
      h.stt.emitTranscript(`chat ${i}`)
      vi.advanceTimersByTime(500)
      h.manager.engineStatus('idle')
    }
    // 30s of whispers have elapsed; the mic must be closed now — silently,
    // with no "I didn't hear a command." (that timer never fired).
    expect(h.manager.state).toBe('SLEEPING')
    expect(h.stt.listening).toBe(false)
    expect(h.tts.lastText).not.toBe("I didn't hear a command.")
    const submitted = h.submit.mock.calls.length

    // The session is over — a late utterance is ignored entirely.
    vi.advanceTimersByTime(1000)
    h.manager.engineStatus('idle')
    h.stt.emitTranscript('too late')
    expect(h.submit.mock.calls.length).toBe(submitted)
    expect(h.manager.state).toBe('SLEEPING')
  })

  it('a command before the timeout resets the command cycle and cancels stale timers', () => {
    const h = setup()
    wakeToCommandListening(h)
    vi.advanceTimersByTime(WAKE_COMMAND_TIMEOUT_MS - 100)
    h.stt.emitTranscript('open Chrome')
    expect(h.submit).toHaveBeenCalledTimes(1)
    expect(h.manager.state).toBe('PROCESSING')
    // The stale 8s command timer was cancelled — only the 30s session
    // ceiling (armed once at wake) is still standing.
    vi.advanceTimersByTime(WAKE_COMMAND_TIMEOUT_MS)
    expect(h.manager.state).toBe('PROCESSING')
    h.manager.engineStatus('idle')
    expect(h.manager.state).toBe('LISTENING_FOR_COMMAND')
    expect(h.stt.listening).toBe(true)
    // Another command before the next command timeout resets that cycle too.
    vi.advanceTimersByTime(WAKE_COMMAND_TIMEOUT_MS - 500)
    h.stt.emitTranscript('refresh')
    expect(h.manager.state).toBe('PROCESSING')
    expect(h.submit).toHaveBeenCalledTimes(2)
  })
})

describe('VoiceManager — speaking state and messages (Phase 1.6)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('engine status "speaking" drives PROCESSING → SPEAKING', () => {
    const h = setup()
    h.manager.arm()
    h.wake.emitWake({ phrase: 'wake up jarvis open chrome', command: 'open chrome' })
    expect(h.manager.state).toBe('PROCESSING')
    h.manager.engineStatus('speaking')
    expect(h.manager.state).toBe('SPEAKING')
  })

  it('engine status idle completes the loop to LISTENING_FOR_COMMAND', () => {
    const h = setup()
    h.manager.arm()
    h.wake.emitWake({ phrase: 'wake up jarvis open chrome', command: 'open chrome' })
    h.manager.engineStatus('speaking')
    h.manager.engineStatus('idle')
    expect(h.manager.state).toBe('LISTENING_FOR_COMMAND')
    expect(h.stt.listening).toBe(true)
  })

  it('barge-in: a new command during SPEAKING interrupts speech and submits', () => {
    const h = setup()
    h.manager.arm()
    h.wake.emitWake({ phrase: 'wake up jarvis open first', command: 'first' })
    h.manager.engineStatus('speaking')
    h.stt.emitTranscript('second command')
    expect(h.tts.lastText).toBeNull()
    expect(h.submit).toHaveBeenCalledTimes(2)
    expect(h.submit.mock.calls[1]?.[0]).toBe('second command')
    expect(h.manager.state).toBe('PROCESSING')
  })

  it('engine failure speaks the failure phrase and returns to sleep', () => {
    const h = setup()
    h.manager.arm()
    h.wake.emitWake({ phrase: 'wake up jarvis open chrome', command: 'open chrome' })
    h.manager.engineStatus('error')
    expect(h.tts.lastText).toBe("I couldn't complete that.")
    h.tts.finishLast()
    expect(h.manager.state).toBe('SLEEPING')
  })

  it('ignores engine messages when no session is active', () => {
    const h = setup()
    h.manager.engineStatus('idle')
    expect(h.manager.state).toBe('SLEEPING')
    expect(h.tts.lastText).toBeNull()
  })
})

describe('VoiceManager — errors, permissions and teardown (Phase 1.6)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('wake provider permission denial surfaces one notice and sleeps (no auto-retry)', () => {
    const h = setup()
    h.manager.arm()
    h.wake.emitError('Microphone permission required, or wake detection not allowed on this browser.')
    expect(h.notices.length).toBe(1)
    expect(h.wake.stopCalls).toBeGreaterThan(0)
    expect(h.manager.state).toBe('SLEEPING')
  })

  it('speech recognition denial during command listening stops input and returns to sleep', () => {
    const h = setup()
    wakeToCommandListening(h)
    h.stt.emitError('Speech recognition error: not-allowed')
    expect(h.notices.length).toBe(1)
    expect(h.stt.listening).toBe(false)
    expect(h.manager.state).toBe('SLEEPING')
  })

  it('dispose stops everything and future inputs are ignored', () => {
    const h = setup()
    wakeToCommandListening(h)
    h.manager.dispose()
    expect(h.manager.state).toBe('SLEEPING')
    expect(h.stt.listening).toBe(false)
    h.wake.emitWake({ phrase: 'wake up jarvis' })
    h.stt.emitTranscript('open Chrome')
    expect(h.submit).not.toHaveBeenCalled()
  })
})

describe('VoiceManager — wake listening survives a session (regression)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('re-arms the wake provider when the session times out, so the NEXT wake works', () => {
    const h = setup()
    h.manager.arm()
    expect(h.wake.startModes).toEqual(['wake'])

    wakeToCommandListening(h)
    vi.advanceTimersByTime(WAKE_COMMAND_TIMEOUT_MS)
    h.tts.finishLast()

    // The provider was stopped when the session opened; it must be listening
    // again now that the session ended.
    expect(h.wake.active).toBe(true)
    expect(h.wake.startModes).toEqual(['wake', 'wake'])

    // ...and a second wake really does start a new session.
    h.wake.emitWake({ phrase: 'wake up jarvis' })
    expect(h.manager.state).toBe('AWAKE')
    expect(h.tts.lastText).toBe("I'm here. How can I help?")
  })

  it('a wake arriving while the session is SLEEPING is accepted', () => {
    const h = setup()
    h.manager.arm()
    wakeToCommandListening(h)
    vi.advanceTimersByTime(WAKE_COMMAND_TIMEOUT_MS)
    h.tts.finishLast()
    expect(h.manager.state).toBe('SLEEPING')

    h.wake.emitWake({ phrase: 'wake up jarvis' })
    expect(h.manager.state).toBe('AWAKE')
  })

  it('an explicit "go to sleep" does NOT re-arm the wake provider', () => {
    const h = setup()
    h.manager.arm()
    wakeToCommandListening(h)
    h.stt.emitTranscript('go to sleep')
    expect(h.manager.state).toBe('SLEEPING')
    expect(h.wake.active).toBe(false)
    expect(h.wake.startModes).toEqual(['wake'])
  })

  it('arm() succeeds while the provider is already listening', () => {
    const h = setup()
    h.manager.arm()
    wakeToCommandListening(h)
    vi.advanceTimersByTime(WAKE_COMMAND_TIMEOUT_MS)
    h.tts.finishLast()
    expect(h.wake.active).toBe(true)
    expect(h.manager.arm()).toBe(true)
    expect(h.manager.state).toBe('LISTENING_FOR_WAKE')
  })
})