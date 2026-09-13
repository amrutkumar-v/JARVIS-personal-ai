import { describe, expect, it, beforeEach, vi } from 'vitest'
import { AssistantEngine } from '../engine/AssistantEngine'
import type { AIProvider, AIRequest, AIResponse, EngineOutMessage } from '../engine'
import { useConversationStore } from '../state/conversation.store'
import { useJarvisStore } from '../state/jarvis.store'
import { FakeObservationProvider } from './testing'
import { createDefaultAppObservationProvider } from '../native'

// Native-agent env read mocked so the default bootstrap deterministically sees
// NO native URL (the dev server keeps the real one from `.env.local`).
vi.mock('../native/nativeAgentEnv', () => ({
  readNativeAgentEnv: () => undefined,
}))

/**
 * Phase 1.4 — observation tools through the REAL engine loop (ScriptedProvider
 * + injected FakeObservationProvider): multi-step window workflows, honest
 * verification, schema + id rejection before any provider call, the strict
 * confirmation gate on desktop.screenshot, repeated-action protection, and
 * the proof that the PRODUCTION bootstrap never binds to the fake and never
 * fabricates a browser-mode observation surface.
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

function seeds() {
  return new FakeObservationProvider([
    { windowId: '1003', title: 'Explorer', visible: true },
    { windowId: '1001', title: 'Notepad', pid: 401, processName: 'notepad.exe', visible: true, maximized: true },
    { windowId: '1002', title: 'Hidden Helper', visible: false, minimized: true },
  ])
}

describe('Observation agent (engine-level, scripted provider)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  /* ------------------------------------------------ wiring + proof */

  it('registers the observation tools and exposes the injected provider seam', () => {
    const obs = seeds()
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])], observation: obs })
    const ids = engine.tools.ids().filter((id) => id.startsWith('window.') || id === 'desktop.screenshot').sort()
    expect(ids).toEqual(['desktop.screenshot', 'window.list', 'window.status'])
    expect(engine.observationProvider).toBe(obs)
    expect((engine.observationProvider as unknown as { testsOnly?: boolean }).testsOnly).toBe(true)
  })

  it('browser mode registers NO observation tools and exposes no provider', () => {
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    expect(engine.tools.ids().filter((id) => id.startsWith('window.') || id === 'desktop.screenshot')).toEqual([])
    expect(engine.observationProvider).toBeUndefined()
  })

  it('PROOF — the default bootstrap exposes no observation provider (no native URL)', () => {
    // `readNativeAgentEnv` is mocked undefined above, so this runs in the
    // no-native-URL world (the dev server keeps the real URL from `.env.local`).
    expect(createDefaultAppObservationProvider()).toBeUndefined()
  })

  it('start() reports nativeObservationAvailable honestly per provider', async () => {
    const obs = seeds()
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])], observation: obs })
    await engine.start()
    expect(useJarvisStore.getState().capabilities.nativeObservationAvailable).toBe(true)

    const none = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    await none.start()
    expect(useJarvisStore.getState().capabilities.nativeObservationAvailable).toBe(false)
  })

  /* ------------------------------------------------ multi-step workflow */

  it('runs window.list → window.status and reports a verified step', async () => {
    const obs = seeds()
    const provider = new ScriptedProvider([
      req('window.list'),
      req('window.status', { window_id: '1001' }),
      text('Notepad is open and maximized.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation: obs })
    engine.on(() => undefined)

    await engine.process('what is on my screen right now?')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps.map((s) => s.status)).toEqual(['COMPLETED', 'COMPLETED'])
    // window.list has no verifier; window.status verifies the window still exists.
    expect(trace.steps[0].verification?.status).toBe('not_applicable')
    expect(trace.steps[1].verification?.status).toBe('verified')
    expect(lastToolMessage(provider, 'window.status')).toContain('[verified]')
    // Observation never writes memory.
    expect(engine.memoryState.items()).toHaveLength(0)
  })

  it('honestly fails when a window closes before inspection', async () => {
    const obs = seeds()
    obs.close('1002')
    const provider = new ScriptedProvider([
      req('window.status', { window_id: '1002' }),
      text("That window is gone — I'll check the rest."),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation: obs })
    engine.on(() => undefined)

    await engine.process('is the hidden helper open?')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps[0].status).toBe('FAILED')
    expect(trace.steps[0].observation?.errorKind).toBe('tool_failure')
    expect(lastToolMessage(provider, 'window.status')).toMatch(/does not exist/i)
  })

  it('rejects a non-decimal window id before it ever reaches the provider', async () => {
    const obs = seeds()
    const provider = new ScriptedProvider([
      req('window.status', { window_id: 'C:\\Windows\\explorer.exe' }),
      text('No such window id.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation: obs })
    engine.on(() => undefined)

    await engine.process('inspect window 0x1A2B')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps[0].status).toBe('FAILED')
    // The tool refused at its own guard (pre-provider), so this is a runtime
    // tool failure — never an ai/schema confusion — and the provider was never
    // consulted.
    expect(trace.steps[0].observation?.errorKind).toBe('tool_failure')
    expect(obs.statusCalls).toBe(0)
  })

  it('rejects missing required args before any provider call', async () => {
    const obs = seeds()
    const provider = new ScriptedProvider([req('window.status', {}), text('I need a window id.')])
    const engine = new AssistantEngine({ providers: [provider], observation: obs })
    engine.on(() => undefined)

    await engine.process('check the window')

    expect(lastToolMessage(provider, 'window.status')).toMatch(/Missing required/i)
    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('FAILED')
    expect(trace.steps[0].observation?.errorKind).toBe('invalid_input')
    expect(obs.statusCalls).toBe(0)
  })

  /* ------------------------------------------------ screenshot gate */

  it('desktop.screenshot is gated: waits for explicit approval and never runs on cancel', async () => {
    const obs = seeds()
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([req('desktop.screenshot')])], observation: obs })

    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))
    const pending = engine.process('take a screenshot of my desktop')
    await waitForType(events, 'tool-confirm')
    expect(engine.hasPendingConfirmation).toBe(true)

    engine.cancelCurrentTask()
    await pending

    expect(useJarvisStore.getState().lastAssistantText ?? '').toMatch(/cancelled/i)
    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('cancelled')
    expect(obs.screenshotCalls).toBe(0)
  })

  /* ------------------------------------------------ repeated action */

  it('identical window.status calls are blocked by the repeated-action guard', async () => {
    const obs = seeds()
    const status = { window_id: '1001' }
    const provider = new ScriptedProvider([
      req('window.status', status),
      req('window.status', status),
      req('window.status', status),
      req('window.status', status),
      text('Done.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], observation: obs })
    engine.on(() => undefined)

    await engine.process('check notepad four times')

    const trace = engine.lastRunTrace()
    expect(trace.steps).toHaveLength(4)
    expect(trace.steps.slice(0, 3).every((s) => s.status === 'COMPLETED')).toBe(true)
    expect(trace.steps[3].status).toBe('FAILED')
    expect(trace.steps[3].observation?.errorKind).toBe('orchestration_limit')
    // 3 executed status reads + 3 verifier re-reads; the 4th was orchestration-blocked.
    expect(obs.statusCalls).toBe(6)
  })
})

async function waitForType(events: EngineOutMessage[], type: EngineOutMessage['type']): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (events.some((m) => m.type === type)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out waiting for ${type}`)
}