import { describe, expect, it, beforeEach } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from './provider'
import type { Tool, ToolContext, ToolInput, ToolResult, ToolVerification } from '../tools/Tool'
import { useJarvisStore } from '../state/jarvis.store'
import { useConversationStore } from '../state/conversation.store'
import { FakeObservationProvider } from '../observation/testing'
import { FakeDesktopInteractionProvider } from '../desktop/testing'
import { createFakeVisionProvider } from '../vision/testing'
import { VoiceManager } from '../voice/voiceManager'
import { FakeWakeWordProvider, FakeSpeechToTextProvider, FakeTextToSpeechProvider } from '../voice/testing'

/**
 * Phase 2.0 — Goal-Directed Task Execution through the REAL engine loop.
 * One run is one goal: the model's plans arrive as each round's tool requests;
 * the engine validates them, executes one step at a time through every
 * existing rail, and derives an evidence-based verdict AFTER the run ends.
 * A quoted scripted provider keeps everything deterministic.
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

/** Provider that cancels the engine between round 1 and round 2 (a mid-goal
 *  user cancellation while the model is still producing its next plan). */
class CancelAfterFirstRoundProvider extends ScriptedProvider {
  private readonly doCancel: () => void

  constructor(script: AIResponse[], doCancel: () => void) {
    super(script)
    this.doCancel = doCancel
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    // First generate call has requests.length === 0; the second is triggered
    // only AFTER round 1 executed, so cancel exactly between the rounds.
    const shouldCancel = this.requests.length === 1
    const response = await super.generate(request)
    if (shouldCancel) this.doCancel()
    return response
  }
}

function req(toolId: string, payload: Record<string, unknown> = {}): AIResponse {
  return { text: '', toolRequests: [{ toolId, payload }] }
}

function text(value: string): AIResponse {
  return { text: value }
}

/** Actionable `desktop.click` with a per-instance verifier mode. */
type ClickMode = 'verified' | 'refuted' | 'unverified'
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
  /** Refute the first N clicks, then verify (bounded-recovery scenario). */
  refuteFirstNClicks = 0

  canRun(): boolean {
    return true
  }

  async execute(_input: ToolInput): Promise<ToolResult> {
    this.clicks += 1
    return { ok: true, message: 'clicked', data: { ok: true } }
  }

  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    if (this.mode === 'unverified') throw new Error('No expected visible state was supplied.')
    if (this.mode === 'refuted' || this.clicks <= this.refuteFirstNClicks) {
      return { ok: false, message: 'The click did not produce its expected effect.', checks: ['effect'] }
    }
    return { ok: true, message: 'confirmed', checks: ['effect'] }
  }
}

/** Read-only tool for Q&A runs. */
class ReadOnlyTool implements Tool {
  readonly id = 'info.get'
  readonly category = 'compute'
  readonly name = 'Info Get'
  readonly description = 'returns an answer'
  readonly permission = 'read_only'
  readonly inputSchema = { type: 'object' as const, properties: {}, required: [] }
  readonly requiresPermission = false
  canRun(): boolean {
    return true
  }
  async execute(): Promise<ToolResult> {
    return { ok: true, message: '42' }
  }
}

function runGoal(script: AIResponse[], tool: Tool, goal: string, goalLimits?: { maxTaskSteps?: number; maxRecoveryAttempts?: number }) {
  const provider = new ScriptedProvider(script)
  const engine = new AssistantEngine({ providers: [provider], goalLimits })
  engine.registerTool(tool)
  engine.on(() => undefined)
  return { engine, provider, run: () => engine.process(goal) }
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

describe('Phase 2.0 — goal cases through the engine', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('GOAL→PLAN→EXECUTE→VERIFY: a verified click completes the goal with evidence', async () => {
    const tool = new ClickTool()
    tool.mode = 'verified'
    const { engine, run } = runGoal([req('desktop.click', { window_id: '1', x: 1, y: 1 }), text('Done.')], tool, 'click the point')

    await run()

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(tool.clicks).toBe(1)
    // PLAN vs EXECUTION vs EVIDENCE vs RESULT stay distinguishable.
    const task = trace.task!
    expect(task.status).toBe('completed')
    expect(task.evidence).toEqual({ kind: 'action_verified' })
    expect(task.actionable).toBe(true)
    expect(task.verifiedSteps).toBe(1)
    // The verdict never comes from the model's closing text.
    expect(engine.taskResult().reason).toMatch(/verified/i)
  })

  it('multi-step goals follow a bounded sequence, step by step', async () => {
    const tool = new ClickTool()
    const { engine, run } = runGoal(
      [
        req('desktop.click', { window_id: '1', x: 10, y: 10 }),
        req('desktop.click', { window_id: '1', x: 20, y: 20 }),
        text('All done.'),
      ],
      tool,
      'click twice',
    )

    await run()

    const task = engine.taskResult()
    expect(tool.clicks).toBe(2)
    expect(task.status).toBe('completed')
    expect(task.executedSteps).toBe(2)
    expect(task.verifiedSteps).toBe(2)
  })

  it('an UNVERIFIED final action does NOT complete the goal — and the reply admits it', async () => {
    const tool = new ClickTool()
    tool.mode = 'unverified'
    const { engine, run } = runGoal([req('desktop.click', { window_id: '1', x: 1, y: 1 }), text('Done!')], tool, 'click the point')

    await run()

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed') // the RUN finished normally
    const task = trace.task!
    expect(task.status).toBe('unverified') // the GOAL was not proven
    expect(task.unverifiedSteps).toBe(1)
    // The assistant must say it did not prove success.
    expect(useJarvisStore.getState().lastAssistantText).toMatch(/not claiming the goal was achieved/)
  })

  it('a provider "success" CLAIM without evidence is rejected — the goal stays unverified', async () => {
    const tool = new ClickTool()
    tool.mode = 'unverified'
    const { engine, run } = runGoal(
      [req('desktop.click', { window_id: '1', x: 1, y: 1 }), text('The goal was fully achieved and verified.')],
      tool,
      'click the point',
    )

    await run()

    expect(engine.taskResult().status).toBe('unverified')
  })

  it('a REFUTED final action means the goal was NOT achieved', async () => {
    const tool = new ClickTool()
    tool.mode = 'refuted'
    const { engine, run } = runGoal([req('desktop.click', { window_id: '1', x: 1, y: 1 }), text('It should have worked.')], tool, 'click the point')

    await run()

    const task = engine.lastRunTrace().task!
    expect(task.status).toBe('failed')
    expect(task.refutedSteps).toBe(1)
    expect(task.reason).toMatch(/NOT achieved/i)
  })

  it('controlled recovery: a refuted step can be replanned, then verified', async () => {
    const tool = new ClickTool()
    // Round 1 refutes, round 2 verifies — one recovery, within the ceiling.
    tool.refuteFirstNClicks = 1
    const { engine, run } = runGoal(
      [
        { text: '', toolRequests: [{ toolId: 'desktop.click', payload: { window_id: '1', x: 1, y: 1 } }] },
        { text: '', toolRequests: [{ toolId: 'desktop.click', payload: { window_id: '1', x: 9, y: 9 } }] },
        text('Recovered.'),
      ],
      tool,
      'click until it works',
    )

    await run()

    const task = engine.taskResult()
    expect(tool.clicks).toBe(2)
    expect(task.status).toBe('completed')
    expect(task.recoveries).toBe(1)
  })

  it('recovery is BOUNDED: crossing the ceiling stops the run before the next action', async () => {
    const tool = new ClickTool()
    tool.mode = 'refuted'
    const script: AIResponse[] = []
    for (let i = 0; i < 3; i += 1) {
      script.push({ text: '', toolRequests: [{ toolId: 'desktop.click', payload: { window_id: '1', x: i, y: i } }] })
    }
    script.push(req('desktop.click', { window_id: '1', x: 99, y: 99 }))
    script.push(text('It worked this time!'))
    const { engine, run } = runGoal(script, tool, 'keep trying')

    await run()

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('failed')
    expect(engine.taskResult().status).toBe('blocked')
    // Three refuted attempts happened; the FOURTH click was never injected.
    expect(tool.clicks).toBe(3)
    expect(engine.taskResult().recoveries).toBe(3)
  })
})

describe('Phase 2.0 — plan validation at runtime (untrusted model output)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('rejects a plan that tries to set an engine-managed parameter', async () => {
    const tool = new ClickTool()
    const { engine, run } = runGoal(
      [req('desktop.click', { window_id: '1', x: 1, y: 1, permission: 'admin' }), text('I tried.')],
      tool,
      'click',
    )

    await run()

    expect(tool.clicks).toBe(0)
    const trace = engine.lastRunTrace()
    expect(trace.steps[0].observation?.errorKind).toBe('plan_rejected')
    expect(engine.taskResult().status).toBe('blocked')
  })

  it('rejects unsupported tools (shell/exec) before execution', async () => {
    const tool = new ClickTool()
    const { engine, run } = runGoal(
      [req('shell.exec', { command: 'rm -rf /' }), text('...)')],
      tool,
      'run the command',
    )

    await run()

    expect(tool.clicks).toBe(0)
    expect(engine.lastRunTrace().steps[0].observation?.errorKind).toBe('plan_rejected')
    expect(engine.lastRunTrace().steps[0].observation?.summary).toMatch(/not a registered tool/i)
  })

  it('rejects undeclared parameters on a registered tool (argv injection)', async () => {
    const tool = new ClickTool()
    const { engine, run } = runGoal(
      [req('desktop.click', { window_id: '1', x: 1, y: 1, argv: ['--force'] }), text('ok')],
      tool,
      'click',
    )

    await run()

    expect(tool.clicks).toBe(0)
    expect(engine.lastRunTrace().steps[0].observation?.errorKind).toBe('plan_rejected')
  })

  it('refuses a single batch that would exceed the goal budget', async () => {
    const tool = new ClickTool()
    const { engine, run } = runGoal(
      [
        {
          text: '',
          toolRequests: [
            { toolId: 'desktop.click', payload: { window_id: '1', x: 1, y: 1 } },
            { toolId: 'desktop.click', payload: { window_id: '1', x: 2, y: 2 } },
            { toolId: 'desktop.click', payload: { window_id: '1', x: 3, y: 3 } },
          ],
        },
        text('done'),
      ],
      tool,
      'click three times',
      { maxTaskSteps: 2 },
    )

    await run()

    expect(tool.clicks).toBe(2)
    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('COMPLETED')
    expect(trace.steps[1].status).toBe('COMPLETED')
    expect(trace.steps[2].status).toBe('FAILED')
    expect(trace.steps[2].observation?.errorKind).toBe('plan_rejected')
    expect(engine.taskResult().status).toBe('blocked')
  })
})

describe('Phase 2.0 — goal task budget (engine-owned)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('the budget is separate, reports remaining, and blocks on exhaustion', async () => {
    const tool = new ClickTool()
    const { engine, run } = runGoal(
      [
        req('desktop.click', { window_id: '1', x: 1, y: 1 }),
        req('desktop.click', { window_id: '1', x: 2, y: 2 }),
        req('desktop.click', { window_id: '1', x: 3, y: 3 }),
        text('three clicks'),
      ],
      tool,
      'click three times',
      { maxTaskSteps: 2 },
    )

    await run()

    expect(tool.clicks).toBe(2)
    expect(engine.taskBudget()).toEqual({ steps: 2, remaining: 0, limit: 2 })
    const task = engine.lastRunTrace().task!
    expect(task.status).toBe('blocked')
    expect(task.reason).toMatch(/safety rail/i)
  })

  it('the default ceiling never truncates a normal multi-step goal', async () => {
    const tool = new ClickTool()
    const { engine, run } = runGoal(
      [
        req('desktop.click', { window_id: '1', x: 1, y: 1 }),
        req('desktop.click', { window_id: '1', x: 2, y: 2 }),
        req('desktop.click', { window_id: '1', x: 3, y: 3 }),
        text('done'),
      ],
      tool,
      'click three times',
    )

    await run()

    expect(tool.clicks).toBe(3)
    expect(engine.taskResult().status).toBe('completed')
  })
})

describe('Phase 2.0 — cancellation during a goal', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('a user cancellation between steps stops the goal — no new action after cancellation', async () => {
    const tool = new ClickTool()
    let engine: AssistantEngine
    const provider = new CancelAfterFirstRoundProvider(
      [
        req('desktop.click', { window_id: '1', x: 1, y: 1 }),
        req('desktop.click', { window_id: '1', x: 2, y: 2 }),
        text('finished'),
      ],
      () => engine.cancelCurrentTask(),
    )
    engine = new AssistantEngine({ providers: [provider] })
    engine.registerTool(tool)
    engine.on(() => undefined)

    await engine.process('click twice')

    expect(tool.clicks).toBe(1)
    const task = engine.lastRunTrace().task!
    expect(task.status).toBe('cancelled')
    expect(engine.lastRunTrace().finalState).toBe('cancelled')
  })
})

describe('Phase 2.0 — read-only goals keep their answer semantics', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('a Q&A run with no injective action is completed by its answer', async () => {
    const tool = new ReadOnlyTool()
    const { engine, run } = runGoal([req('info.get'), text('The answer is 42.')], tool, 'what is the answer')

    await run()

    const task = engine.taskResult()
    expect(task.status).toBe('completed')
    expect(task.actionable).toBe(false)
    expect(task.evidence).toEqual({ kind: 'read_only_answer' })
  })
})

describe('Phase 2.0 — voice goals take the SAME engine path (no separate executor)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('a spoken goal runs through the planner→engine→visual steps→verification→verdict loop', async () => {
    const { observation, desktop, vision } = visualFakes()
    const provider = new ScriptedProvider([
      req('desktop.visualClick', { target: 'Settings', window_id: '1', expected_after: 'Saved' }),
      text('Clicked and confirmed.'),
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
    wake.emitWake({ phrase: 'jarvis open settings for me', command: 'open settings for me' })
    await run

    const task = engine.lastRunTrace().task!
    expect(task.status).toBe('completed')
    expect(task.evidence).toEqual({ kind: 'action_verified' })
    expect(desktop.calls.click).toBe(1)
  })
})

describe('Phase 2.1 — engine goal UI surface (goalPlan / goalLimitsInfo)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('goalPlan() projects a verified run WITHOUT tool payloads or secrets', async () => {
    const tool = new ClickTool()
    tool.mode = 'verified'
    const { engine, run } = runGoal(
      [req('desktop.click', { window_id: '1', x: 1, y: 1 }), text('Done.')],
      tool,
      'click the point',
    )

    await run()

    const plan = engine.goalPlan()
    expect(plan.active).toBe(false) // run finished; plan persists for review
    expect(plan.goal).toBe('click the point')
    expect(plan.status).toBe('COMPLETED')
    expect(plan.steps).toHaveLength(1)
    const step = plan.steps[0]
    expect(step.toolId).toBe('desktop.click')
    expect(step.action).toBe('Click')
    expect(step.state).toBe('verified')
    expect(step.attempts).toBe(1)
    expect(step.evidence).toContain('confirmed')
    // UI projections NEVER expose raw arguments / payloads / param values.
    expect(JSON.stringify(plan)).not.toMatch(/window_id|"x"|"y"/)
  })

  it('goalPlan() keeps the executed steps visible after cancellation (whole plan stays reviewable)', async () => {
    const tool = new ClickTool()
    let engine: AssistantEngine
    const provider = new CancelAfterFirstRoundProvider(
      [
        req('desktop.click', { window_id: '1', x: 1, y: 1 }),
        req('desktop.click', { window_id: '1', x: 2, y: 2 }),
        text('finished'),
      ],
      () => engine.cancelCurrentTask(),
    )
    engine = new AssistantEngine({ providers: [provider] })
    engine.registerTool(tool)
    engine.on(() => undefined)

    await engine.process('click twice')

    const plan = engine.goalPlan()
    expect(plan.status).toBe('CANCELLED')
    // The step that actually ran stays visible; nothing after cancellation ran.
    expect(plan.steps.map((s) => s.state)).toEqual(['verified'])
    expect(tool.clicks).toBe(1)
    // UI projections never surrender payload / param values.
    expect(JSON.stringify(plan)).not.toMatch(/window_id/)
  })

  it('goalPlan() is empty in a safe "no plan" baseline shape', () => {
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    const plan = engine.goalPlan()
    expect(plan.active).toBe(false)
    expect(plan.steps).toEqual([])
  })

  it('goalLimitsInfo() exposes only a read-only copy of the engine limits', async () => {
    const tool = new ClickTool()
    const { engine, run } = runGoal([req('desktop.click', { window_id: '1', x: 1, y: 1 }), text('done')], tool, 'click', {
      maxTaskSteps: 2,
      maxRecoveryAttempts: 1,
    })
    await run()

    expect(engine.goalLimitsInfo()).toEqual({ maxTaskSteps: 2, maxRecoveryAttempts: 1, maxReplans: 3 })
    // The model can never change the limits through its output.
    expect(engine.taskResult().status).toBe('completed')
  })

  it('a FAILED step with a rail refusal is projected as blocked, never leaked', async () => {
    const tool = new ClickTool()
    const { engine, run } = runGoal(
      [req('desktop.click', { window_id: '1', x: 1, y: 1, permission: 'admin' }), text('tried')],
      tool,
      'click',
    )
    await run()
    const plan = engine.goalPlan()
    expect(plan.steps[0].state).toBe('blocked')
    // The engine's refusal REASON may name the offending parameter, but the
    // payload VALUE the model sent must never leak into the projection.
    expect(JSON.stringify(plan)).not.toMatch(/"permission":/)
    expect(plan.steps[0].evidence).toMatch(/managed by the engine/)
  })
})