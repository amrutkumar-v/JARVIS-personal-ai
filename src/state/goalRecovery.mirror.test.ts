import { describe, expect, it } from 'vitest'
import { syncGoalRun } from './goalRun'
import { useJarvisStore } from './jarvis.store'
import { useConversationStore } from './conversation.store'
import { AssistantEngine } from '../engine/AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from '../engine/provider'
import type { Tool, ToolContext, ToolInput, ToolResult, ToolVerification } from '../tools/Tool'

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
  private readonly queue: AIResponse[] = []
  constructor(script: AIResponse[]) {
    this.queue = [...script]
  }
  async generate(_request: AIRequest): Promise<AIResponse> {
    const next = this.queue.shift()
    if (!next) return { text: 'No more scripted steps.' }
    return next
  }
  isConfigured(): boolean {
    return true
  }
  async isReachable(): Promise<boolean> {
    return true
  }
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
  refuteFirstNClicks = 0

  canRun(): boolean {
    return true
  }
  async execute(): Promise<ToolResult> {
    this.clicks += 1
    return { ok: true, message: 'clicked', data: { ok: true } }
  }
  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    if (this.clicks <= this.refuteFirstNClicks) {
      return { ok: false, message: 'The click did not produce its expected effect.', checks: ['effect'] }
    }
    return { ok: true, message: 'confirmed', checks: ['effect'] }
  }
}

const refutedThenVerified = [
  { text: '', toolRequests: [{ toolId: 'desktop.click', payload: { window_id: '1', x: 1, y: 1 } }] },
  { text: '', toolRequests: [{ toolId: 'desktop.click', payload: { window_id: '1', x: 2, y: 2 } }] },
  { text: 'Done.' },
]

const cleanRoute = [{ text: '', toolRequests: [{ toolId: 'desktop.click', payload: { window_id: '1', x: 5, y: 5 } }] }, { text: 'Done.' }]

describe('Phase 2.2 — store mirrors ENGINE recovery counters verbatim (no inference)', () => {
  it('after a refuted step + replan, the goalRun snapshot carries the engine recovery counters', async () => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    useJarvisStore.getState().setGoalMode('goal')
    useJarvisStore.getState().setGoalRun(null)

    const tool = new ClickTool()
    tool.refuteFirstNClicks = 1
    const engine = new AssistantEngine({
      providers: [new ScriptedProvider(refutedThenVerified)],
      goalLimits: { maxReplans: 3 },
    })
    engine.registerTool(tool)
    engine.on(() => undefined)

    await engine.process('click until it works')

    const snap = syncGoalRun(
      engine,
      () => useJarvisStore.getState().goalMode,
      (s) => useJarvisStore.getState().setGoalRun(s),
    )

    // The mirror shows exactly the engine numbers: one refuted verification,
    // one replan, default ceilings. Nothing is derived on the store side.
    expect(snap.recovery).toEqual({
      verificationFailures: 1,
      maxRecoveryAttempts: 2,
      replans: 1,
      maxReplans: 3,
      active: false,
    })
    expect(snap.limits).toEqual({ maxTaskSteps: 10, maxRecoveryAttempts: 2, maxReplans: 3 })
    expect(snap.task?.status).toBe('completed')
    expect(snap.task?.recoveries).toBe(1)
    expect(useJarvisStore.getState().goalRun?.recovery.replans).toBe(1)
    expect(tool.clicks).toBe(2)
  })

  it('recovery counters accumulate across replans in the mirror and never reset', async () => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    useJarvisStore.getState().setGoalMode('goal')

    const tool = new ClickTool()
    tool.refuteFirstNClicks = 2
    const engine = new AssistantEngine({
      providers: [
        new ScriptedProvider([
          { text: '', toolRequests: [{ toolId: 'desktop.click', payload: { window_id: '1', x: 1, y: 1 } }] },
          { text: '', toolRequests: [{ toolId: 'desktop.click', payload: { window_id: '1', x: 2, y: 2 } }] },
          { text: '', toolRequests: [{ toolId: 'desktop.click', payload: { window_id: '1', x: 3, y: 3 } }] },
          { text: 'done' },
        ]),
      ],
      goalLimits: { maxReplans: 3 },
    })
    engine.registerTool(tool)
    engine.on(() => undefined)
    await engine.process('click thrice')

    const snap = syncGoalRun(
      engine,
      () => useJarvisStore.getState().goalMode,
      (s) => useJarvisStore.getState().setGoalRun(s),
    )

    expect(snap.recovery.verificationFailures).toBe(2)
    expect(snap.recovery.replans).toBe(2)
    expect(snap.task?.recoveries).toBe(2)
    expect(snap.task?.executedSteps).toBe(3)
    // The engine trace grew every replan — the store snapshot shows all three steps.
    expect(snap.plan.steps).toHaveLength(3)
  })

  it('a clean route never manufactures recovery entries', async () => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()

    const tool = new ClickTool()
    const engine = new AssistantEngine({
      providers: [new ScriptedProvider(cleanRoute)],
    })
    engine.registerTool(tool)
    engine.on(() => undefined)
    await engine.process('click once')

    const snap = syncGoalRun(
      engine,
      () => 'goal',
      (s) => useJarvisStore.getState().setGoalRun(s),
    )
    expect(snap.recovery.verificationFailures).toBe(0)
    expect(snap.recovery.replans).toBe(0)
    expect(snap.task?.recoveries).toBe(0)
    expect(snap.task?.status).toBe('completed')
    expect(tool.clicks).toBe(1)
  })
})