import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { AssistantEngine } from '../engine/AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from '../engine'
import { useConversationStore } from '../state/conversation.store'
import { useJarvisStore } from '../state/jarvis.store'
import { FakeDesktopInteractionProvider } from '../desktop/testing'
import { FakeObservationProvider } from '../observation/testing'
import { VoiceManager } from './voiceManager'
import { FakeWakeWordProvider, FakeSpeechToTextProvider, FakeTextToSpeechProvider } from './testing'
import { WAKE_COMMAND_TIMEOUT_MS } from './normalization'

/**
 * Phase 1.6 — voice is an INPUT INTERFACE to the EXISTING Agent Core.
 *
 * These tests prove, through the real engine loop (ScriptedProvider), that a
 * spoken command enters the engine as a normal user command (the very same
 * `process(text)` a typed command uses), that the engine speaks its final
 * answer through the SAME TTS seam the voice session uses, and that a voice
 * session drives the observe→act→observe→verify closed loop with the same
 * deterministic desktop/observation providers as typed input.
 */
function stubBrowserStorage(): void {
  const backing = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  ;(globalThis as Record<string, unknown>).window = {
    localStorage,
    setTimeout: (_fn: () => void) => 0,
  }
}

class ScriptedProvider implements AIProvider {
  readonly id = 'scripted'
  readonly label = 'Scripted'
  requests: AIRequest[] = []
  private queue: AIResponse[]

  constructor(script: AIResponse[]) {
    this.queue = [...script]
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    this.requests.push(request)
    const next = this.queue.shift()
    if (!next) return { text: 'No more scripted steps.' }
    return next
  }

  isConfigured(): boolean {
    return true
  }

  isReachable(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

function req(toolId: string, payload: Record<string, unknown> = {}): AIResponse {
  return { text: '', toolRequests: [{ toolId, payload }] }
}

function text(value: string): AIResponse {
  return { text: value }
}

function lastToolMessage(provider: ScriptedProvider, toolId: string): string | undefined {
  for (let i = provider.requests.length - 1; i >= 0; i -= 1) {
    const msg = provider.requests[i].messages.find((m) => m.role === 'tool' && m.toolId === toolId)
    if (msg) return (msg as { content: string }).content
  }
  return undefined
}

function closedLoopFakes() {
  const observation = new FakeObservationProvider([{ windowId: '1001', title: 'Notepad', visible: true }])
  const desktop = new FakeDesktopInteractionProvider([{ windowId: '1001', title: 'Notepad', visible: true }])
  return { observation, desktop }
}

describe('Phase 1.6 — voice = the same engine entry point (Agent Core untouched)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('a spoken command is indistinguishable from a typed command in the engine', async () => {
    const provider = new ScriptedProvider([text('Acknowledged.')])
    const engine = new AssistantEngine({ providers: [provider] })
    const transcript: string[] = []
    engine.on((m) => {
      if (m.type === 'transcript') transcript.push(`${m.speaker}: ${m.text}`)
    })

    let run: Promise<void> | undefined
    const wake = new FakeWakeWordProvider()
    const manager = new VoiceManager({
      wake,
      stt: new FakeSpeechToTextProvider(),
      tts: new FakeTextToSpeechProvider(),
      callbacks: {
        submitCommand: (t) => {
          run = engine.process(t)
        },
        cancelCurrent: () => engine.cancelCurrentTask(),
      },
    })

    manager.arm()
    wake.emitWake({ phrase: 'wake up jarvis run a manual check', command: 'run a manual check' })
    await run

    expect(transcript).toContain('user: run a manual check')
    expect(useJarvisStore.getState().lastUserText).toBe('run a manual check')
    expect(useJarvisStore.getState().lastAssistantText).toBe('Acknowledged.')
    // The provider saw the SAME user turn any typed command would produce.
    expect(
      provider.requests[0]?.messages.some((m) => m.role === 'user' && m.content === 'run a manual check'),
    ).toBe(true)
  })

  it('speaks the final answer through the shared TTS seam (engine attach output)', async () => {
    const provider = new ScriptedProvider([text('Your files are synced.')])
    const engine = new AssistantEngine({ providers: [provider] })
    const spoken: string[] = []
    const output: Parameters<AssistantEngine['attach']>[0] = {
      speak: (t) => {
        spoken.push(t)
      },
      stop: () => undefined,
      pickVoice: () => null,
      speaking: false,
      supported: true,
    }
    engine.attach(output)
    await engine.process('sync my files')
    expect(spoken).toContain('Your files are synced.')
    // engine status flowed through speaking so any listening session can follow.
    expect(useJarvisStore.getState().lastAssistantText).toBe('Your files are synced.')
  })

  it('start() reports voice capability flags honestly per environment', async () => {
    stubBrowserStorage()
    // Node/vitest environment: no recognizer and no synthesis surface.
    const plain = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    await plain.start()
    const caps = useJarvisStore.getState().capabilities
    expect(caps.wakeWordAvailable).toBe(false)
    expect(caps.voiceInteractionAvailable).toBe(false)

    // An environment WITH a recognition surface must report wake capability.
    ;(globalThis as unknown as { window: Record<string, unknown> }).window.SpeechRecognition = class {}
    const withRecognition = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    await withRecognition.start()
    const caps2 = useJarvisStore.getState().capabilities
    expect(caps2.wakeWordAvailable).toBe(true)
    expect(caps2.voiceInteractionAvailable).toBe(true)
    delete (globalThis as unknown as { window: Record<string, unknown> }).window.SpeechRecognition
  })
})

describe('Phase 1.6 — voice-driven closed-loop desktop control (deterministic fakes)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('observe → focus → move → click runs with verified/honest steps', async () => {
    const { observation, desktop } = closedLoopFakes()
    desktop.setCursor(0, 0)
    // MAX_TOOL_ROUNDS = 5 bounds the run: 4 tool rounds + the final answer.
    const provider = new ScriptedProvider([
      req('window.list'),
      req('window.focus', { window_id: '1001' }),
      req('desktop.move', { x: 50, y: 60 }),
      req('desktop.click', { window_id: '1001', x: 50, y: 60 }),
      text('Notepad is in the foreground and the click was injected.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop })
    engine.on(() => undefined)

    await engine.process('open notepad and click the check box')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps).toHaveLength(4)
    expect(trace.steps.every((s) => s.status === 'COMPLETED')).toBe(true)
    // Verified steps: window.focus (window exists) and desktop.move.
    expect(trace.steps[1].verification?.status).toBe('verified')
    expect(trace.steps[2].verification?.status).toBe('verified')
    // window.list has no verifier; the injected click is honestly unconfirmed.
    expect(trace.steps[0].verification?.status).toBe('not_applicable')
    expect(trace.steps[3].verification?.status).toBe('not_applicable')
    expect(lastToolMessage(provider, 'desktop.click')).toMatch(/not confirmed/i)
    // The desktop fake really injected exactly the actions requested.
    expect(desktop.calls.move).toBe(1)
    expect(desktop.calls.click).toBe(1)
    expect(desktop.calls.focus).toBe(1)
    expect(desktop.focusedWindowId).toBe('1001')
    expect(desktop.interactionLog.filter((e) => e.name === 'click').length).toBe(1)
  })

  it('an observation miss during the loop is reported as verification failed, not invented', async () => {
    const { observation, desktop } = closedLoopFakes()
    const provider = new ScriptedProvider([
      req('window.list'),
      req('window.status', { window_id: '1002' }),
      text('That window is gone.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop })
    engine.on(() => undefined)

    await engine.process('check the helper window')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    // An honest tool_failure step: the closed window is reported, not patched over.
    expect(trace.steps[1].status).toBe('FAILED')
    expect(trace.steps[1].observation?.errorKind).toBe('tool_failure')
    expect(lastToolMessage(provider, 'window.status')).toMatch(/does not exist/i)
  })

  it('browser (no native URL) mode still reports no fabricated desktop surface', () => {
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    expect(engine.desktopProvider).toBeUndefined()
  })
})

/**
 * The acceptance path the user actually experiences:
 *   wake word → ONE spoken greeting → the microphone listens → the AI answers
 *   OUT LOUD, and the session can be woken again afterwards.
 *
 * The engine and the voice session share ONE text-to-speech stream here, so
 * every utterance the user hears is observable in one place.
 */
describe('wake → greeting → listen → spoken answer', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('speaks one greeting, opens the mic, and answers out loud', async () => {
    const provider = new ScriptedProvider([text('The lights are on.')])
    const engine = new AssistantEngine({ providers: [provider] })

    const tts = new FakeTextToSpeechProvider()
    const stt = new FakeSpeechToTextProvider()
    const wake = new FakeWakeWordProvider()

    // ONE TTS stream shared by the engine and the voice session.
    const output: Parameters<AssistantEngine['attach']>[0] = {
      speak: (t, onDone) => tts.speak(t, { onDone: () => onDone?.() }),
      stop: () => tts.stop(),
      pickVoice: () => null,
      get speaking() {
        return tts.speaking
      },
      supported: true,
    }
    engine.attach(output)

    let run: Promise<void> | undefined
    const manager = new VoiceManager({
      wake,
      stt,
      tts,
      userName: () => 'Amrut',
      callbacks: {
        submitCommand: (t) => {
          run = engine.process(t)
        },
        cancelCurrent: () => engine.cancelCurrentTask(),
      },
    })
    // The engine's status drives the voice session cycle, exactly as the app wires it.
    engine.on((m) => {
      if (m.type === 'status') manager.engineStatus(m.status)
    })

    // 1. The wake phrase fires.
    manager.arm()
    wake.emitWake({ phrase: 'wake up jarvis' })

    // 2. Exactly ONE greeting is spoken — personalised, never a duplicate.
    expect(tts.lastText).toBe("I'm here, Amrut. How can I help?")
    expect(tts.spoken.filter((s) => s.text.includes('How can I help'))).toHaveLength(1)

    // 3. The greeting finishes → the microphone opens for the command.
    tts.finishLast()
    expect(manager.state).toBe('LISTENING_FOR_COMMAND')
    expect(stt.listening).toBe(true)

    // 4. The spoken command enters the SAME engine path a typed one uses.
    stt.emitTranscript('turn on the lights')
    await run

    // 5. The AI's answer is spoken out loud through the same TTS stream.
    expect(tts.spoken.map((s) => s.text)).toContain('The lights are on.')
  })

  it('the session can be woken again after the first one ends', async () => {
    const provider = new ScriptedProvider([text('First answer.')])
    const engine = new AssistantEngine({ providers: [provider] })
    const tts = new FakeTextToSpeechProvider()
    const stt = new FakeSpeechToTextProvider()
    const wake = new FakeWakeWordProvider()

    let run: Promise<void> | undefined
    const manager = new VoiceManager({
      wake,
      stt,
      tts,
      userName: () => 'Amrut',
      callbacks: {
        submitCommand: (t) => {
          run = engine.process(t)
        },
        cancelCurrent: () => engine.cancelCurrentTask(),
      },
    })
    engine.on((m) => {
      if (m.type === 'status') manager.engineStatus(m.status)
    })

    manager.arm()
    wake.emitWake({ phrase: 'wake up jarvis' })
    tts.finishLast()
    stt.emitTranscript('first question')
    await run

    // The bounded session ends when the user goes quiet; the wake provider
    // must be listening again so the NEXT wake word works.
    vi.advanceTimersByTime(WAKE_COMMAND_TIMEOUT_MS)
    tts.finishLast()
    expect(manager.state).toBe('SLEEPING')
    expect(wake.active).toBe(true)

    wake.emitWake({ phrase: 'wake up jarvis' })
    expect(manager.state).toBe('AWAKE')
    expect(tts.spoken.filter((s) => s.text.includes('How can I help'))).toHaveLength(2)
  })
})