import { describe, expect, it, beforeEach } from 'vitest'
import { AssistantEngine } from '../engine/AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from '../engine/provider'
import { useConversationStore } from '../state/conversation.store'
import { useJarvisStore } from '../state/jarvis.store'
import { FakeApplicationProvider } from './testing'
import { createDefaultAppApplicationProvider } from '../native'

/**
 * Phase 1.3 — application tools through the REAL engine loop (ScriptedProvider
 * + injected FakeApplicationProvider): multi-step workflows, honest
 * verification of unverified launches, repeated-action protection, schema
 * rejection, and the proof that the PRODUCTION bootstrap never binds to the
 * fake and never fabricates a browser-mode application surface.
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

describe('Applications agent (engine-level, scripted provider)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  /* ------------------------------------------------ wiring + proof */

  it('registers the app tools and exposes the injected provider seam', () => {
    const apps = new FakeApplicationProvider([{ applicationId: 'notepad' }])
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])], applications: apps })
    const ids = engine.tools.ids().filter((id) => id.startsWith('app.'))
    expect(ids).toEqual(['app.list', 'app.status', 'app.launch'])
    expect(engine.applicationProvider).toBe(apps)
    expect((engine.applicationProvider as unknown as { testsOnly?: boolean }).testsOnly).toBe(true)
  })

  it('browser mode registers NO app tools and exposes no provider', () => {
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    expect(engine.tools.ids().filter((id) => id.startsWith('app.'))).toEqual([])
    expect(engine.applicationProvider).toBeUndefined()
  })

  it('PROOF — the default bootstrap exposes no application provider (no native URL)', () => {
    const apps = createDefaultAppApplicationProvider()
    expect(apps).toBeUndefined()
  })

  it('start() reports nativeApplicationAvailable honestly per provider', async () => {
    const apps = new FakeApplicationProvider([{ applicationId: 'notepad' }])
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])], applications: apps })
    await engine.start()
    expect(useJarvisStore.getState().capabilities.nativeApplicationAvailable).toBe(true)

    const none = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    await none.start()
    expect(useJarvisStore.getState().capabilities.nativeApplicationAvailable).toBe(false)
  })

  /* ------------------------------------------------ multi-step workflow */

  it('runs app.status → app.launch and reports an observed, verified step', async () => {
    const apps = new FakeApplicationProvider([
      { applicationId: 'notepad', name: 'Notepad', launchOutcome: 'verified' },
    ])
    const provider = new ScriptedProvider([
      req('app.status', { application_id: 'notepad' }),
      req('app.launch', { application_id: 'notepad' }),
      text('Notepad is running.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], applications: apps })
    engine.on(() => undefined)

    await engine.process('is notepad running? if not, launch it')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps.map((s) => s.status)).toEqual(['COMPLETED', 'COMPLETED'])
    // app.status is read_only (no verifier); app.launch is verified.
    expect(trace.steps[0].verification?.status).toBe('not_applicable')
    expect(trace.steps[1].verification?.status).toBe('verified')
    expect(lastToolMessage(provider, 'app.launch')).toContain('[verified]')
    expect(apps.launchCount('notepad')).toBe(1)
    // Memory is never written by application control.
    expect(engine.memoryState.items()).toHaveLength(0)
  })

  it('honestly marks an unverified launch as verification-FAILED, never fake-success', async () => {
    const apps = new FakeApplicationProvider([
      { applicationId: 'calculator', name: 'Calculator', launchOutcome: 'unverified' },
    ])
    const provider = new ScriptedProvider([
      req('app.launch', { application_id: 'calculator' }),
      text('Launched it.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], applications: apps })
    engine.on(() => undefined)

    await engine.process('launch the calculator')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps[0].status).toBe('FAILED')
    // The verifier ran but could not confirm a real running state → failed.
    expect(trace.steps[0].verification?.status).toBe('failed')
    expect(trace.steps[0].verification?.message).toMatch(/cannot confirm/i)
    const msg = lastToolMessage(provider, 'app.launch')
    expect(msg).toContain('verification failed')
    expect(msg).not.toContain('[verified]')
  })

  it('rejects unknown ids honestly and the agent keeps going', async () => {
    const apps = new FakeApplicationProvider([{ applicationId: 'notepad' }])
    const provider = new ScriptedProvider([
      req('app.launch', { application_id: 'vscode' }),
      text("I couldn't find an app with that id."),
    ])
    const engine = new AssistantEngine({ providers: [provider], applications: apps })
    engine.on(() => undefined)

    await engine.process('launch vscode')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps[0].status).toBe('FAILED')
    expect(trace.steps[0].observation?.errorKind).toBe('tool_failure')
    expect(lastToolMessage(provider, 'app.launch')).toMatch(/no approved application|not found/i)
  })

  it('rejects missing required args before any launch attempt', async () => {
    const apps = new FakeApplicationProvider([{ applicationId: 'notepad' }])
    const provider = new ScriptedProvider([req('app.launch', {}), text('I need an application id.')])
    const engine = new AssistantEngine({ providers: [provider], applications: apps })
    engine.on(() => undefined)

    await engine.process('launch something')

    expect(lastToolMessage(provider, 'app.launch')).toMatch(/Missing required/i)
    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('FAILED')
    expect(trace.steps[0].observation?.errorKind).toBe('invalid_input')
    expect(apps.launchCount('notepad')).toBe(0)
  })

  /* ------------------------------------------------ repeated action */

  it('identical app.launch calls are blocked by the repeated-action guard', async () => {
    const apps = new FakeApplicationProvider([{ applicationId: 'notepad', launchOutcome: 'verified' }])
    const launch = { application_id: 'notepad' }
    const provider = new ScriptedProvider([
      req('app.launch', launch),
      req('app.launch', launch),
      req('app.launch', launch),
      req('app.launch', launch),
      text('Done.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], applications: apps })
    engine.on(() => undefined)

    await engine.process('launch notepad four times')

    const trace = engine.lastRunTrace()
    expect(trace.steps).toHaveLength(4)
    expect(trace.steps.slice(0, 3).every((s) => s.status === 'COMPLETED')).toBe(true)
    expect(trace.steps[3].status).toBe('FAILED')
    expect(trace.steps[3].observation?.errorKind).toBe('orchestration_limit')
    expect(apps.launchCount('notepad')).toBe(3)
  })
})