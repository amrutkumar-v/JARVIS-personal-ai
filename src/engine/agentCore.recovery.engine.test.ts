import { describe, expect, it, beforeEach } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from './provider'
import type { Tool, ToolContext, ToolInput, ToolResult, ToolVerification } from '../tools/Tool'
import { useConversationStore } from '../state/conversation.store'
import { FakeObservationProvider } from '../observation/testing'

/**
 * Phase 2.2 — FAILURE CLASSIFICATION & BOUNDED RECOVERY through the REAL
 * engine loop. Recovery is applied by the ENGINE after each failing round:
 * replans are bounded (maxReplans), the exact failing plan may not be
 * repeated verbatim, and the same (tool, payload) may not fail in a loop.
 * Budgets, evidence and trace are never reset across replans.
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

function req(toolId: string, payload: Record<string, unknown> = {}, dependsOn?: Array<string | number>): AIResponse {
  return { text: '', toolRequests: [{ toolId, payload, ...(dependsOn ? { dependsOn } : {}) }] }
}

/** One round can carry SEVERAL requests; they execute in order in a single pass. */
function round(
  calls: Array<{ toolId: string; payload?: Record<string, unknown>; dependsOn?: Array<string | number> }>,
): AIResponse {
  return {
    text: '',
    toolRequests: calls.map((c) => ({
      toolId: c.toolId,
      payload: c.payload ?? {},
      ...(c.dependsOn ? { dependsOn: c.dependsOn } : {}),
    })),
  }
}

function text(value: string): AIResponse {
  return { text: value }
}

type ClickMode = 'verified' | 'refuted' | 'fails'

class ClickTool implements Tool {
  readonly id = 'desktop.click'
  readonly category = 'compute'
  readonly name = 'Click'
  readonly description = 'clicks a point'
  readonly permission = 'low_risk'
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      window_id: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
    },
    required: ['window_id'],
  }
  readonly requiresPermission = false
  readonly verifiable = true
  clicks = 0
  mode: ClickMode = 'verified'
  /** Refute the first `refuteFirstNClicks` clicks, then verify. */
  refuteFirstNClicks = 0

  canRun(): boolean {
    return true
  }

  async execute(_input: ToolInput): Promise<ToolResult> {
    this.clicks += 1
    if (this.mode === 'fails') return { ok: false, message: 'The desktop driver refused the click.' }
    return { ok: true, message: 'clicked', data: { ok: true } }
  }

  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    if (this.mode === 'refuted' || this.clicks <= this.refuteFirstNClicks) {
      return { ok: false, message: 'The click did not produce its expected effect.', checks: ['effect'] }
    }
    return { ok: true, message: 'confirmed', checks: ['effect'] }
  }
}

class NotesTool implements Tool {
  readonly id = 'notes.get'
  readonly category = 'memory'
  readonly name = 'Notes Get'
  readonly description = 'reads a note'
  readonly permission = 'read_only'
  readonly inputSchema = { type: 'object' as const, properties: {}, required: [] }
  readonly requiresPermission = false
  canRun(): boolean {
    return true
  }
  async execute(): Promise<ToolResult> {
    return { ok: true, message: 'none' }
  }
}

function runGoal(
  script: AIResponse[],
  tools: Tool[],
  goal: string,
  opts?: { goalLimits?: { maxTaskSteps?: number; maxRecoveryAttempts?: number; maxReplans?: number }; observation?: boolean },
) {
  const provider = new ScriptedProvider(script)
  const engine = new AssistantEngine({
    providers: [provider],
    goalLimits: opts?.goalLimits,
    observation: opts?.observation ? new FakeObservationProvider([]) : undefined,
  })
  for (const tool of tools) engine.registerTool(tool)
  engine.on(() => undefined)
  return { engine, provider, run: () => engine.process(goal) }
}

describe('Phase 2.2 — bounded replanning through the engine', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('continues after a refuted step: one replan then a corrected plan completes the goal', async () => {
    const tool = new ClickTool()
    tool.refuteFirstNClicks = 1
    const { engine, run } = runGoal(
      [req('desktop.click', { window_id: '1', x: 1, y: 1 }), req('desktop.click', { window_id: '1', x: 2, y: 2 }), text('Done.')],
      [tool],
      'click until it works',
    )

    await run()

    expect(engine.taskResult().status).toBe('completed')
    expect(tool.clicks).toBe(2)
    const recovery = engine.goalRecovery()
    expect(recovery.replans).toBe(1)
    expect(recovery.verificationFailures).toBe(1)
    const events = engine.lastRunTrace().events ?? []
    expect(events.some((e) => e.type === 'replan_accepted')).toBe(true)
    expect(events.some((e) => e.type === 'recovery_classified')).toBe(true)
  })

  it('repeated refutations NEVER reset the trace: evidence accumulates across replans', async () => {
    const tool = new ClickTool()
    tool.refuteFirstNClicks = 2
    const { engine, run } = runGoal(
      [req('desktop.click', { window_id: '1', x: 1, y: 1 }), req('desktop.click', { window_id: '1', x: 2, y: 2 }), req('desktop.click', { window_id: '1', x: 3, y: 3 }), text('done')],
      [tool],
      'click thrice',
    )

    await run()

    const trace = engine.lastRunTrace()
    expect(trace.steps).toHaveLength(3)
    expect(engine.goalRecovery().verificationFailures).toBe(2)
    expect(engine.goalRecovery().replans).toBe(2)
    // Budgets are never reset: three executions still count against the task budget.
    expect(engine.goalLimitsInfo().maxReplans).toBe(3)
    expect(engine.taskResult().executedSteps).toBe(3)
  })
})

describe('Phase 2.2 — replan guards stop loops', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('repeating the exact failing plan verbatim aborts the goal (identical_replan)', async () => {
    const tool = new ClickTool()
    tool.mode = 'refuted'
    const same = req('desktop.click', { window_id: '1', x: 1, y: 1 })
    const { engine, run } = runGoal([same, same, text('I swear it worked!')], [tool], 'click')

    await run()

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('failed')
    expect(engine.taskResult().status).toBe('failed')
    expect(tool.clicks).toBe(2)
    const events = trace.events ?? []
    expect(events.some((e) => e.type === 'repeated_failure_detected' && e.kind === 'identical_replan')).toBe(true)
    expect(engine.goalRecovery().replans).toBe(1)
  })

  it('the same (tool, payload) failing across DIFFERENT plans aborts via the same_action guard', async () => {
    const tool = new ClickTool()
    tool.refuteFirstNClicks = 2
    const failing = { window_id: '1', x: 1, y: 1 }
    const { engine, run } = runGoal(
      [
        req('desktop.click', failing),
        round([
          { toolId: 'desktop.click', payload: failing },
          { toolId: 'notes.get', dependsOn: [0] },
        ]),
        text('No more steps'),
      ],
      [tool, new NotesTool()],
      'click',
    )

    await run()

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('failed')
    const events = trace.events ?? []
    expect(events.some((e) => e.type === 'repeated_failure_detected' && e.kind === 'same_action')).toBe(true)
  })

  it('crossing the replan ceiling is a hard stop that never silently loops', async () => {
    const tool = new ClickTool()
    tool.mode = 'refuted'
    const script: AIResponse[] = []
    for (let i = 0; i < 3; i += 1) {
      script.push(req('desktop.click', { window_id: '1', x: i, y: i }))
    }
    script.push(text('tried it all'))
    const { engine, run } = runGoal(script, [tool], 'keep trying', { goalLimits: { maxReplans: 2, maxRecoveryAttempts: 5 } })

    await run()

    expect(tool.clicks).toBe(3)
    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('failed')
    expect(engine.taskResult().status).toBe('failed')
    expect(engine.goalRecovery().replans).toBe(2)
  })
})

describe('Phase 2.2 — declared dependencies gate execution (engine-enforced)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('a dependent step whose prerequisite failed is BLOCKED and never runs', async () => {
    const tool = new ClickTool()
    tool.mode = 'fails'
    const { engine, run } = runGoal(
      [
        round([
          { toolId: 'desktop.click', payload: { window_id: '1', x: 1, y: 1 } },
          { toolId: 'notes.get', dependsOn: [0] },
        ]),
        req('desktop.click', { window_id: '1', x: 2, y: 2 }),
        text('final'),
      ],
      [tool, new NotesTool()],
      'click then read',
    )

    await run()

    // The blocked dependent never executed; the corrected plan's click ran.
    expect(tool.clicks).toBe(2)
    const plan = engine.goalPlan()
    expect(plan.steps[1].state).toBe('blocked')
    expect(plan.steps[1].note).toMatch(/depends on an earlier step/)
    const trace = engine.lastRunTrace()
    expect(trace.events?.some((e) => e.type === 'step_blocked')).toBe(true)
  })

  it('a dependent step runs once its prerequisite COMPLETED (verified), no block', async () => {
    const tool = new ClickTool()
    const { engine, run } = runGoal(
      [
        round([
          { toolId: 'desktop.click', payload: { window_id: '1', x: 1, y: 1 } },
          { toolId: 'notes.get', dependsOn: [0] },
        ]),
        text('read it'),
      ],
      [tool, new NotesTool()],
      'click then read',
    )

    await run()

    const plan = engine.goalPlan()
    expect(plan.steps[0].state).toBe('verified')
    // notes.get is not verifiable, so it completed as "unverified" — but it RAN (not blocked).
    expect(plan.steps[1].state).toBe('unverified')
    expect(plan.steps[1].note).toBeUndefined()
    expect(engine.taskResult().status).toBe('completed')
  })
})

describe('Phase 2.2 — reobserve classification when a re-observer is attached', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('a refuted step reobserves instead of replanning when an observation surface exists', async () => {
    const tool = new ClickTool()
    tool.refuteFirstNClicks = 1
    const { engine, run } = runGoal(
      [req('desktop.click', { window_id: '1', x: 1, y: 1 }), req('desktop.click', { window_id: '1', x: 2, y: 2 }), text('ok')],
      [tool],
      'click',
      { observation: true },
    )

    await run()

    const recovery = engine.goalRecovery()
    expect(recovery.replans).toBe(0)
    expect(recovery.verificationFailures).toBe(1)
    expect(engine.taskResult().status).toBe('completed')
    const events = engine.lastRunTrace().events ?? []
    const reobserve = events.find((e) => e.type === 'recovery_classified')
    expect(reobserve).toMatchObject({ action: 'reobserve', kind: 'stale_observation' })
    expect(events.some((e) => e.type === 'recovery_attempted')).toBe(true)
  })
})