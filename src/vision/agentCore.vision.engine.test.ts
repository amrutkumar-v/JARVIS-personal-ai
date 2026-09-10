import { describe, expect, it, beforeEach, vi } from 'vitest'
import { AssistantEngine } from '../engine/AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from '../engine'
import { useConversationStore } from '../state/conversation.store'
import { useJarvisStore } from '../state/jarvis.store'
import { FakeObservationProvider } from '../observation/testing'
import { FakeDesktopInteractionProvider } from '../desktop/testing'
import { createFakeVisionProvider } from './testing'
import { RemoteVisionProvider } from './remoteProvider'
import { resetVisionConfigCache } from '../config/vision'
import { createDefaultAppVisionProvider } from '../native'
import { VoiceManager } from '../voice/voiceManager'
import { FakeWakeWordProvider, FakeSpeechToTextProvider, FakeTextToSpeechProvider } from '../voice/testing'

/**
 * Phase 1.7 — visual computer control through the REAL engine loop
 * (ScriptedProvider + deterministic fakes sized to the 2x2 screenshot surface):
 * honest capability reporting, verified/refuted/unverified closed loops, the
 * per-run visual budget, repeated-action protection, trace redaction (typed
 * text + screenshot bytes never persist), and a voice-driven visual run.
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
  private readonly queue: AIResponse[]

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

/** All three fakes sized to the 2x2 fake screenshot / window surface. */
function visualFakes() {
  const observation = new FakeObservationProvider([
    { windowId: '1', title: 'App', bounds: { left: 0, top: 0, right: 2, bottom: 2 } },
  ])
  const desktop = new FakeDesktopInteractionProvider([{ windowId: '1' }], { left: 0, top: 0, width: 2, height: 2 })
  const vision = createFakeVisionProvider()
  return { observation, desktop, vision }
}

describe('Phase 1.7 — visual seam wiring + honest capabilities (engine-level)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('registers the three visual tools only when vision + observation + desktop exist', () => {
    const { observation, desktop, vision } = visualFakes()
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])], observation, desktop, vision })
    expect(engine.tools.ids().filter((id) => id.startsWith('desktop.visual')).sort()).toEqual([
      'desktop.visualClick',
      'desktop.visualInspect',
      'desktop.visualType',
    ])
    expect(engine.visionProvider).toBe(vision)
    expect((engine.visionProvider as unknown as { testsOnly?: boolean }).testsOnly).toBe(true)
  })

  it('browser/app mode registers NO visual tools and exposes no vision provider', () => {
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    expect(engine.tools.ids().filter((id) => id.startsWith('desktop.visual'))).toEqual([])
    expect(engine.visionProvider).toBeUndefined()
  })

  it('PROOF — the default bootstrap binds NO vision provider and never fabricates vision', () => {
    expect(createDefaultAppVisionProvider()).toBeUndefined()
  })

  it('start() reports the four visual capabilities honestly per provider presence', async () => {
    const withVision = new AssistantEngine({ providers: [new ScriptedProvider([])], ...visualFakes() })
    await withVision.start()
    const caps = useJarvisStore.getState().capabilities
    expect(caps.visionAvailable).toBe(true)
    expect(caps.ocrAvailable).toBe(true)
    expect(caps.uiElementDetectionAvailable).toBe(true)
    expect(caps.targetLocalizationAvailable).toBe(true)

    const withoutVision = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    await withoutVision.start()
    const bare = useJarvisStore.getState().capabilities
    expect(bare.visionAvailable).toBe(false)
    expect(bare.ocrAvailable).toBe(false)
    expect(bare.uiElementDetectionAvailable).toBe(false)
    expect(bare.targetLocalizationAvailable).toBe(false)
  })
})

describe('Phase 1.7 — visual closed loop through the real engine (ScriptedProvider)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('visualInspect sees the screen; charges the visual budget, not the desktop buckets', async () => {
    const { observation, desktop, vision } = visualFakes()
    const provider = new ScriptedProvider([req('desktop.visualInspect'), text('I can see the desktop.')])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)

    await engine.process('what is on my screen?')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps[0].status).toBe('COMPLETED')
    expect(trace.steps[0].verification?.status).toBe('not_applicable')
    expect(vision.analyzeCalls).toBe(1)
    expect(observation.screenshotCalls).toBe(1)
    // Visual actions are charged to the visual bucket ONLY.
    expect(engine.visualBudget()).toEqual({ actions: 1 })
    expect(engine.desktopBudget()).toEqual({ mouse: 0, keys: 0 })
    expect(lastToolMessage(provider, 'desktop.visualInspect')).toMatch(/elements/i)
  })

  it('visualClick resolved + expected_after verified marks the step verified', async () => {
    const { observation, desktop, vision } = visualFakes()
    const provider = new ScriptedProvider([
      req('desktop.visualClick', { target: 'Settings', window_id: '1', expected_after: 'Saved' }),
      text('Clicked and confirmed.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)

    await engine.process('click the settings button and check it saved')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps[0].status).toBe('COMPLETED')
    expect(trace.steps[0].verification?.status).toBe('verified')
    expect(lastToolMessage(provider, 'desktop.visualClick')).toContain('[verified]')
    // One click injected; re-observation happened.
    expect(desktop.calls.click).toBe(1)
    expect(vision.analyzeCalls).toBe(2)
    // The visual click is NOT charged to the raw mouse bucket.
    expect(engine.desktopBudget()).toEqual({ mouse: 0, keys: 0 })
    expect(engine.visualBudget()).toEqual({ actions: 1 })
  })

  it('visualClick with a refuted expectation is reported failed, never invented', async () => {
    const { observation, desktop, vision } = visualFakes()
    const provider = new ScriptedProvider([
      req('desktop.visualClick', { target: 'Settings', window_id: '1', expected_after: 'Totally new state' }),
      text('It did not change.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)

    await engine.process('click settings and confirm a brand-new state')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps[0].status).toBe('FAILED')
    expect(trace.steps[0].verification?.status).toBe('failed')
    expect(lastToolMessage(provider, 'desktop.visualClick')).toMatch(/Refuted/)
  })

  it('visualClick without expected_after is COMPLETED but honest-unverified', async () => {
    const { observation, desktop, vision } = visualFakes()
    const provider = new ScriptedProvider([
      req('desktop.visualClick', { target: 'Settings', window_id: '1' }),
      text('Clicked.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)

    await engine.process('click the settings button')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps[0].status).toBe('COMPLETED')
    expect(trace.steps[0].verification?.status).toBe('unverified')
    expect(lastToolMessage(provider, 'desktop.visualClick')).toContain('[unverified]')
  })

  it('an ambiguous visual target is refused — nothing is injected', async () => {
    const { observation, desktop, vision } = visualFakes()
    const provider = new ScriptedProvider([req('desktop.visualClick', { target: 'Submit', window_id: '1' }), text('Blocked.')])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)

    await engine.process('click submit')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps[0].status).toBe('FAILED')
    expect(trace.steps[0].observation?.errorKind).toBe('tool_failure')
    expect(lastToolMessage(provider, 'desktop.visualClick')).toMatch(/ambiguous/i)
    expect(desktop.calls.click).toBe(0)
  })

  it('across the run, desktop.* tools keep their own budgets', async () => {
    const { observation, desktop, vision } = visualFakes()
    const provider = new ScriptedProvider([
      req('desktop.visualInspect'),
      req('desktop.click', { window_id: '1', x: 1, y: 1 }),
      text('both happened.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)

    await engine.process('inspect then click')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(engine.visualBudget()).toEqual({ actions: 1 })
    expect(engine.desktopBudget()).toEqual({ mouse: 1, keys: 0 })
  })
})

describe('Phase 1.7 — visual safety rails through the engine', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('repeated identical visual actions are blocked by the repeated-action guard', async () => {
    const { observation, desktop, vision } = visualFakes()
    const click = { target: 'Settings', window_id: '1', expected_after: 'Saved' }
    const provider = new ScriptedProvider([
      req('desktop.visualClick', click),
      req('desktop.visualClick', click),
      req('desktop.visualClick', click),
      req('desktop.visualClick', click),
      text('Done.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)

    await engine.process('click settings four times')

    const trace = engine.lastRunTrace()
    expect(trace.steps).toHaveLength(4)
    expect(trace.steps.slice(0, 3).every((s) => s.status === 'COMPLETED')).toBe(true)
    expect(trace.steps[3].status).toBe('FAILED')
    expect(trace.steps[3].observation?.errorKind).toBe('orchestration_limit')
    expect(desktop.calls.click).toBe(3)
    expect(engine.visualBudget().actions).toBe(3)
  })

  it('typed text and screenshot bytes never appear on the trace', async () => {
    const { observation, desktop, vision } = visualFakes()
    const provider = new ScriptedProvider([
      req('desktop.visualType', { target: 'Settings', window_id: '1', text: 'hunter2', expected_after: 'Saved' }),
      text('Typed.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)

    await engine.process('type hunter2 into settings')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps[0].verification?.status).toBe('verified')
    // The typed text is redacted on the trace; the lengths survive.
    expect(JSON.stringify(trace.steps[0].arguments)).not.toContain('hunter2')
    expect(desktop.interactionLog.filter((e) => e.name === 'type')).toHaveLength(1)
    // Screenshot bytes (the fake PNG prefix) never travel into any payload.
    expect(JSON.stringify(trace)).not.toContain('iVBOR')
    // Only a length is ever reported back to the reasoning loop.
    expect(lastToolMessage(provider, 'desktop.visualType')).toMatch(/characters/i)
  })
})

describe('Phase 1.7 — voice-driven visual closed loop (voice + vision coexist)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('a spoken command drives the SAME visual click pipeline', async () => {
    const { observation, desktop, vision } = visualFakes()
    const provider = new ScriptedProvider([
      req('desktop.visualClick', { target: 'Settings', window_id: '1', expected_after: 'Saved' }),
      text('Clicked and confirmed.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)
    // The visual tools coexist with the voice input surface.
    expect(engine.tools.ids().some((id) => id.startsWith('desktop.visual'))).toBe(true)

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
    wake.emitWake({ phrase: 'jarvis click the settings button', command: 'click the settings button' })
    await run

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps[0].verification?.status).toBe('verified')
    expect(desktop.calls.click).toBe(1)
    expect(useJarvisStore.getState().lastUserText).toContain('click the settings')
  })
})

describe('Phase 1.8 — REAL RemoteVisionProvider through the real engine (stubbed fetch)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  function remoteVisionFakes(fetchImpl: ReturnType<typeof vi.fn>) {
    const observation = new FakeObservationProvider([
      { windowId: '1', title: 'App', bounds: { left: 0, top: 0, right: 2, bottom: 2 } },
    ])
    const desktop = new FakeDesktopInteractionProvider([{ windowId: '1' }], { left: 0, top: 0, width: 2, height: 2 })
    const vision = new RemoteVisionProvider({
      baseUrl: 'https://vision.test/v1',
      model: 'test-vision',
      key: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    return { observation, desktop, vision }
  }

  function okElements(elements: unknown[]): unknown {
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ elements }) } }] }),
    }
  }

  it('walks the REAL provider through inspect → click → verified: one POST per analysis, bytes only to the endpoint', async () => {
    const settings = { type: 'button', label: 'Settings', text: 'Settings', x: 0.5, y: 0.5, width: 1, height: 1, confidence: 0.9 }
    const saved = { type: 'text', label: 'Saved', text: 'Saved', x: 0.5, y: 0.5, width: 0.5, height: 0.5, confidence: 0.9 }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okElements([settings])) // inspect
      .mockResolvedValueOnce(okElements([settings])) // click resolution
      .mockResolvedValueOnce(okElements([settings, saved])) // post-action verification
      .mockResolvedValue(okElements([settings]))
    const { observation, desktop, vision } = remoteVisionFakes(fetchImpl)
    const provider = new ScriptedProvider([
      req('desktop.visualInspect'),
      req('desktop.visualClick', { target: 'Settings', window_id: '1', expected_after: 'Saved' }),
      text('Clicked and confirmed.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)

    await engine.process('what is on the screen, then click Settings and confirm it saved')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps[0].verification?.status).toBe('not_applicable')
    expect(trace.steps[1].verification?.status).toBe('verified')
    expect(lastToolMessage(provider, 'desktop.visualClick')).toContain('[verified]')
    expect(desktop.calls.click).toBe(1)
    // Inspect analysis + click resolution + verification re-analysis = 3 analyses.
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const [firstUrl, firstInit] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(firstUrl).toBe('https://vision.test/v1/chat/completions')
    const headers = firstInit.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-key')
    const body = JSON.parse(firstInit.body as string) as {
      model: string
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>
    }
    expect(body.model).toBe('test-vision')
    const image = body.messages[0].content.find((c) => c.type === 'image_url')
    expect(image?.image_url?.url).toMatch(/^data:image\/png;base64,iVBOR/)
    // The screenshot bytes never travel into the trace — only to the endpoint.
    expect(JSON.stringify(trace)).not.toContain('iVBOR')
  })

  it('a failing vision endpoint ABORTS the visual action — nothing injected, nothing invented', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)
    const { observation, desktop, vision } = remoteVisionFakes(fetchImpl)
    const provider = new ScriptedProvider([
      req('desktop.visualClick', { target: 'Settings', window_id: '1', expected_after: 'Saved' }),
      text('The action failed.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)

    await engine.process('click settings')

    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('FAILED')
    expect(trace.steps[0].observation?.errorKind).toBe('tool_failure')
    expect(desktop.calls.click).toBe(0)
    expect(lastToolMessage(provider, 'desktop.visualClick')).toMatch(/vision endpoint/i)
  })

  it('proof — the config-driven bootstrap binds a REAL provider only when vision is configured', () => {
    const ENV = import.meta.env as Record<string, string | undefined>
    ENV.VITE_JARVIS_VISION_BASE_URL = 'https://vision.test/v1'
    ENV.VITE_JARVIS_VISION_MODEL = 'test-vision'
    ENV.JARVIS_API_KEY = 'test-key'
    resetVisionConfigCache()
    const bound = createDefaultAppVisionProvider()
    expect(bound).toBeInstanceOf(RemoteVisionProvider)
  })
})

describe('Phase 1.9 — stale-observation protection through the real engine', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('a screen change between analysis and injection REFUSES the click — nothing injected, honest step', async () => {
    const { observation, desktop, vision } = visualFakes()
    observation.pushScreenshot({ bytes: 'screen-before' })
    observation.pushScreenshot({ bytes: 'screen-after' })
    const provider = new ScriptedProvider([
      req('desktop.visualClick', { target: 'Settings', window_id: '1', expected_after: 'Saved' }),
      text('The screen changed; nothing was clicked.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)

    await engine.process('click settings and confirm it saved')

    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('FAILED')
    expect(trace.steps[0].observation?.errorKind).toBe('tool_failure')
    expect(lastToolMessage(provider, 'desktop.visualClick')).toMatch(/changed between analysis and injection/)
    expect(desktop.calls.click).toBe(0)
    // The refused request is still charged as a visual action on the engine rail.
    expect(engine.visualBudget()).toEqual({ actions: 1 })
  })

  it('a window move after coordinate conversion REFUSES the click and tells the model to re-observe', async () => {
    const { observation, desktop, vision } = visualFakes()
    observation.onStatusBefore(2, () => observation.mutateWindow('1', { bounds: { left: 1, top: 0, right: 3, bottom: 2 } }))
    const provider = new ScriptedProvider([
      req('desktop.visualClick', { target: 'Settings', window_id: '1' }),
      text('The window moved.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)

    await engine.process('click settings')

    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('FAILED')
    expect(trace.steps[0].observation?.errorKind).toBe('tool_failure')
    expect(lastToolMessage(provider, 'desktop.visualClick')).toMatch(/moved or resized after analysis/)
    expect(desktop.calls.click).toBe(0)
  })

  it('a window that closes before injection REFUSES the click — nothing injected', async () => {
    const { observation, desktop, vision } = visualFakes()
    observation.onStatusBefore(2, () => observation.close('1'))
    const provider = new ScriptedProvider([
      req('desktop.visualClick', { target: 'Settings', window_id: '1' }),
      text('Window closed.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)

    await engine.process('click settings')

    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('FAILED')
    expect(trace.steps[0].observation?.errorKind).toBe('tool_failure')
    expect(lastToolMessage(provider, 'desktop.visualClick')).toMatch(/closed before the action could be injected/)
    expect(desktop.calls.click).toBe(0)
  })

  it('an unchanged observation still injects — the gate is a strict identity check, not a guess', async () => {
    const { observation, desktop, vision } = visualFakes()
    const provider = new ScriptedProvider([
      req('desktop.visualClick', { target: 'Settings', window_id: '1', expected_after: 'Saved' }),
      text('Clicked and confirmed.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)

    await engine.process('click settings and confirm it saved')

    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('COMPLETED')
    expect(trace.steps[0].verification?.status).toBe('verified')
    expect(desktop.calls.click).toBe(1)
    // Gate captures: analysis + gate + post-action; status: conversion + gate.
    expect(observation.screenshotCalls).toBe(3)
  })

  it('voice drives the SAME stale-observation refusal — no voice-only bypass', async () => {
    const { observation, desktop, vision } = visualFakes()
    observation.pushScreenshot({ bytes: 'voice-before' })
    observation.pushScreenshot({ bytes: 'voice-after' })
    const provider = new ScriptedProvider([
      req('desktop.visualClick', { target: 'Settings', window_id: '1' }),
      text('Screen changed; nothing was clicked.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation, desktop, vision })
    engine.on(() => undefined)

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
    wake.emitWake({ phrase: 'jarvis click the settings button', command: 'click the settings button' })
    await run

    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('FAILED')
    expect(trace.steps[0].observation?.errorKind).toBe('tool_failure')
    expect(lastToolMessage(provider, 'desktop.visualClick')).toMatch(/changed between analysis and injection/)
    expect(desktop.calls.click).toBe(0)
  })
})