import { describe, expect, it, beforeEach } from 'vitest'
import { useJarvisStore } from './jarvis.store'
import { useConversationStore } from './conversation.store'
import { buildGoalRunSnapshot, syncGoalRun } from './goalRun'
import type { GoalRunSource } from './goalRun'
import { AssistantEngine } from '../engine/AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from '../engine/provider'
import type { Tool, ToolContext, ToolInput, ToolResult, ToolVerification } from '../tools/Tool'
import { VoiceManager } from '../voice/voiceManager'
import { FakeWakeWordProvider, FakeSpeechToTextProvider, FakeTextToSpeechProvider } from '../voice/testing'

/**
 * Phase 2.1 — STORE ↔ ENGINE LIFECYCLE WIRING.
 *
 * These tests drive the REAL AssistantEngine loop and assert that the store
 * mirror (`syncGoalRun`, the exact refresh useAssistant runs on every engine
 * message) follows the full corrected step lifecycle:
 *
 *   PENDING → RUNNING → COMPLETED / FAILED / CANCELLED
 *
 * Cross-checked at three points per run:
 *   1. DURING execution  (a tool's `execute()` snapshots the store → RUNNING)
 *   2. BETWEEN rounds    (after round 1 executed, plan still ACTIVE)
 *   3. AFTER the run     (terminal mirror: verdict + plan)
 *
 * The store never derives anything: each assertion reads exactly what the
 * engine computed (`goalPlan` / `taskResult` / `taskBudget`).
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

const mirror = (engine: AssistantEngine): GoalRunSource => engine

function refresh(engine: AssistantEngine, now?: number) {
  return syncGoalRun(
    mirror(engine),
    () => useJarvisStore.getState().goalMode,
    (snapshot) => useJarvisStore.getState().setGoalRun(snapshot),
    now,
  )
}

class ScriptedProvider implements AIProvider {
  readonly id = 'scripted'
  readonly label = 'Scripted'
  requests: AIRequest[] = []
  /**
   * Called AFTER a planner request is answered and the previous round has
   * fully executed (fires from the second generate call on — the first call
   * happens before anything has run).
   */
  betweenRounds?: () => void
  private readonly queue: AIResponse[]

  constructor(script: AIResponse[], betweenRounds?: () => void) {
    this.queue = [...script]
    this.betweenRounds = betweenRounds
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    this.requests.push(request)
    const response = await Promise.resolve(this.queue.shift())
    // requests.length >= 2 means at least one prior round has executed.
    if (response && this.requests.length >= 2) this.betweenRounds?.()
    return response ?? { text: 'No more scripted steps.' }
  }

  isConfigured(): boolean {
    return true
  }

  async isReachable(): Promise<boolean> {
    return true
  }
}

/** Provider that cancels the goal exactly between round 1 and round 2. */
class CancelBetweenRoundsProvider extends ScriptedProvider {
  constructor(script: AIResponse[], doCancel: () => void) {
    super(
      script,
      // Fires from the SECOND generate on (after round 1 executed) — cancel
      // right there, before round 2's steps run.
      () => {
        if (this.requests.length === 2) doCancel()
      },
    )
  }
}

type ClickMode = 'verified' | 'refuted' | 'unverified' | 'fails'
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
  mode: ClickMode = 'verified'
  /** Snapshot the mirror while this tool is RUNNING (mid-execution). */
  onExecute?: () => void

  canRun(): boolean {
    return true
  }

  async execute(_i: ToolInput): Promise<ToolResult> {
    this.onExecute?.()
    if (this.mode === 'fails') return { ok: false, message: 'the click threw' }
    return { ok: true, message: 'clicked', data: { ok: true } }
  }

  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    if (this.mode === 'unverified') throw new Error('No expected visible state was supplied.')
    if (this.mode === 'refuted') return { ok: false, message: 'the click had no effect', checks: ['effect'] }
    return { ok: true, message: 'confirmed', checks: ['effect'] }
  }
}

function req(toolId: string, payload: Record<string, unknown> = {}): AIResponse {
  return { text: '', toolRequests: [{ toolId, payload }] }
}

function text(value: string): AIResponse {
  return { text: value }
}

describe('Phase 2.1 — store ↔ engine lifecycle wiring', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    useJarvisStore.getState().setGoalRun(null)
    useJarvisStore.getState().setGoalMode('ask')
  })

  it('PENDING → RUNNING → COMPLETED: the mirror is live during execution, between rounds and after', async () => {
    let running: ReturnType<typeof buildGoalRunSnapshot> | null = null
    let betweenRounds: ReturnType<typeof buildGoalRunSnapshot> | null = null
    const tool = new ClickTool()

    let engine: AssistantEngine
    const provider = new ScriptedProvider(
      [
        req('desktop.click', { window_id: '1', x: 1, y: 1 }),
        req('desktop.click', { window_id: '1', x: 2, y: 2 }),
        text('Done.'),
      ],
      () => {
        if (!betweenRounds) betweenRounds = refresh(engine, 1700000000002)
      },
    )
    engine = new AssistantEngine({ providers: [provider] })
    engine.registerTool(tool)
    engine.on(() => undefined)
    tool.onExecute = () => {
      // Capture the FIRST in-flight moment only (the same tool runs again for
      // round 2 — a later capture would observe the round 1 step as verified).
      if (!running) running = refresh(engine, 1700000000001)
    }
    await engine.process('click twice')

    // 1) MID-EXECUTION — the engine marks the plan step RUNNING before the
    //    tool runs, so the mirror shows an ACTIVE plan with an executing step.
    expect(running!.plan.active).toBe(true)
    expect(running!.plan.steps[0].state).toBe('executing')
    // No fabricated verdict: the engine's own in-flight placeholder says the
    // goal is still being planned (the view hides planning entirely).
    expect(running!.task?.status).toBe('planning')

    // 2) BETWEEN ROUNDS — round 1 executed + verified, plan still ACTIVE and
    //    the step is now a verified COMPLETED step; the store was re-synced.
    expect(betweenRounds!.plan.active).toBe(true)
    expect(betweenRounds!.plan.steps[0].state).toBe('verified')
    expect(betweenRounds!.plan.steps).toHaveLength(1)
    // Engine numbers flow verbatim (budget advanced by one real execution).
    expect(betweenRounds!.budget.remaining).toBe(9)

    // 3) AFTER THE RUN — terminal mirror reflects the engine verdict; the
    //    store instance has the same snapshot (useAssistant runs this sync).
    const final = refresh(engine, 1700000000003)
    expect(final.plan.active).toBe(false)
    expect(final.plan.status).toBe('COMPLETED')
    expect(final.plan.steps.map((s) => s.state)).toEqual(['verified', 'verified'])
    expect(final.task?.status).toBe('completed')
    expect(final.task?.evidence).toEqual({ kind: 'action_verified' })
    expect(useJarvisStore.getState().goalRun?.task?.status).toBe('completed')
    // `refreshedAt` advances: mount < mid-execution < between rounds < final.
    const stamps = [running!.refreshedAt, betweenRounds!.refreshedAt, final.refreshedAt]
    expect(new Set(stamps).size).toBe(3)
    // The mirror never carries tool payloads into the UI.
    expect(JSON.stringify(final)).not.toMatch(/window_id|"x"|"y"/)
  })

  it('RUNNING → FAILED: an execution error leaves a failed step and a failed verdict', async () => {
    const tool = new ClickTool()
    tool.mode = 'fails'
    const engine = new AssistantEngine({
      providers: [new ScriptedProvider([req('desktop.click', { window_id: '1', x: 1, y: 1 }), text('tried')])],
    })
    engine.registerTool(tool)
    engine.on(() => undefined)
    await engine.process('click it')

    const snap = refresh(engine)
    expect(snap.plan.status).toBe('COMPLETED') // the run itself finished
    expect(snap.plan.steps[0].state).toBe('failed')
    expect(snap.task?.status).toBe('failed')
    expect(snap.task?.executedSteps).toBe(1)
    expect(useJarvisStore.getState().goalRun?.task?.status).toBe('failed')
  })

  it('RUNNING → blocked (budget exhaustion): the mirror shows the refused step blocked', async () => {
    const tool = new ClickTool()
    const engine = new AssistantEngine({
      providers: [new ScriptedProvider([req('desktop.click', { window_id: '1', x: 1, y: 1 }), req('desktop.click', { window_id: '1', x: 2, y: 2 }), text('stopped')])],
      goalLimits: { maxTaskSteps: 1, maxRecoveryAttempts: 1 },
    })
    engine.registerTool(tool)
    engine.on(() => undefined)
    await engine.process('step to the budget edge')

    const snap = refresh(engine)
    // Step 1 consumed the single budget slot; step 2 was refused as an
    // orchestration limit. Multi-step honesty: step 1 verified, step 2 blocked
    // by budget -> task status PARTIAL (verified progress), never plain blocked.
    expect(snap.plan.steps.map((s) => s.state)).toEqual(['verified', 'blocked'])
    expect(snap.task?.status).toBe('partial')
    expect(snap.budget.remaining).toBe(0)
    expect(useJarvisStore.getState().goalRun?.task?.status).toBe('partial')
  })

  it('cancellation: cancel between rounds → the executed step stays visible, nothing after ran', async () => {
    const tool = new ClickTool()
    let engine: AssistantEngine
    const provider = new CancelBetweenRoundsProvider(
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

    const snap = refresh(engine)
    expect(snap.plan.active).toBe(false)
    expect(snap.plan.status).toBe('CANCELLED')
    expect(snap.plan.steps.map((s) => s.state)).toEqual(['verified'])
    expect(snap.task?.status).toBe('cancelled')
    expect(useJarvisStore.getState().goalRun?.plan.status).toBe('CANCELLED')
    expect(useJarvisStore.getState().goalRun?.task?.status).toBe('cancelled')
  })

  it('unverified completion: the plan finished but the mirror never claims success', async () => {
    const tool = new ClickTool()
    tool.mode = 'unverified'
    const engine = new AssistantEngine({
      providers: [new ScriptedProvider([req('desktop.click', { window_id: '1', x: 1, y: 1 }), text('Done!')])],
    })
    engine.registerTool(tool)
    engine.on(() => undefined)
    await engine.process('click the point')

    const snap = refresh(engine)
    expect(snap.plan.active).toBe(false)
    expect(snap.plan.status).toBe('COMPLETED') // the RUN completed
    expect(snap.plan.steps[0].state).toBe('unverified') // the step was not proven
    expect(snap.task?.status).toBe('unverified') // the GOAL was not proven
    expect(snap.task?.unverifiedSteps).toBe(1)
    expect(snap.task?.reason).toMatch(/NOT declared complete/i)
    expect(useJarvisStore.getState().goalRun?.task?.status).toBe('unverified')
  })

  it('snapshot correctness: the mirror carries ONLY engine numbers, never payloads', () => {
    const source = {
      goalPlan: () => ({ active: false, goal: 'g', status: 'COMPLETED' as const, steps: [] }),
      taskBudget: () => ({ steps: 2, remaining: 8, limit: 10 }),
      goalLimitsInfo: () => ({ maxTaskSteps: 10, maxRecoveryAttempts: 2, maxReplans: 3 }),
      goalRecovery: () => ({ verificationFailures: 0, maxRecoveryAttempts: 2, replans: 0, maxReplans: 3, active: false }),
      taskResult: () => ({
        status: 'completed' as const,
        reason: 'verified by the engine',
        evidence: { kind: 'action_verified' as const },
        actionable: true,
        executedSteps: 2,
        verifiedSteps: 2,
        refutedSteps: 0,
        unverifiedSteps: 0,
        rejectedSteps: 0,
        recoveries: 0,
      }),
    }
    const snap = buildGoalRunSnapshot(source, 'goal', 1700000000000)
    expect(snap.plan.goal).toBe('g')
    expect(snap.budget).toEqual({ steps: 2, remaining: 8, limit: 10 })
    expect(snap.limits).toEqual({ maxTaskSteps: 10, maxRecoveryAttempts: 2, maxReplans: 3 })
    expect(snap.task?.status).toBe('completed')
    expect(snap.mode).toBe('goal')
    expect(snap.refreshedAt).toBe('2023-11-14T22:13:20.000Z')
    // The projection used by the UI carries no executable/tool internals.
    expect(JSON.stringify(snap)).not.toMatch(/payload|window_id|"x"\s*:/)
  })

  it('store/engine synchronization: every engine message refreshes the store mirror (as useAssistant does)', async () => {
    const tool = new ClickTool()
    const engine = new AssistantEngine({
      providers: [new ScriptedProvider([req('desktop.click', { window_id: '1', x: 1, y: 1 }), text('Done.')])],
    })
    engine.registerTool(tool)

    // The exact refresh useAssistant registers per engine message.
    const onMessage = () => {
      syncGoalRun(
        engine,
        () => useJarvisStore.getState().goalMode,
        (s) => useJarvisStore.getState().setGoalRun(s),
      )
    }
    engine.on(onMessage)

    await engine.process('click the point')

    const stored = useJarvisStore.getState().goalRun!
    expect(stored.plan.active).toBe(false)
    expect(stored.plan.status).toBe('COMPLETED')
    expect(stored.plan.steps[0].state).toBe('verified')
    expect(stored.task?.status).toBe('completed')
    expect(stored.task?.evidence).toEqual({ kind: 'action_verified' })
    expect(stored.budget.remaining).toBe(9)
    expect(stored.refreshedAt).toBeTruthy()
    // Mode is never overwritten by a refresh; a later sync preserves it too.
    useJarvisStore.getState().setGoalMode('goal')
    const preserved = refresh(engine)
    expect(preserved.mode).toBe('goal')
    expect(preserved.task?.status).toBe('completed')
    expect(useJarvisStore.getState().goalRun?.mode).toBe('goal')
  })

  it('voice: a spoken goal writes the SAME engine→store mirror (no separate path)', async () => {
    const tool = new ClickTool()
    const engine = new AssistantEngine({
      providers: [new ScriptedProvider([req('desktop.click', { window_id: '1', x: 1, y: 1 }), text('Done.')])],
    })
    engine.registerTool(tool)
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

    const snap = refresh(engine)
    expect(snap.plan.status).toBe('COMPLETED')
    expect(snap.plan.steps[0].state).toBe('verified')
    expect(snap.task?.status).toBe('completed')
    expect(useJarvisStore.getState().goalRun?.task?.status).toBe('completed')
  })
})