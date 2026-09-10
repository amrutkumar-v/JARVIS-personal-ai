import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantEngine } from '../AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from '../provider'
import type { EngineOutMessage } from '../contracts'
import type { Tool, ToolContext, ToolInput, ToolResult, ToolVerification } from '../../tools/Tool'
import type { CapabilityDefinition } from '../capabilities'
import type { DeviceProvider } from '../../device'
import type { DeviceRecord } from '../../backend/types'
import type {
  WebProvider,
  WebSearchResponse,
  WebDownloadResult,
  WebCapabilities,
} from '../../web'
import { FakeApplicationProvider } from '../../applications/testing'
import type { ApplicationProvider } from '../../applications'
import { ORCHESTRATION_PLAN_LIMITS } from './planner'
import type { OrchestrationRequest } from './types'
import { useConversationStore } from '../../state/conversation.store'

/**
 * Phase 3.0B — ACCEPTANCE: planning → validation → execution bridge.
 *
 * Every test drives the REAL AssistantEngine bridge entry points
 * (`orchestrate` → `planOrchestrated` → `executeOrchestrated`) against the
 * REAL Phase 2.x rails (validatePlan → executeToolSteps → run tool → observe →
 * verify) with deterministic provider stubs. Nothing fakes a result: every
 * status derives from the OBSERVED trace, and every "blocked" verdict route is
 * asserted to have run ZERO tools via a spy on the execution entry point.
 */

/* ---------------------------------------------------------------- fixtures */

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

  constructor() {
    this.queue = []
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    this.requests.push(request)
    return this.queue.shift() ?? { text: 'No scripted step.' }
  }

  isConfigured(): boolean {
    return true
  }

  isReachable(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

function record(partial: Partial<DeviceRecord>): DeviceRecord {
  return {
    id: 'unknown',
    name: 'Unknown',
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
    ...partial,
  }
}

const DEVICES: DeviceRecord[] = [
  record({ id: 'victus-5050', name: 'HP Victus', type: 'windows_pc', platform: 'windows', role: 'primary_pc' }),
  record({ id: 'dell-laptop', name: 'Dell Laptop', type: 'windows_pc', platform: 'windows', role: 'secondary_pc' }),
  record({ id: 's26-ultra', name: 'S26 Ultra', type: 'android_phone', platform: 'android', role: 'primary_phone', battery: 80, charging: true }),
  record({ id: 's23-fe', name: 'S23 FE', type: 'android_phone', platform: 'android', role: 'secondary_phone' }),
]

function stubDeviceProvider(devices: DeviceRecord[] = DEVICES): DeviceProvider {
  return {
    capabilities: () => ({ available: true }),
    refresh: () => Promise.resolve(devices),
    notify: async (request) => ({
      delivered: true,
      deliveredTo: request.device ? [request.device] : devices.filter((d) => d.online).map((d) => d.id),
    }),
    sendFile: async (name, _content, deviceId) => ({
      ok: true,
      file: { id: 'file-1', name, size: 12, url: 'https://jarvis.local/file-1', deviceId },
    }),
  }
}

interface StubWebFixtures {
  results?: Array<{ title: string; url: string; snippet: string }>
  download?: Partial<WebDownloadResult> & { content: string }
}

/** Deterministic web provider; a search can also be GATED (blocked) for tests
 * that need an in-flight orchestrated run. */
class StubWebProvider implements WebProvider {
  readonly id = 'stub-web'
  searchCalls = 0
  downloadCalls = 0
  failSearch = false
  private gateNext = false
  private releaseSearch: ((value: WebSearchResponse | Promise<WebSearchResponse>) => void) | null = null
  readonly searchStarted: Promise<void>
  private readonly markStarted: (() => void) | null = null

  constructor(private readonly fixtures: StubWebFixtures) {
    this.searchStarted = new Promise<void>((resolve) => {
      this.markStarted = resolve
    })
  }

  capabilities(): WebCapabilities {
    return { available: true, search: true, fetch: true, download: true }
  }

  /** Gate the NEXT search call: it stays pending until release() resolves it. */
  nextSearchGated(): void {
    this.gateNext = true
  }

  async search(query: string): Promise<WebSearchResponse> {
    this.searchCalls += 1
    this.markStarted?.()
    if (this.failSearch) throw new Error('network unreachable (stub fault)')
    if (this.gateNext) {
      this.gateNext = false
      await new Promise<WebSearchResponse>((resolve) => {
        this.releaseSearch = resolve
      })
    }
    return this.response(query)
  }

  release(value?: WebSearchResponse): void {
    this.releaseSearch?.(
      value ?? this.response('released'),
    )
  }

  private response(query: string): WebSearchResponse {
    return {
      query,
      provider: 'stub',
      servedAt: Date.now(),
      results:
        this.fixtures.results ??
        [{ title: 'NVIDIA Driver Download', url: 'https://nvidia.com/driver', snippet: 'Official NVIDIA driver page.' }],
      freshness: { detectable: false, note: 'stub provider' },
    }
  }

  async fetchDocument(url: string): Promise<{
    url: string
    finalUrl: string
    status: number
    contentType?: string
    title?: string
    text: string
    truncatedChars: number
    bytes: number
    fetchedAt: number
  }> {
    return {
      url,
      finalUrl: url,
      status: 200,
      title: 'stub page',
      text: 'stub text',
      truncatedChars: 0,
      bytes: 10,
      fetchedAt: Date.now(),
    }
  }

  async download(url: string): Promise<WebDownloadResult> {
    this.downloadCalls += 1
    const fixture = this.fixtures.download ?? { content: 'handbook text (stub)' }
    const content = fixture.content
    return {
      url,
      finalUrl: url,
      status: 200,
      contentType: 'text/plain',
      content,
      truncated: false,
      size: content.length,
      fetchedAt: Date.now(),
      ...fixture,
    }
  }
}

/** Engine constructor helper used by every scenario (deterministic, no real
 * providers are ever wired in). */
function makeEngine(options?: {
  web?: WebProvider
  device?: DeviceProvider
  applications?: ApplicationProvider
  capabilities?: CapabilityDefinition[]
}): AssistantEngine {
  const engine = new AssistantEngine({
    providers: [new ScriptedProvider()],
    applications: options?.applications,
    device: options?.device,
    web: options?.web,
    capabilities: options?.capabilities,
  })
  engine.on(() => undefined)
  return engine
}

/** Spy the bridge's EXECUTION ENTRY POINT. Every blocked verdict must leave it
 * untouched: returning ZERO tool executions is the "no side effects" proof. */
function spyOnExecutor(engine: AssistantEngine) {
  return vi.spyOn(engine as unknown as { executeToolSteps: () => Promise<unknown> }, 'executeToolSteps')
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function planPayload(overrides: Partial<OrchestrationRequest>): OrchestrationRequest {
  return {
    originalText: 'hand-built acceptance request',
    requestClass: 'command',
    confidence: 0.8,
    entities: {},
    requiresContext: false,
    isContinuation: false,
    suggestedCapabilities: [],
    targetDevices: [],
    availableCapabilities: [],
    unavailableCapabilities: [],
    targets: [],
    explanation: 'hand-built acceptance fixture',
    processedAt: Date.now(),
    ...overrides,
  }
}

const webProviderFixture: StubWebFixtures = {
  results: [{ title: 'NVIDIA Driver Download', url: 'https://nvidia.com/driver', snippet: 'Official NVIDIA driver page.' }],
  download: { content: 'handbook text (stub)' },
}

/* ------------------------------------------------- Sections 1–2 (execution truth) */

describe('Phase 3.0B — acceptance A/C/D/E/F: observed execution truth (never invocation optimism)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('A — simple happy path: the result is derived from the OBSERVED trace', async () => {
    const apps = new FakeApplicationProvider([{ applicationId: 'chrome', launchOutcome: 'verified' }])
    const engine = makeEngine({ applications: apps, device: stubDeviceProvider() })

    const result = await engine.executeOrchestrated(await engine.orchestrate('Open Chrome.'))

    expect(result.status).toBe('completed')
    expect(result.goal).toBe('Open Chrome.')
    expect(result.plan).toHaveLength(1)
    expect(result.plan[0].capability).toBe('open_application')
    expect(result.plan[0].payload).toEqual({ application_id: 'chrome' })
    expect(result.completedSteps).toBe(1)
    expect(result.failedSteps).toBe(0)
    expect(result.skippedSteps).toBe(0)
    expect(result.verifiedSteps).toBe(1)
    expect(result.unverifiedSteps).toBe(0)
    expect(result.steps[0]).toMatchObject({ capability: 'open_application', status: 'success', verified: true })
    expect(result.observations[0].kind).toBe('success')
    expect(result.verification[0].status).toBe('verified')
    // The REAL Phase 2.x app.launch rail actually ran (never a second engine).
    expect(apps.launchCount('chrome')).toBe(1)
  })

  it('C — independently verified success: verified and NOT merely "executed"', async () => {
    const apps = new FakeApplicationProvider([{ applicationId: 'chrome', launchOutcome: 'verified' }])
    const engine = makeEngine({ applications: apps, device: stubDeviceProvider() })

    const result = await engine.executeOrchestrated(await engine.orchestrate('Open Chrome.'))

    expect(result.status).toBe('completed')
    expect(result.steps[0].status).toBe('success')
    expect(result.steps[0].verified).toBe(true)
    expect(result.verifiedSteps).toBe(1)
    expect(result.unverifiedSteps).toBe(0)
  })

  it('D — executed but NOT independently verified (unverifiable web content) is honest partial', async () => {
    const web = new StubWebProvider(webProviderFixture)
    const engine = makeEngine({ web, device: stubDeviceProvider() })

    const result = await engine.executeOrchestrated(await engine.orchestrate('Search the web for the latest NVIDIA driver.'))

    expect(result.status).toBe('partial')
    expect(result.completedSteps).toBe(1)
    expect(result.verifiedSteps).toBe(0)
    expect(result.unverifiedSteps).toBe(1)
    expect(result.steps[0]).toMatchObject({ capability: 'web_search', status: 'success', verified: false })
    expect(result.observations[0].kind).toBe('informational')
    expect(result.verification[0].status).toBe('unverified')
    expect(result.reason).toMatch(/executed but were not independently verified/)
    // The real web.search executed exactly once through the real rail.
    expect(web.searchCalls).toBe(1)
  })

  it('E — refuted execution is NOT success: verification failure yields failed', async () => {
    const apps = new FakeApplicationProvider([{ applicationId: 'chrome', launchOutcome: 'refuted' }])
    const engine = makeEngine({ applications: apps, device: stubDeviceProvider() })

    const result = await engine.executeOrchestrated(await engine.orchestrate('Open Chrome.'))

    expect(apps.launchCount('chrome')).toBe(1)
    expect(result.status).toBe('failed')
    expect(result.completedSteps).toBe(0)
    expect(result.failedSteps).toBe(1)
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].verified).toBe(false)
    expect(result.observations[0].kind).toBe('verification')
    expect(result.verification[0].status).toBe('refuted')
  })

  it('F — complete failure (tool error) lands on failed with zero successes', async () => {
    const web = new StubWebProvider(webProviderFixture)
    web.failSearch = true
    const engine = makeEngine({ web, device: stubDeviceProvider() })

    const result = await engine.executeOrchestrated(await engine.orchestrate('Search the web for the latest NVIDIA driver.'))

    expect(result.status).toBe('failed')
    expect(result.completedSteps).toBe(0)
    expect(result.failedSteps).toBe(1)
    expect(result.steps[0]).toMatchObject({ capability: 'web_search', status: 'failed', verified: false })
    expect(result.observations[0].kind).toBe('failure')
  })
})

/* ----------------------------------------------------------------- B: multi-step */

describe('Phase 3.0B — acceptance B: multi-step goals validate dependency ordering end-to-end', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('open-then-search runs BOTH steps in order with the dependency preserved', async () => {
    const apps = new FakeApplicationProvider([{ applicationId: 'edge', launchOutcome: 'verified' }])
    const web = new StubWebProvider(webProviderFixture)
    const engine = makeEngine({ applications: apps, web, device: stubDeviceProvider() })

    const result = await engine.executeOrchestrated(
      await engine.orchestrate('Open Edge, then search the web for TypeScript docs.'),
    )

    expect(result.requestClass).toBe('multi_step_goal')
    expect(result.plan.map((s) => s.capability)).toEqual(['open_application', 'web_search'])
    expect(result.plan[1].dependsOn).toEqual([0])
    expect(result.completedSteps).toBe(2)
    expect(result.verifiedSteps).toBe(1) // app launch verified; search unverifiable
    expect(result.unverifiedSteps).toBe(1)
    expect(result.status).toBe('partial')
    // Real rails ran in the declared order: launch first, then search.
    expect(apps.launchCount('edge')).toBe(1)
    expect(web.searchCalls).toBe(1)
  })
})

/* ------------------------------------------------------------------ plan limits */

describe('Phase 3.0B — acceptance: the planner is deterministically bounded', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('exposes the hard ceiling and never exceeds it for a battery of requests', async () => {
    expect(ORCHESTRATION_PLAN_LIMITS.maxSteps).toBe(4)

    const apps = new FakeApplicationProvider([{ applicationId: 'chrome', launchOutcome: 'verified' }, { applicationId: 'edge', launchOutcome: 'verified' }])
    const engine = makeEngine({ applications: apps, device: stubDeviceProvider(), web: new StubWebProvider(webProviderFixture) })

    const samples = [
      'Open Chrome.',
      'Open Edge, then search the web for TypeScript docs.',
      'Search and download the TypeScript documentation.',
      'Notify my phone that the build is ready.',
      'Check the battery of my S26 Ultra.',
      'Search the web for drivers.',
      'What devices are connected?',
    ]
    for (const text of samples) {
      const request = await engine.orchestrate(text)
      const plan = engine.planOrchestrated(request)
      expect(plan.steps.length).toBeLessThanOrEqual(ORCHESTRATION_PLAN_LIMITS.maxSteps)
    }
  })
})

/* --------------------------------------------- blocked without side effects (G/H/N) */

describe('Phase 3.0B — acceptance G/H/N: blocked verdicts are pre-flight with ZERO side effects', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('G — plan validation rejects a declared-but-unregistered step BEFORE any execution', async () => {
    // The engine has NO web provider: web_search is neither registered nor
    // available. A hand-built request DECLARES it available — the planner
    // trusts the declaration, but the pre-flight validator must refuse it.
    const engine = makeEngine()
    const executor = spyOnExecutor(engine)
    const request = planPayload({
      originalText: 'Find the latest driver.',
      requestClass: 'web_research',
      availableCapabilities: ['web_search'],
    })

    const result = await engine.executeOrchestrated(request)

    expect(result.status).toBe('blocked')
    expect(result.reason).toMatch(/Plan validation rejected "web_search"/)
    expect(result.completedSteps).toBe(0)
    expect(result.steps[0].status).toBe('skipped')
    expect(executor).not.toHaveBeenCalled()
  })

  it('H — an unavailable capability blocks in planning, never fabricated, never run', async () => {
    const engine = makeEngine()
    const executor = spyOnExecutor(engine)

    const request = await engine.orchestrate('Search the web for drivers.')
    expect(request.availableCapabilities).not.toContain('web_search')
    const result = await engine.executeOrchestrated(request)

    expect(result.status).toBe('blocked')
    expect(result.reason).toMatch(/web_search/)
    expect(executor).not.toHaveBeenCalled()
  })

  it('N — an unresolved deictic reference asks for clarification and never invents a target', async () => {
    const engine = makeEngine({ web: new StubWebProvider(webProviderFixture) })
    const executor = spyOnExecutor(engine)

    const request = await engine.orchestrate('Send it there.')
    expect(request.requestClass).toBe('follow_up')
    expect(request.targetDevices).toEqual([])
    expect(request.targets).toEqual([])
    expect(request.implicitTargetDevice).toBeUndefined()

    const result = await engine.executeOrchestrated(request)

    expect(result.status).toBe('requires_clarification')
    expect(result.reason).toMatch(/cannot be resolved/)
    expect(executor).not.toHaveBeenCalled()
  })

  it('an explicit but unroutable target blocks in planning — nothing executes', async () => {
    // Backend unreachable → the registry is empty → the Victus route is false.
    const engine = makeEngine({ device: stubDeviceProvider([]), applications: new FakeApplicationProvider([{ applicationId: 'chrome', launchOutcome: 'verified' }]) })
    const executor = spyOnExecutor(engine)

    const request = await engine.orchestrate('Open Chrome on my Victus.')
    expect(request.targets[0].available).toBe(false)
    const result = await engine.executeOrchestrated(request)

    expect(result.status).toBe('blocked')
    expect(result.reason).toMatch(/Target device "victus-5050" is not routable/)
    expect(executor).not.toHaveBeenCalled()
  })
})

/* -------------------------------------------------- device target preservation (I/J) */

describe('Phase 3.0B — acceptance I/J: explicit device targets survive plan → validate → execute', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })
  const engineFor = (): { engine: AssistantEngine; apps: FakeApplicationProvider } => {
    const apps = new FakeApplicationProvider([{ applicationId: 'chrome', launchOutcome: 'verified' }])
    return { engine: makeEngine({ applications: apps, device: stubDeviceProvider() }), apps }
  }

  it('I — every trusted device id survives onto the planned step', async () => {
    const { engine } = engineFor()
    const cases: Array<{ text: string; capability: string; device: string }> = [
      { text: 'Open Chrome on my Victus.', capability: 'open_application', device: 'victus-5050' },
      { text: 'Open Chrome on my Dell.', capability: 'open_application', device: 'dell-laptop' },
      { text: 'Check the battery of my S26 Ultra.', capability: 'list_devices', device: 's26-ultra' },
      { text: 'Notify my S23 FE that the report is ready.', capability: 'send_device_notification', device: 's23-fe' },
    ]
    for (const c of cases) {
      const request = await engine.orchestrate(c.text)
      expect(request.targetDevices).toEqual([c.device])
      const plan = engine.planOrchestrated(request)
      expect(plan.verdict).toBe('ok')
      expect(plan.steps[0].capability).toBe(c.capability)
      expect(plan.steps[0].targetDevice).toBe(c.device)
    }
  })

  it('I — an executed targeted step keeps its target on the structured result', async () => {
    const { engine } = engineFor()
    const result = await engine.executeOrchestrated(await engine.orchestrate('Check the battery of my S26 Ultra.'))

    expect(result.status).toBe('partial') // device.list is read-only, unverified
    expect(result.targetDevices).toEqual(['s26-ultra'])
    expect(result.plan[0].targetDevice).toBe('s26-ultra')
    expect(result.steps[0].status).toBe('success')
  })

  it('J — an explicit Dell target is never overridden by the implicit Victus default', async () => {
    const { engine } = engineFor()

    const explicit = await engine.orchestrate('Open Chrome on my Dell.')
    expect(explicit.implicitTargetDevice).toBeUndefined()
    const explicitPlan = engine.planOrchestrated(explicit)
    expect(explicitPlan.steps[0].targetDevice).toBe('dell-laptop')

    // While an IMPLICIT local command still defaults to the host PC.
    const implicit = await engine.orchestrate('Open Chrome.')
    expect(implicit.implicitTargetDevice).toBe('victus-5050')
    const implicitPlan = engine.planOrchestrated(implicit)
    expect(implicitPlan.steps[0].targetDevice).toBe('victus-5050')
  })
})

/* ------------------------------------------------------------- confirmation (K) */

describe('Phase 3.0B — acceptance K: capability confirmation is preserved through the bridge', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  class CountedNotifyTool implements Tool {
    readonly id = 'device.notify'
    readonly category = 'communication' as const
    readonly name = 'Send a device notification'
    readonly description = 'Sends a notification (acceptance stub).'
    readonly permission = 'low_risk' as const
    readonly inputSchema = {
      type: 'object' as const,
      properties: {
        device: { type: 'string' },
        title: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['title', 'message'],
    }
    readonly requiresPermission = false
    readonly verifiable = true
    executions = 0

    canRun(): boolean {
      return true
    }

    async execute(_input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
      this.executions += 1
      return { ok: true, message: 'delivered', data: { delivered: true, deliveredTo: ['s26-ultra'] } }
    }

    verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): ToolVerification {
      return { ok: true, message: 'confirmed', checks: ['delivery'] }
    }
  }

  const confirmedNotifyCapability: CapabilityDefinition = {
    id: 'send_device_notification',
    name: 'Send a device notification',
    description: 'Send a short notification to a companion device.',
    category: 'device',
    tools: ['device.notify'],
    contexts: ['android'],
    riskLevel: 'low_risk',
    risk: 'low',
    destructive: false,
    readOnly: false,
    requiresConfirmation: true,
    verification: 'strong',
  }

  const request = planPayload({
    originalText: 'Notify my phone that the build is ready.',
    requestClass: 'device_operation',
    availableCapabilities: ['send_device_notification'],
  })

  it('a declined confirmation runs NOTHING and is never a success', async () => {
    const engine = makeEngine()
    const notify = new CountedNotifyTool()
    engine.registerTool(notify)
    engine.registerCapability(confirmedNotifyCapability)
    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))

    const pending = engine.executeOrchestrated(request)
    await waitFor(() => engine.hasPendingConfirmation)
    expect(notify.executions).toBe(0)
    expect(events.some((m) => m.type === 'tool-confirm')).toBe(true)

    engine.cancelPending()
    const result = await pending

    // The refusal is never a success: the run FAILS with zero executions and
    // never counts a step that never ran.
    expect(result.status).toBe('failed')
    expect(result.completedSteps).toBe(0)
    expect(result.failedSteps).toBe(0)
    expect(result.skippedSteps).toBe(1)
    expect(result.steps[0]).toMatchObject({ capability: 'send_device_notification', status: 'skipped' })
    expect(notify.executions).toBe(0)
  })

  it('an explicit confirmation lets the capability run through the normal rails', async () => {
    const engine = makeEngine()
    const notify = new CountedNotifyTool()
    engine.registerTool(notify)
    engine.registerCapability(confirmedNotifyCapability)

    const pending = engine.executeOrchestrated(request)
    await waitFor(() => engine.hasPendingConfirmation)
    expect(notify.executions).toBe(0)

    await engine.confirmPending()
    const result = await pending

    expect(result.status).toBe('completed')
    expect(result.completedSteps).toBe(1)
    expect(result.verifiedSteps).toBe(1)
    expect(result.steps[0]).toMatchObject({ capability: 'send_device_notification', status: 'success', verified: true })
    expect(notify.executions).toBe(1)
  })
})

/* --------------------------------------------------------------- cancellation (L) */

describe('Phase 3.0B — acceptance L: cancellation of an in-flight orchestrated plan', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('cancels a mid-flight bridge run through the existing rail; never reports success', async () => {
    const web = new StubWebProvider(webProviderFixture)
    web.nextSearchGated()
    const engine = makeEngine({ web, device: stubDeviceProvider() })

    const run = engine.executeOrchestrated(await engine.orchestrate('Search the web for drivers.'))
    await web.searchStarted
    expect((engine as unknown as { orchestrationActive: boolean }).orchestrationActive).toBe(true)

    const stopResult = await engine.executeOrchestrated(await engine.orchestrate('Stop.'))
    expect(stopResult.status).toBe('cancelled')
    expect(stopResult.reason).toMatch(/Cancelled via the existing cancellation rail/)

    web.release()
    const result = await run

    expect(result.status).toBe('cancelled') // cancellation wins over the executed step
    expect(result.requiresUserAction).toBe(true)
    expect(result.steps[0].status).toBe('success') // the step genuinely ran
  })

  it('a stop with nothing running completes honestly without side effects', async () => {
    const engine = makeEngine()
    const executor = spyOnExecutor(engine)

    const result = await engine.executeOrchestrated(await engine.orchestrate('Stop.'))

    expect(result.status).toBe('completed')
    expect(result.reason).toMatch(/No active task/)
    expect(executor).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------- follow-up resolution & artifacts (M/O) */

describe('Phase 3.0B — acceptance M/O: deictic follow-ups resolve against REAL committed artifacts', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('M — search commits a URL artifact that the next "Download it." actually uses', async () => {
    const web = new StubWebProvider(webProviderFixture)
    const engine = makeEngine({ web, device: stubDeviceProvider() })

    // Run 1: a real web search mutates the committed task context.
    const r1 = await engine.executeOrchestrated(await engine.orchestrate('Search the web for the official NVIDIA driver.'))
    expect(r1.status).toBe('partial')
    expect(web.searchCalls).toBe(1)

    // Run 2: the deictic follow-up resolves against the REAL returned URL.
    const req2 = await engine.orchestrate('Download it.')
    expect(req2.requestClass).toBe('follow_up')
    expect(req2.isContinuation).toBe(true)
    expect(req2.requiresContext).toBe(true)

    const r2 = await engine.executeOrchestrated(req2)
    expect(r2.plan[0].capability).toBe('web_download')
    expect(r2.plan[0].payload?.url).toBe('https://nvidia.com/driver')
    expect(r2.status).toBe('partial')
    expect(web.downloadCalls).toBe(1)
  })

  it('O — committed download artifacts flow into a later cross-device transfer (no fabrication)', async () => {
    const web = new StubWebProvider({
      results: [{ title: 'TypeScript Handbook', url: 'https://www.typescriptlang.org/docs/handbook.html', snippet: 'Official handbook.' }],
      download: { content: 'typescript handbook text' },
    })
    const engine = makeEngine({ web, device: stubDeviceProvider() })

    // "Search and download the documentation." — web.download REQUIRES a real
    // url that only exists after the search commits it, so the planner runs the
    // search and must not fabricate a download payload. The follow-up then
    // downloads the REAL committed URL.
    const req0 = await engine.orchestrate('Search and download the TypeScript documentation.')
    expect(req0.requestClass).toBe('multi_step_goal')
    const plan0 = engine.planOrchestrated(req0)
    expect(plan0.verdict).toBe('ok')
    expect(plan0.steps.map((s) => s.capability)).toEqual(['web_search'])
    const r1 = await engine.executeOrchestrated(req0)
    expect(r1.status).toBe('partial')
    expect(r1.completedSteps).toBe(1)
    expect(r1.steps[0].capability).toBe('web_search')
    expect(r1.steps[0].status).toBe('success')
    expect(web.downloadCalls).toBe(0)

    // Follow-up "Download it." uses the committed URL artifact — never invented.
    const req1 = await engine.orchestrate('Download it.')
    expect(req1.requestClass).toBe('follow_up')
    const plan1 = engine.planOrchestrated(req1)
    expect(plan1.verdict).toBe('ok')
    expect(plan1.steps[0].capability).toBe('web_download')
    expect(plan1.steps[0].payload).toMatchObject({ url: 'https://www.typescriptlang.org/docs/handbook.html' })
    const r1b = await engine.executeOrchestrated(req1)
    expect(r1b.status).toBe('partial')
    expect(r1b.completedSteps).toBe(1)
    expect(r1b.steps[0].capability).toBe('web_download')
    expect(r1b.steps[0].status).toBe('success')
    expect(web.downloadCalls).toBe(1)

    // Follow-up "Send it to my phone." reuses the committed FILE artifact as
    // the transfer payload — the planner never invents file content.
    const req2 = await engine.orchestrate('Send it to my phone.')
    expect(req2.requestClass).toBe('cross_device_workflow')
    expect(req2.targetDevices).toEqual(['s26-ultra'])
    const plan2 = engine.planOrchestrated(req2)
    expect(plan2.verdict).toBe('ok')
    expect(plan2.steps[0].capability).toBe('transfer_to_device')
    expect(plan2.steps[0].payload).toMatchObject({ device: 's26-ultra' })
    expect(plan2.steps[0].payload?.name).toBe('Downloaded from https://www.typescriptlang.org/docs/handbook.html')

    const r2 = await engine.executeOrchestrated(req2)
    expect(r2.status).toBe('completed')
    expect(r2.plan[0].capability).toBe('transfer_to_device')
    expect(r2.targetDevices).toEqual(['s26-ultra'])
  })
})

/* ------------------------------------------------------------- busy guard (P) */

describe('Phase 3.0B — acceptance P: the bridge is concurrency-safe and recovers', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('a second orchestrated plan while one is running is blocked, and the run recovers', async () => {
    const web = new StubWebProvider(webProviderFixture)
    web.nextSearchGated()
    const engine = makeEngine({ web, device: stubDeviceProvider() })

    const run1 = engine.executeOrchestrated(await engine.orchestrate('Search the web for drivers.'))
    await web.searchStarted

    const busy = await engine.executeOrchestrated(await engine.orchestrate('Search the web for TypeScript.'))
    expect(busy.status).toBe('blocked')
    expect(busy.reason).toMatch(/already executing/)

    web.release()
    const r1 = await run1
    expect(r1.status).toBe('partial')

    // The engine returns to a fully healthy state afterwards.
    const r3 = await engine.executeOrchestrated(await engine.orchestrate('Search the web for recovery.'))
    expect(r3.status).toBe('partial')
    expect(web.searchCalls).toBe(2)
  })
})

/* ----------------------------------------------------- delegation proof (section 10) */

describe('Phase 3.0B — acceptance: the bridge DELEGATES to the existing executor', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('a planning→execution round goes through executeToolSteps exactly once (never a second engine)', async () => {
    const apps = new FakeApplicationProvider([{ applicationId: 'chrome', launchOutcome: 'verified' }])
    const engine = makeEngine({ applications: apps, device: stubDeviceProvider() })
    const executor = spyOnExecutor(engine)

    const result = await engine.executeOrchestrated(await engine.orchestrate('Open Chrome.'))

    expect(executor).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('completed')
    expect(apps.launchCount('chrome')).toBe(1)
  })

  it('notify-on-a-device dominates as a real verified flow without fabricated delivery', async () => {
    const engine = makeEngine({ device: stubDeviceProvider() })

    const result = await engine.executeOrchestrated(
      await engine.orchestrate('Notify my S23 FE that the report is ready.'),
    )

    expect(result.requestClass).toBe('device_operation')
    expect(result.status).toBe('completed')
    expect(result.plan[0].targetDevice).toBe('s23-fe')
    expect(result.plan[0].capability).toBe('send_device_notification')
    expect(result.steps[0].status).toBe('success')
    expect(result.steps[0].verified).toBe(true)
  })
})