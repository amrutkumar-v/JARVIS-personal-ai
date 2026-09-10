import { beforeEach, describe, expect, it } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import { resetProviders } from './providers'
import type { AIProvider, AIRequest, AIResponse } from './provider'
import type { EngineOutMessage } from './contracts'
import type { Tool, ToolResult, ToolVerification } from '../tools/Tool'
import type { WebCapabilities, WebProvider } from '../web'
import type { DeviceProvider } from '../device'
import type { DeviceRecord } from '../backend/types'
import { InMemoryTaskLog } from './observability/taskLog'
import { useJarvisStore } from '../state/jarvis.store'
import { useConversationStore } from '../state/conversation.store'

/**
 * Phase 3.0 — AUTONOMY POLICY, STRUCTURED TASK LOG, and execution UX states
 * through the REAL engine. Autonomy is engine-owned: safe automation may
 * auto-run bounded local confirmations, the hard floor (destructive/external/
 * unknown) NEVER derates, and `recovering`/`retrying` are real emitted states.
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
    return this.queue.shift() ?? { text: 'No more scripted steps.' }
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

async function waitForType(events: EngineOutMessage[], type: EngineOutMessage['type']): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (events.some((m) => m.type === type)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out waiting for ${type}`)
}

function collectStatuses(engine: AssistantEngine): string[] {
  const statuses: string[] = []
  engine.on((m: EngineOutMessage) => {
    if (m.type === 'status') statuses.push(m.status)
  })
  return statuses
}

/** A bounded LOCAL tool that asks for confirmation (category outside the hard floor). */
class ConfirmTool implements Tool {
  readonly id: string = 'local.confirm'
  readonly category: Tool['category'] = 'compute'
  readonly name: string = 'Local Confirm'
  readonly description: string = 'a bounded local action that asks for confirmation'
  readonly permission: Tool['permission'] = 'user_confirmation'
  readonly inputSchema = { type: 'object' as const, properties: {}, required: [] }
  readonly requiresPermission = true
  readonly verifiable = true
  calls = 0

  canRun(): boolean {
    return true
  }

  async execute(): Promise<ToolResult> {
    this.calls += 1
    return { ok: true, message: 'done', data: { ok: true } }
  }

  async verify(): Promise<ToolVerification> {
    return { ok: true, message: 'confirmed', checks: ['effect'] }
  }
}

/** A SYSTEM-category (hard floor) tool that asks for confirmation. */
class SystemTool extends ConfirmTool {
  override readonly id = 'local.system'
  override readonly category: Tool['category'] = 'system'
  override readonly name = 'System Op'
  override readonly description = 'a destructive/OS-adjacent confirmation'
}

/** A tool that fails once (retryable) then succeeds, so the engine REALLY retries. */
class FlakyTool implements Tool {
  readonly id = 'local.flaky'
  readonly category = 'compute'
  readonly name = 'Flaky'
  readonly description = 'fails once then works'
  readonly permission = 'low_risk'
  readonly inputSchema = { type: 'object' as const, properties: {}, required: [] }
  readonly requiresPermission = false
  readonly retry = { retryable: true, maxRetries: 2, backoffMs: 0 }
  calls = 0

  canRun(): boolean {
    return true
  }

  async execute(): Promise<ToolResult> {
    this.calls += 1
    if (this.calls === 1) return { ok: false, message: 'transient machinery failure' }
    return { ok: true, message: 'worked', data: { ok: true } }
  }
}

/** A verifiable tool whose first execution is REFUTED, triggering a replan. */
class RefuteTool implements Tool {
  readonly id = 'local.refute'
  readonly category = 'compute'
  readonly name = 'Refute'
  readonly description = 'refutes its first effect'
  readonly permission = 'low_risk'
  readonly inputSchema = { type: 'object' as const, properties: {}, required: [] }
  readonly requiresPermission = false
  readonly verifiable = true
  calls = 0

  canRun(): boolean {
    return true
  }

  async execute(): Promise<ToolResult> {
    this.calls += 1
    return { ok: true, message: 'ran', data: { ok: true } }
  }

  async verify(): Promise<ToolVerification> {
    if (this.calls <= 1) return { ok: false, message: 'effect not yet confirmed', checks: ['effect'] }
    return { ok: true, message: 'confirmed', checks: ['effect'] }
  }
}

function stubPcDevice(): DeviceRecord {
  return {
    id: 'victus-5050',
    name: 'HP Victus',
    type: 'windows_pc',
    connection: 'lan',
    capabilities: [],
    permissions: [],
    online: true,
    health: 'ok',
    lastHeartbeatAt: Date.now(),
    registeredAt: Date.now(),
    platform: 'windows',
    trusted: true,
  }
}

function stubDeviceProvider(devices: DeviceRecord[] = [stubPcDevice()]): DeviceProvider {
  return {
    capabilities: () => ({ available: true }),
    refresh: () => Promise.resolve(devices),
    notify: async (_request) => ({ delivered: true, deliveredTo: [] }),
    sendFile: async (name, _content, deviceId) => ({
      ok: true,
      file: { id: 'file-1', name, size: 12, url: 'https://jarvis.local/file-1', deviceId },
    }),
  }
}

class FakeWebProvider implements WebProvider {
  readonly id = 'stub-web'

  capabilities(): WebCapabilities {
    return { available: true, search: true, fetch: true, download: true }
  }

  async search(query: string) {
    return {
      query,
      provider: 'stub',
      servedAt: Date.now(),
      results: [{ title: 'Driver', url: 'https://example.com/driver', snippet: 'driver page' }],
      freshness: { detectable: false, note: 'stub' },
    }
  }

  async fetchDocument(url: string) {
    return { url, finalUrl: url, status: 200, title: 'Driver', text: 'driver', truncatedChars: 0, bytes: 0, fetchedAt: Date.now() }
  }

  async download(url: string) {
    return { url, finalUrl: url, status: 200, contentType: 'text/plain', content: 'driver', truncated: false, size: 6, fetchedAt: Date.now() }
  }
}

describe('Phase 3.0 — autonomy policy at the engine gate', () => {
  beforeEach(() => {
    stubBrowserStorage()
    resetProviders()
    useConversationStore.getState().clearConversation()
  })

  it('safe_automation auto-runs a bounded local confirmation tool without waiting for the user', async () => {
    const tool = new ConfirmTool()
    const provider = new ScriptedProvider([req('local.confirm'), text('done')])
    const engine = new AssistantEngine({ providers: [provider], autonomyLevel: 'safe_automation' })
    engine.registerTool(tool)
    engine.on(() => undefined)

    await engine.process('make it work')

    expect(tool.calls).toBe(1)
    expect(engine.hasPendingConfirmation).toBe(false)
    expect(engine.taskResult().status).toBe('completed')
    expect(engine.autonomyProfile().level).toBe('safe_automation')
  })

  it('assisted keeps the confirmation pause for the same tool (nothing auto-runs)', async () => {
    const tool = new ConfirmTool()
    const provider = new ScriptedProvider([req('local.confirm'), text('done')])
    const engine = new AssistantEngine({ providers: [provider], autonomyLevel: 'assisted' })
    engine.registerTool(tool)
    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))

    const pending = engine.process('make it work')
    await waitForType(events, 'tool-confirm')
    expect(engine.hasPendingConfirmation).toBe(true)
    expect(tool.calls).toBe(0)

    engine.cancelPending()
    await pending
    expect(tool.calls).toBe(0)
  })

  it('the hard floor holds EVEN at the max level: a system-category confirmation still pauses', async () => {
    const tool = new SystemTool()
    const provider = new ScriptedProvider([req('local.system'), text('done')])
    const engine = new AssistantEngine({ providers: [provider], autonomyLevel: 'controlled_autonomy' })
    engine.registerTool(tool)
    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))

    const pending = engine.process('make it work')
    await waitForType(events, 'tool-confirm')
    expect(engine.hasPendingConfirmation).toBe(true)
    expect(tool.calls).toBe(0)

    engine.cancelPending()
    await pending
    expect(tool.calls).toBe(0)
  })
})

describe('Phase 3.0 — real RETRYING and RECOVERING execution states', () => {
  beforeEach(() => {
    stubBrowserStorage()
    resetProviders()
    useConversationStore.getState().clearConversation()
  })

  it('emits retrying when a tool is genuinely retried, then completes', async () => {
    const tool = new FlakyTool()
    const provider = new ScriptedProvider([req('local.flaky'), text('done')])
    const engine = new AssistantEngine({ providers: [provider] })
    engine.registerTool(tool)
    const statuses = collectStatuses(engine)

    await engine.process('make it work')

    expect(tool.calls).toBe(2)
    expect(statuses).toContain('retrying')
    const last = useJarvisStore.getState().lastAssistantText
    expect(last).toBeTruthy()
  })

  it('emits recovering when a refuted step triggers a bounded replan', async () => {
    const tool = new RefuteTool()
    const provider = new ScriptedProvider([req('local.refute'), req('local.refute'), text('done')])
    const engine = new AssistantEngine({ providers: [provider] })
    engine.registerTool(tool)
    const statuses = collectStatuses(engine)

    await engine.process('make it work')

    expect(tool.calls).toBe(2)
    expect(statuses).toContain('recovering')
    expect(engine.goalRecovery().replans).toBe(1)
    expect(engine.taskResult().status).toBe('completed')
  })
})

describe('Phase 3.0 — structured task-execution log', () => {
  beforeEach(() => {
    stubBrowserStorage()
    resetProviders()
    useConversationStore.getState().clearConversation()
  })

  it('records one bounded entry per orchestrated outcome (executed + refused)', async () => {
    const log = new InMemoryTaskLog()
    const engine = new AssistantEngine({ web: new FakeWebProvider(), device: stubDeviceProvider(), taskLog: log })

    const executed = await engine.executeOrchestrated(
      await engine.orchestrate('Search the web for the latest NVIDIA driver.'),
    )
    expect(executed.status).toBe('partial') // executed but web results are not independently verifiable

    const cancellation = await engine.executeOrchestrated(await engine.orchestrate('Stop.'))
    expect(cancellation.status).toBe('completed')

    const entries = engine.taskExecutionLog()
    expect(entries).toHaveLength(2)

    const first = entries[0]
    expect(first.goal).toContain('Search the web')
    expect(first.autonomy).toBe('assisted')
    expect(first.verdict).toBe('partial')
    expect(first.steps[0]).toMatchObject({ capability: 'web_search', toolId: 'web_search', status: 'success' })
    expect(first.resolutions[0]).toMatchObject({ capability: 'web_search', toolId: 'web.search', fallback: false })
    expect(first.failures).toEqual([])

    const second = entries[1]
    expect(second.verdict).toBe('completed')
    expect(second.steps).toEqual([])
  })
})

describe('Phase 3.0 — AI capability truthfulness', () => {
  beforeEach(() => {
    stubBrowserStorage()
    resetProviders()
    useConversationStore.getState().clearConversation()
  })

  it('the mock dev provider is NOT reported as AI configured or connected', async () => {
    const engine = new AssistantEngine()
    await engine.start()
    expect(engine.activeProvider().id).toBe('mock')
    const caps = useJarvisStore.getState().capabilities
    expect(caps.aiConfigured).toBe(false)
    expect(caps.aiConnected).toBe(false)
  })
})