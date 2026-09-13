import { describe, expect, it, beforeEach, vi } from 'vitest'
import { AssistantEngine } from '../engine/AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from '../engine'
import { useConversationStore } from '../state/conversation.store'
import { useJarvisStore } from '../state/jarvis.store'
import { FakeDesktopInteractionProvider } from './testing'
import { createDefaultAppDesktopProvider } from '../native'

// Native-agent env read mocked so the default bootstrap deterministically sees
// NO native URL (the dev server keeps the real one from `.env.local`).
vi.mock('../native/nativeAgentEnv', () => ({
  readNativeAgentEnv: () => undefined,
}))

/**
 * Phase 1.5 — desktop tools through the REAL engine loop (ScriptedProvider +
 * injected FakeDesktopInteractionProvider): full agent run with injected input,
 * per-RUN budget tracking, redaction of typed text on traces, and the proof
 * that the PRODUCTION bootstrap never binds to the fake and never fabricates a
 * browser-mode desktop interaction surface.
 *
 * The per-run budgets (mouse 50 / keys 100) are a hard ceiling above
 * AGENT_LIMITS.MAX_AGENT_STEPS (8), so the budget BLOCK is unreachable via
 * the loop today; these tests prove the wiring + per-run tracking that make
 * the ceiling real if limits are ever raised.
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

function seeds(): FakeDesktopInteractionProvider {
  return new FakeDesktopInteractionProvider([
    { windowId: '1001', title: 'Notepad', visible: true },
    { windowId: '1002', title: 'Hidden Helper', visible: false, minimized: true },
  ])
}

describe('Desktop interaction agent (engine-level, scripted provider)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  /* ------------------------------------------------ wiring + proof */

  it('registers the desktop tools and exposes the injected provider seam', () => {
    const desktop = seeds()
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])], desktop })
    const ids = engine.tools.ids().filter((id) => id.startsWith('desktop.') || id === 'window.focus').sort()
    expect(ids).toEqual([
      'desktop.click',
      'desktop.cursor',
      'desktop.double_click',
      'desktop.hotkey',
      'desktop.key_press',
      'desktop.move',
      'desktop.right_click',
      'desktop.scroll',
      'desktop.type',
      'window.focus',
    ])
    expect(engine.desktopProvider).toBe(desktop)
    expect((engine.desktopProvider as unknown as { testsOnly?: boolean }).testsOnly).toBe(true)
  })

  it('browser mode registers NO desktop tools and exposes no provider', () => {
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    expect(engine.tools.ids().filter((id) => id.startsWith('desktop.') || id === 'window.focus')).toEqual([])
    expect(engine.desktopProvider).toBeUndefined()
  })

  it('PROOF — the default bootstrap exposes no desktop provider (no native URL)', () => {
    // `readNativeAgentEnv` is mocked undefined above, so this runs in the
    // no-native-URL world (the dev server keeps the real URL from `.env.local`).
    expect(createDefaultAppDesktopProvider()).toBeUndefined()
  })

  it('start() reports nativeDesktopInteractionAvailable honestly per provider', async () => {
    const desktop = seeds()
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])], desktop })
    await engine.start()
    expect(useJarvisStore.getState().capabilities.nativeDesktopInteractionAvailable).toBe(true)

    const none = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    await none.start()
    expect(useJarvisStore.getState().capabilities.nativeDesktopInteractionAvailable).toBe(false)
  })

  /* ------------------------------------------------ basic tool run */

  it('runs desktop.cursor and reports a non-verified step (no verifier)', async () => {
    const desktop = seeds()
    desktop.setCursor(500, 400)
    const provider = new ScriptedProvider([
      req('desktop.cursor'),
      text('The cursor is at 500, 400.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], desktop })
    engine.on(() => undefined)

    await engine.process('where is my mouse?')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps).toHaveLength(1)
    expect(trace.steps[0].status).toBe('COMPLETED')
    expect(trace.steps[0].verification?.status).toBe('not_applicable')
  })

  /* ------------------------------------------------ redaction of typed text */

  it('redacts typed text on the trace and in plan inputs but not in the provider echo', async () => {
    const desktop = seeds()
    const provider = new ScriptedProvider([
      req('desktop.type', { text: 'secret payload' }),
      text('Done.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], desktop })
    engine.on(() => undefined)

    await engine.process('type some private text')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps).toHaveLength(1)
    expect(trace.steps[0].arguments).toEqual({ text: '[redacted]' })
    expect(trace.steps[0].status).toBe('COMPLETED')
    // The typed-text tool message fed back to the provider carries only a count.
    const toolMessage = lastToolMessage(provider, 'desktop.type')
    expect(toolMessage).toMatch(/\d+ characters/)
    expect(toolMessage).not.toContain('secret')
    expect(toolMessage).not.toContain('secret payload')
    // The prompt echoing the request to the model still contains the real payload
    // (the model asked for it), but the trace does NOT.
    expect(JSON.stringify(trace)).not.toContain('secret')
  })

  /* ------------------------------------------------ per-run budget tracking */

  it('tracks per-run desktop budget buckets (mouse + keys incremented)', async () => {
    const desktop = seeds()
    const provider = new ScriptedProvider([
      req('desktop.move', { x: 10, y: 20 }),
      req('desktop.type', { text: 'hi' }),
      req('desktop.key_press', { key: 'enter' }),
      text('All done.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], desktop })
    engine.on(() => undefined)

    await engine.process('move, type and hit enter')

    const budget = engine.desktopBudget()
    expect(budget.mouse).toBe(1)
    expect(budget.keys).toBe(2)
    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps).toHaveLength(3)
    expect(trace.steps.every((s) => s.status === 'COMPLETED')).toBe(true)
  })

  /* ------------------------------------------------ budget reset across runs */

  it('resets the budget counters between distinct process() calls', async () => {
    const desktop = seeds()
    const provider = new ScriptedProvider(
      [req('desktop.move', { x: 0, y: 0 }), text('ok'), req('desktop.move', { x: 5, y: 5 }), text('again')],
    )
    const engine = new AssistantEngine({ providers: [provider], desktop })
    engine.on(() => undefined)

    await engine.process('first run')
    expect(engine.desktopBudget().mouse).toBe(1)
    await engine.process('second run')
    // The second run executed one move and the counter is 1 again — if the
    // budget had NOT reset between runs it would read 2.
    expect(engine.desktopBudget().mouse).toBe(1)
  })

  /* ------------------------------------------------ repeated action vs budget */

  it('repeated identical desktop.move calls hit the repeat guard (count=3) before the budget would ever matter', async () => {
    const desktop = seeds()
    const p = { x: 0, y: 0 }
    const provider = new ScriptedProvider([
      req('desktop.move', p),
      req('desktop.move', p),
      req('desktop.move', p),
      req('desktop.move', p),
      text('done'),
    ])
    const engine = new AssistantEngine({ providers: [provider], desktop })
    engine.on(() => undefined)

    await engine.process('move there four times')

    const trace = engine.lastRunTrace()
    expect(trace.steps).toHaveLength(4)
    expect(trace.steps.slice(0, 3).every((s) => s.status === 'COMPLETED')).toBe(true)
    expect(trace.steps[3].status).toBe('FAILED')
    expect(trace.steps[3].observation?.errorKind).toBe('orchestration_limit')
    expect(desktop.calls.move).toBe(3)
  })

  /* ------------------------------------------------ honesh message tone */

  it('desktop.click tool message includes "not confirmed" so the model never claims success it cannot verify', async () => {
    const desktop = seeds()
    const provider = new ScriptedProvider([
      req('desktop.click', { window_id: '1001', x: 10, y: 20 }),
      text('Done.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], desktop })
    engine.on(() => undefined)

    await engine.process('click notepad')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps[0].verification?.status).toBe('not_applicable')
    expect(lastToolMessage(provider, 'desktop.click')).toMatch(/not confirmed/i)
  })
})