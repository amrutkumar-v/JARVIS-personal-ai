import { describe, expect, it, beforeEach } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from './provider'
import type { Tool, ToolContext, ToolInput, ToolResult, ToolVerification } from '../tools/Tool'
import type { CapabilityDefinition } from './capabilities'
import type { EngineOutMessage } from './contracts'
import { useConversationStore } from '../state/conversation.store'

/**
 * Phase 2.3 — CAPABILITY LAYER through the REAL engine loop. A plan step that
 * names a capability resolves to a concrete registered tool via the same
 * validatePlan path: rails still run on the CONCRETE tool, and rejected
 * capability names surface as honest trace events + bounded replans.
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

function req(toolId: string, payload: Record<string, unknown> = {}, capability?: string): AIResponse {
  return { text: '', toolRequests: [{ toolId, payload, ...(capability ? { capability } : {}) }] }
}

function text(value: string): AIResponse {
  return { text: value }
}

class ClickTool implements Tool {
  readonly id = 'desktop.click'
  readonly category = 'compute'
  readonly name = 'Click'
  readonly description = 'clicks a point'
  readonly permission = 'low_risk'
  readonly inputSchema = {
    type: 'object' as const,
    properties: { window_id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
    required: ['window_id'],
  }
  readonly requiresPermission = false
  readonly verifiable = true
  clicks = 0
  canRun(): boolean {
    return true
  }
  async execute(_input: ToolInput): Promise<ToolResult> {
    this.clicks += 1
    return { ok: true, message: 'clicked', data: { ok: true } }
  }
  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    return { ok: true, message: 'confirmed', checks: ['effect'] }
  }
}

class StatusTool implements Tool {
  readonly id = 'window.status'
  readonly category = 'compute'
  readonly name = 'Window status'
  readonly description = 'reports a window'
  readonly permission = 'read_only'
  readonly inputSchema = { type: 'object' as const, properties: {}, required: [] }
  readonly requiresPermission = false
  readonly verifiable = true
  calls = 0
  canRun(): boolean {
    return true
  }
  async execute(): Promise<ToolResult> {
    this.calls += 1
    return { ok: true, message: 'window open', data: { open: true } }
  }
  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    return { ok: true, message: 'confirmed', checks: ['effect'] }
  }
}

const clickCapability: CapabilityDefinition = {
  id: 'click_at',
  name: 'Click at',
  description: 'click a point on a window',
  category: 'desktop',
  tools: ['desktop.click'],
  contexts: ['desktop'],
  riskLevel: 'action',
  risk: 'medium',
  destructive: false,
  readOnly: false,
  verification: 'strong',
}

function runGoal(script: AIResponse[], tools: Tool[], goal: string, capabilities?: CapabilityDefinition[]) {
  const provider = new ScriptedProvider(script)
  const engine = new AssistantEngine({ providers: [provider], capabilities })
  for (const tool of tools) engine.registerTool(tool)
  engine.on(() => undefined)
  return { engine, provider, run: () => engine.process(goal) }
}

describe('Phase 2.3 — capability layer through the engine', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('resolves an explicitly named capability to its registered tool and runs it', async () => {
    const tool = new ClickTool()
    const { engine, run } = runGoal(
      [req('anything', { window_id: '1', x: 1, y: 1 }, 'click_at'), text('done')],
      [tool],
      'click it',
      [clickCapability],
    )
    await run()
    expect(engine.taskResult().status).toBe('completed')
    expect(tool.clicks).toBe(1)
    const plan = engine.goalPlan()
    expect(plan.steps[0].toolId).toBe('desktop.click')
    expect(plan.steps[0].capability).toBe('click_at')
    const events = engine.lastRunTrace().events ?? []
    expect(events.some((e) => e.type === 'capability_requested' && e.capability === 'click_at')).toBe(true)
    expect(events.some((e) => e.type === 'capability_resolved' && e.toolId === 'desktop.click' && e.fallback === false)).toBe(true)
    expect(events.some((e) => e.type === 'tool_selected' && e.toolId === 'desktop.click' && e.capability === 'click_at')).toBe(true)
  })

  it('accepts a REGISTERED capability id in the toolId slot', async () => {
    const tool = new ClickTool()
    const { engine, run } = runGoal(
      [req('click_at', { window_id: '1', x: 2, y: 2 }), text('done')],
      [tool],
      'click via slot',
      [clickCapability],
    )
    await run()
    expect(engine.taskResult().status).toBe('completed')
    expect(tool.clicks).toBe(1)
    const plan = engine.goalPlan()
    expect(plan.steps[0].capability).toBe('click_at')
    expect(plan.steps[0].toolId).toBe('desktop.click')
  })

  it('executes the concrete tool even when the capability name differs from the tool id', async () => {
    const click = new ClickTool()
    const { run } = runGoal(
      [req('ignored_slot', { window_id: '1', x: 3, y: 3 }, 'click_at'), text('done')],
      [click],
      'click explicitly',
      [clickCapability],
    )
    await run()
    expect(click.clicks).toBe(1)
  })

  it('bounded fallback: an admin capability prefers an unregistered tool and falls back', async () => {
    const fallback: CapabilityDefinition = {
      ...clickCapability,
      id: 'punch_at',
      tools: ['desktop.move', 'desktop.click'],
    }
    const click = new ClickTool()
    const { engine, run } = runGoal([req('punch_at', { window_id: '1', x: 4, y: 4 }), text('done')], [click], 'punch it', [fallback])
    await run()
    expect(engine.taskResult().status).toBe('completed')
    expect(click.clicks).toBe(1)
    const events = engine.lastRunTrace().events ?? []
    expect(events.some((e) => e.type === 'capability_fallback' && e.capability === 'punch_at' && e.from === 'desktop.move' && e.to === 'desktop.click')).toBe(true)
    const plan = engine.goalPlan()
    expect(plan.steps[0].toolId).toBe('desktop.click')
  })

  it('an unregistered capability name is refused and the run keeps honest replan tracking', async () => {
    const click = new ClickTool()
    const { engine, run } = runGoal(
      [req('whatever', {}, 'not_a_capability'), req('click_at', { window_id: '1', x: 5, y: 5 }, 'click_at'), text('done')],
      [click],
      'click properly',
      [clickCapability],
    )
    await run()
    expect(click.clicks).toBe(1)
    expect(engine.taskResult().status).toBe('completed')
    const events = engine.lastRunTrace().events ?? []
    expect(events.some((e) => e.type === 'capability_requested' && e.capability === 'not_a_capability')).toBe(true)
    expect(events.some((e) => e.type === 'capability_rejected' && e.capability === 'not_a_capability' && e.code === 'capability_unregistered')).toBe(true)
    const plan = engine.goalPlan()
    // The refused step never ran and never became a tracker step.
    expect(plan.steps.every((s) => s.capability !== 'not_a_capability')).toBe(true)
  })

  it('capabilities are never exposed when no implementation tool is registered', async () => {
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([text('done')])] })
    engine.on(() => undefined)
    // No tool registered → click_at never enters the catalogue.
    expect(engine.capabilityCatalog().some((c) => c.id === 'click_at')).toBe(false)
    expect(engine.capabilityCatalog().every((c) => c.tools.length > 0)).toBe(true)
  })

  it('admin capabilities survive even when declared preferred tools are unregistered (honest catalogue)', async () => {
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([text('done')])], capabilities: [clickCapability] })
    engine.on(() => undefined)
    // Explicitly granted capabilities stay in the catalogue; the resolution
    // layer honestly reports them unimplementable until a tool registers.
    expect(engine.capabilityCatalog().some((c) => c.id === 'click_at')).toBe(true)
  })

  it('tool registrations are NOT synthesized from capability declarations', async () => {
    const click = new ClickTool()
    const { provider, run } = runGoal([req('whatever', {}, 'click_at'), text('done')], [click], 'click it', [clickCapability])
    await run()
    // desktop.move was never registered: the provider is never told a tool that
    // exists only in a capability wish-list, and it cannot run here.
    const last = provider.requests[provider.requests.length - 1]
    expect(last.availableTools.includes('desktop.move')).toBe(false)
  })

  describe('Phase 2.4 — capability intelligence through the engine', () => {
    beforeEach(() => {
      stubBrowserStorage()
      useConversationStore.getState().clearConversation()
    })

    it('application-flagged confirmation refuses cleanly: nothing runs, no reliability recorded', async () => {
      const confirmed: CapabilityDefinition = {
        ...clickCapability,
        requiresConfirmation: true,
      }
      const click = new ClickTool()
      const provider = new ScriptedProvider([
        req('click_at', { window_id: '1', x: 1, y: 1 }, 'click_at'),
        text('done'),
      ])
      const engine = new AssistantEngine({ providers: [provider], capabilities: [confirmed] })
      engine.registerTool(click)
      const events: EngineOutMessage[] = []
      engine.on((m) => events.push(m))

      const pending = engine.process('click it')
      await waitForType(events, 'tool-confirm')
      expect(engine.hasPendingConfirmation).toBe(true)

      engine.cancelPending()
      await pending

      expect(click.clicks).toBe(0)
      const plan = engine.goalPlan()
      const step = plan.steps[0]
      expect(step.capability).toBe('click_at')
      expect(step.state).toBe('failed')
      expect(step.capabilityMeta?.requiresConfirmation).toBe(true)
      const trace = engine.lastRunTrace().events ?? []
      expect(trace.some((e) => e.type === 'confirmation_required' && e.capability === 'click_at')).toBe(true)
      expect(trace.some((e) => e.type === 'confirmation_refused' && e.capability === 'click_at')).toBe(true)
      expect(trace.some((e) => e.type === 'step_failed')).toBe(true)
      // A declined capability never happened: it is not counted as history.
      expect(engine.capabilityReliabilitySnapshot.size).toBe(0)
    })

    it('explicit confirmation lets the capability run and records executed reliability', async () => {
      const confirmed: CapabilityDefinition = {
        ...clickCapability,
        requiresConfirmation: true,
      }
      const click = new ClickTool()
      const provider = new ScriptedProvider([
        req('click_at', { window_id: '1', x: 2, y: 2 }, 'click_at'),
        text('done'),
      ])
      const engine = new AssistantEngine({ providers: [provider], capabilities: [confirmed] })
      engine.registerTool(click)
      const events: EngineOutMessage[] = []
      engine.on((m) => events.push(m))

      const pending = engine.process('click it')
      await waitForType(events, 'tool-confirm')
      await engine.confirmPending()
      await pending

      expect(click.clicks).toBe(1)
      const plan = engine.goalPlan()
      const step = plan.steps[0]
      expect(step.state).toBe('verified')
      // Engine-computed, UI-safe preview: no scores, no chain-of-thought.
      expect(step.capabilityMeta).toMatchObject({
        risk: 'medium',
        permission: 'write',
        verification: 'strong',
        requiresConfirmation: true,
      })
      const record = engine.capabilityReliabilitySnapshot.get('click_at::desktop.click')
      expect(record).toBeDefined()
      expect(['success', 'verified_success']).toContain(record?.lastOutcome)
    })

    it('reliability is per-instance learning: entries persist across runs', async () => {
      const confirmed: CapabilityDefinition = {
        ...clickCapability,
        requiresConfirmation: true,
      }
      const click = new ClickTool()
      const provider = new ScriptedProvider([
        req('click_at', { window_id: '1', x: 3, y: 3 }, 'click_at'),
        text('done'),
        req('click_at', { window_id: '1', x: 4, y: 4 }, 'click_at'),
        text('done'),
      ])
      const engine = new AssistantEngine({ providers: [provider], capabilities: [confirmed] })
      engine.registerTool(click)
      const events: EngineOutMessage[] = []
      engine.on((m) => events.push(m))

      let pending = engine.process('first click')
      await waitForType(events, 'tool-confirm')
      await engine.confirmPending()
      await pending
      const first = engine.capabilityReliabilitySnapshot.get('click_at::desktop.click')
      expect(first).toBeDefined()
      // Drop the first round's events so the second round's signal is fresh.
      events.length = 0

      pending = engine.process('second click')
      await waitForType(events, 'tool-confirm')
      await engine.confirmPending()
      await pending

      expect(click.clicks).toBe(2)
      // Same (capability, tool) key is updated — never duplicated.
      expect(engine.capabilityReliabilitySnapshot.size).toBe(1)
      const second = engine.capabilityReliabilitySnapshot.get('click_at::desktop.click')
      expect((second?.successes ?? 0) + (second?.verifiedSuccesses ?? 0) + (second?.failures ?? 0)).toBeGreaterThanOrEqual(2)
    })

    it('surfaces ranking and application-policy-filtered drops for multi-implementation capabilities', async () => {
      const inspect: CapabilityDefinition = {
        ...clickCapability,
        id: 'inspect_windows',
        name: 'Inspect windows',
        tools: ['window.status', 'desktop.click'],
        risk: 'read_only',
        riskLevel: 'read_only',
        destructive: false,
        readOnly: true,
        verification: 'none',
        // Application-owned ceiling: desktop.click (write) is above 'read'.
        maximumPermission: 'read',
      }
      const status = new StatusTool()
      const click = new ClickTool()
      const engine = new AssistantEngine({
        providers: [new ScriptedProvider([req('inspect_windows', {}, 'inspect_windows'), text('done')])],
        capabilities: [inspect],
      })
      engine.registerTool(status)
      engine.registerTool(click)
      engine.on(() => undefined)

      await engine.process('inspect the window')

      expect(click.clicks).toBe(0)
      expect(status.calls).toBe(1)
      const plan = engine.goalPlan()
      expect(plan.steps[0].toolId).toBe('window.status')
      expect(plan.steps[0].capabilityMeta).toMatchObject({ risk: 'read_only', permission: 'read' })
      const trace = engine.lastRunTrace().events ?? []
      const rankedEvent = trace.find((e) => e.type === 'capability_ranked' && e.capability === 'inspect_windows')
      expect((rankedEvent as { ranked?: string[] }).ranked).toEqual(['window.status'])
      expect(
        trace.some(
          (e) =>
            e.type === 'policy_filtered' &&
            e.capability === 'inspect_windows' &&
            e.toolId === 'desktop.click' &&
            typeof e.reason === 'string' &&
            e.reason.includes('ceiling'),
        ),
      ).toBe(true)
    })
  })
})

async function waitForType(events: EngineOutMessage[], type: EngineOutMessage['type']): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (events.some((m) => m.type === type)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out waiting for ${type}`)
}