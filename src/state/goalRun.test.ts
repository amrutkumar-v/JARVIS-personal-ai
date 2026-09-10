import { describe, expect, it } from 'vitest'
import { useJarvisStore } from './jarvis.store'
import { buildGoalRunSnapshot, EMPTY_GOAL_RUN, syncGoalRun } from './goalRun'
import { useConversationStore } from './conversation.store'
import { AssistantEngine } from '../engine/AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from '../engine/provider'
import type { Tool, ToolContext, ToolInput, ToolResult, ToolVerification } from '../tools/Tool'
import { FakeObservationProvider } from '../observation/testing'
import { FakeDesktopInteractionProvider } from '../desktop/testing'
import { createFakeVisionProvider } from '../vision/testing'
import { VoiceManager } from '../voice/voiceManager'
import { FakeWakeWordProvider, FakeSpeechToTextProvider, FakeTextToSpeechProvider } from '../voice/testing'

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
  private readonly queue: AIResponse[]
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
  canRun(): boolean {
    return true
  }
  async execute(): Promise<ToolResult> {
    return { ok: true, message: 'clicked', data: { ok: true } }
  }
  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    return { ok: true, message: 'confirmed', checks: ['effect'] }
  }
}

function visualFakes() {
  const observation = new FakeObservationProvider([
    { windowId: '1', title: 'App', bounds: { left: 0, top: 0, right: 2, bottom: 2 } },
  ])
  const desktop = new FakeDesktopInteractionProvider([{ windowId: '1' }], { left: 0, top: 0, width: 2, height: 2 })
  const vision = createFakeVisionProvider()
  return { observation, desktop, vision }
}

describe('Phase 2.1 — goal mode & goal run mirror', () => {
  it('transitions goal mode and stores the engine mirror via store actions', () => {
    const api = useJarvisStore.getState()
    expect(api.goalMode).toBe('ask')
    api.setGoalMode('goal')
    expect(useJarvisStore.getState().goalMode).toBe('goal')
    api.setGoalRun({ ...EMPTY_GOAL_RUN, mode: 'goal' })
    expect(useJarvisStore.getState().goalRun?.mode).toBe('goal')
    expect(useJarvisStore.getState().goalRun?.refreshedAt).toBeDefined()
  })
})

describe('Phase 2.1 — buildGoalRunSnapshot mirrors ENGINE numbers only', () => {
  it('never invents verdicts — it copies the engine evaluator output verbatim', () => {
    const source = {
      goalPlan: () => ({ active: false, goal: 'open it', status: 'COMPLETED' as const, steps: [] }),
      taskBudget: () => ({ steps: 1, remaining: 9, limit: 10 }),
      goalLimitsInfo: () => ({ maxTaskSteps: 10, maxRecoveryAttempts: 2, maxReplans: 3 }),
      goalRecovery: () => ({ verificationFailures: 0, maxRecoveryAttempts: 2, replans: 0, maxReplans: 3, active: false }),
      taskResult: () => ({
        status: 'unverified' as const,
        reason: 'Step results could not be confirmed, so the goal is NOT declared complete.',
        evidence: { kind: 'none' as const, reason: 'no confirmation' },
        actionable: true,
        executedSteps: 0,
        verifiedSteps: 0,
        refutedSteps: 0,
        unverifiedSteps: 1,
        rejectedSteps: 0,
        recoveries: 1,
      }),
    }
    const snap = buildGoalRunSnapshot(source, 'ask', 1700000000000)
    expect(snap.plan.goal).toBe('open it')
    expect(snap.budget).toEqual({ steps: 1, remaining: 9, limit: 10 })
    expect(snap.limits).toEqual({ maxTaskSteps: 10, maxRecoveryAttempts: 2, maxReplans: 3 })
    expect(snap.recovery).toEqual({ verificationFailures: 0, maxRecoveryAttempts: 2, replans: 0, maxReplans: 3, active: false })
    expect(snap.task?.status).toBe('unverified')
    expect(snap.refreshedAt).toBe(new Date(1700000000000).toISOString())
    // The mirror contains no tool arguments (projection already sanitized).
    expect(JSON.stringify(snap)).not.toMatch(/payload|window_id/)
  })

  it('syncGoalRun writes the mirror through the store actions', () => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    useJarvisStore.getState().setGoalMode('goal')
    useJarvisStore.getState().setGoalRun(null)

    const tool = new ClickTool()
    const engine = new AssistantEngine({
      providers: [new ScriptedProvider([{ text: '', toolRequests: [{ toolId: 'desktop.click', payload: { window_id: '1', x: 1, y: 1 } }] }, { text: 'Done.' }])],
    })
    engine.registerTool(tool)
    engine.on(() => undefined)

    const refreshed = syncGoalRun(
      engine,
      () => useJarvisStore.getState().goalMode,
      (s) => useJarvisStore.getState().setGoalRun(s),
    )
    expect(refreshed.mode).toBe('goal')
    expect(useJarvisStore.getState().goalRun?.mode).toBe('goal')
    expect(useJarvisStore.getState().goalRun?.budget.limit).toBeGreaterThan(0)
  })
})

describe('Phase 2.1 — VOICE goals drive the same engine → store goalRun mirror (no separate path)', () => {
  it('a spoken goal ends with a store goalRun verdict calculated by the engine', async () => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    useJarvisStore.getState().setGoalRun(null)
    useJarvisStore.getState().setGoalMode('ask')

    const { observation, desktop, vision } = visualFakes()
    const engine = new AssistantEngine({
      providers: [new ScriptedProvider([
        { text: '', toolRequests: [{ toolId: 'desktop.visualClick', payload: { target: 'Settings', window_id: '1', expected_after: 'Saved' } }] },
        { text: 'Clicked and confirmed.' },
      ])],
      observation,
      desktop,
      vision,
    })
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

    // The UI refresh is engine→store: exactly what useAssistant runs.
    const snap = syncGoalRun(
      engine,
      () => useJarvisStore.getState().goalMode,
      (s) => useJarvisStore.getState().setGoalRun(s),
    )
    expect(snap.mode).toBe('ask')
    expect(snap.plan.active).toBe(false)
    expect(snap.plan.status).toBe('COMPLETED')
    expect(snap.plan.steps[0].state).toBe('verified')
    expect(snap.task?.status).toBe('completed')
    expect(snap.task?.evidence).toEqual({ kind: 'action_verified' })
    expect(useJarvisStore.getState().goalRun?.task?.status).toBe('completed')
    expect(desktop.calls.click).toBe(1)
  })
})