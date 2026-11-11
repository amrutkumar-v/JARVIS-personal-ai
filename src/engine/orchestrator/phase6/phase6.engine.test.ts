import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantEngine } from '../../AssistantEngine'
import { AssistantEngine as AssistantEngineDefault } from '../../AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from '../../provider'
import { FakeApplicationProvider } from '../../../applications/testing'
import type { AppStatus } from '../../../applications/provider'
import { FakeDesktopInteractionProvider } from '../../../desktop/testing'
import type { WebProvider } from '../../../web/provider'
import { useConversationStore } from '../../../state/conversation.store'

/**
 * PHASE 6 — goal orchestration through the REAL engine.
 *
 * Drives `orchestrate → planOrchestrated → executeOrchestrated` (the SAME
 * public bridge the UI uses) so every Phase 6 rail runs on REAL production
 * paths: the `context_matches` precondition computed by the planner, the
 * per-step `runPhase6Orchestrated` loop, post-action observation that upgrades
 * a trace step with cross-tool evidence, bounded recovery/replanning, the
 * deadline + cancellation rails, and the payload injection guard. Providers are
 * deterministic stubs; no result is ever faked — every status derives from the
 * observed trace and real side effects.
 */

/* ---------------------------------------------------------------- fixtures */

class ScriptedProvider implements AIProvider {
  readonly id = 'scripted'
  readonly label = 'Scripted'

  async generate(_request: AIRequest): Promise<AIResponse> {
    return { text: 'No scripted step.' }
  }

  isConfigured(): boolean {
    return true
  }

  isReachable(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

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

function makeEngine(options?: {
  applications?: ReturnType<typeof FakeApplicationProvider>
  desktop?: FakeDesktopInteractionProvider
  web?: WebProvider
  goalLimits?: { maxRecoveryAttempts?: number; maxReplans?: number; totalExecutionMs?: number }
}): AssistantEngine {
  const engine = new AssistantEngineDefault({
    providers: [new ScriptedProvider()],
    applications: options?.applications,
    desktop: options?.desktop,
    web: options?.web,
    goalLimits: options?.goalLimits,
  })
  engine.on(() => undefined)
  return engine
}

/** Test-only read of the Phase 6 run-book summary (private field). */
type Phase6RunSummaryView = {
  planId?: string
  elapsedMs: number
  phase: string
  executedSteps: number
  verifiedSteps: number
  failedSteps: number
  blockedSteps: number
  skippedSteps: number
  cancelledSteps: number
  recoveryAttempts: number
  replanAttempts: number
  replanLimit: number
  stoppedBy: string | null
}

function lastRun(engine: AssistantEngine): Phase6RunSummaryView | null {
  return (engine as unknown as { lastPhase6Run: Phase6RunSummaryView | null }).lastPhase6Run
}

/** The real compound goal shared by most tests. */
const COMPOUND_GOAL = 'Open Notepad and introduce yourself in written format.'

/** Application provider whose first launch is gated (for deadline/cancellation tests). */
class GatedAppProvider extends FakeApplicationProvider {
  private gateNext = false
  private releaseLaunch: ((value: void | Promise<void>) => void) | null = null
  private markStarted!: () => void
  readonly launchStarted: Promise<void> = new Promise<void>((resolve) => {
    this.markStarted = resolve
  })

  nextLaunchGated(): void {
    this.gateNext = true
  }

  async launch(applicationId: string): Promise<ReturnType<FakeApplicationProvider['launch']>> {
    this.markStarted()
    if (this.gateNext) {
      this.gateNext = false
      await new Promise<void>((resolve) => {
        this.releaseLaunch = resolve
      })
    }
    return super.launch(applicationId)
  }

  release(): void {
    this.releaseLaunch?.()
  }
}

const NOTEPAD = { applicationId: 'notepad', name: 'Notepad' }

function notepadDesktop(): FakeDesktopInteractionProvider {
  return new FakeDesktopInteractionProvider([{ windowId: '1', title: 'Notepad', focusable: true }])
}

/* ---------------------------------------------------------------- tests */

describe('Phase 6 — goal orchestration through the REAL engine (runPhase6Orchestrated)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('1 — the type step carries a context_matches precondition over the LAUNCH output', async () => {
    const apps = new FakeApplicationProvider([{ ...NOTEPAD, launchOutcome: 'verified' }])
    const desktop = notepadDesktop()
    const engine = makeEngine({ applications: apps, desktop })

    const request = await engine.orchestrate(COMPOUND_GOAL)
    const planned = engine.planOrchestrated(request)

    expect(planned.steps).toHaveLength(2)
    expect(planned.steps[0].capability).toBe('open_application')
    expect(planned.steps[1].capability).toBe('type_text')
    expect(planned.steps[1].meta?.precondition).toMatchObject({
      kind: 'context_matches',
      sources: [0],
      path: 'started',
      expect: true,
    })
  })

  it('2 — dependency order: type runs ONLY after the launch, its precondition reads the observed started=true', async () => {
    const apps = new FakeApplicationProvider([{ ...NOTEPAD, launchOutcome: 'verified' }])
    const desktop = notepadDesktop()
    const engine = makeEngine({ applications: apps, desktop })

    const result = await engine.executeOrchestrated(await engine.orchestrate(COMPOUND_GOAL))

    expect(result.status).not.toBe('blocked')
    expect(apps.launchCount('notepad')).toBe(1)
    expect(desktop.calls.type).toBe(1)
    expect(desktop.interactionLog.map((e) => e.name)).toContain('type')
    expect(desktop.interactionLog.some((e) => e.name === 'type' && (e.textLength ?? 0) > 0)).toBe(true)

    const run = lastRun(engine)
    expect(run?.phase).toBe('completed')
    expect(run?.executedSteps).toBe(2)
    expect(run?.blockedSteps).toBe(0)
    expect(run?.stoppedBy).toBe('completed')
  })

  it('3 — an unobservable launch remains unverified after independent re-observation', async () => {
    // Launch reports started:true but both the tool-owned verifier and the
    // independent status observation cannot establish whether it is running.
    // This is neither success nor a refutation: the step remains unverified.
    const apps = new FakeApplicationProvider([{ ...NOTEPAD, launchOutcome: 'unverified' }])
    const statusSpy = vi.spyOn(apps, 'status')
    const engine = makeEngine({ applications: apps })

    const result = await engine.executeOrchestrated(await engine.orchestrate('Open Notepad.'))

    expect(apps.launchCount('notepad')).toBe(1)
    // One tool-owned check plus the bounded independent observation and retry.
    expect(statusSpy.mock.calls.length).toBe(3)
    expect(result.status).toBe('partial')
    expect(result.verifiedSteps).toBe(0)
    expect(result.unverifiedSteps).toBe(1)
    expect(result.steps[0]).toMatchObject({ capability: 'open_application', status: 'success', verified: false })
    expect(result.verification[0]?.status).toBe('unverified')

    const run = lastRun(engine)
    expect(run?.verifiedSteps).toBe(0)
    expect(run?.failedSteps).toBe(0)
    expect(run?.recoveryAttempts).toBe(0)
  }, 15000)

  it('4 — a verified status showing the app is not running is a refutation', async () => {
    // Here the provider can observe process state and confirms it is not
    // running. That is a verified failure, distinct from unavailable state.
    const apps = new FakeApplicationProvider([{ ...NOTEPAD, launchOutcome: 'unverified' }])
    const statusSpy = vi
      .spyOn(apps, 'status')
      .mockResolvedValue({
        applicationId: 'notepad',
        name: 'Notepad',
        displayName: 'Notepad',
        source: 'configured',
        running: false,
        runningVerified: true,
      } as AppStatus)
    const engine = makeEngine({ applications: apps })

    const result = await engine.executeOrchestrated(await engine.orchestrate('Open Notepad.'))

    expect(apps.launchCount('notepad')).toBe(1)
    // Only the verifier's single status read happened — the refuted round is
    // not a success, so the recovery observation is never planned.
    expect(statusSpy.mock.calls.length).toBe(1)
    expect(result.status).toBe('failed')
    expect(result.verifiedSteps).toBe(0)
    expect(result.steps[0]).toMatchObject({ capability: 'open_application', status: 'failed', verified: false })

    const run = lastRun(engine)
    expect(run?.verifiedSteps).toBe(0)
    expect(run?.recoveryAttempts).toBe(1)
  })

  it('5 — a failed dependency BLOCKS the dependent step with ZERO side effects, and replan stops honestly', async () => {
    const apps = new FakeApplicationProvider([
      { ...NOTEPAD, launchOutcome: 'verified', fail: { op: 'launch', code: 'io', message: 'injected launch fault' } },
    ])
    const desktop = notepadDesktop()
    const engine = makeEngine({ applications: apps, desktop })

    const result = await engine.executeOrchestrated(await engine.orchestrate(COMPOUND_GOAL))

    // The io fault is thrown BEFORE the launch counter increments.
    expect(desktop.calls.type).toBe(0)
    expect(result.status).toBe('failed')
    expect(result.failedSteps).toBe(1)
    expect(result.skippedSteps).toBe(1)

    const run = lastRun(engine)
    // A tool_failure with no declared retry → bounded replan; production has
    // NO fabricated alternative, so the plan stops honestly.
    expect(run?.stoppedBy).toBe('replan_limit')
    expect(run?.replanAttempts).toBe(0)
    expect(run?.blockedSteps).toBeGreaterThanOrEqual(1)
  })

  it('6 — corrected continuation via the alternative resolver runs the corrected step (bounded replan)', async () => {
    const apps = new FakeApplicationProvider([
      { ...NOTEPAD, launchOutcome: 'verified', fail: { op: 'launch', code: 'io', message: 'injected launch fault' } },
      { applicationId: 'notepad2', name: 'Notepad2', launchOutcome: 'verified' },
    ])
    const desktop = notepadDesktop()
    const engine = makeEngine({ applications: apps, desktop })
    engine.setPhase6AlternativeResolver(() => ({
      capability: 'open_application',
      payload: { application_id: 'notepad2' },
      note: 'use the registered notepad2',
    }))

    await engine.executeOrchestrated(await engine.orchestrate(COMPOUND_GOAL))

    expect(apps.launchCount('notepad2')).toBe(1)
    expect(desktop.calls.type).toBe(1)

    const run = lastRun(engine)
    expect(run?.replanAttempts).toBe(1)
    expect(run?.failedSteps).toBe(0)
  })

  it('7 — a refuted launch reobserves ONCE, never upgrades without evidence, and blocks the dependent', async () => {
    const apps = new FakeApplicationProvider([{ ...NOTEPAD, launchOutcome: 'refuted' }])
    const desktop = notepadDesktop()
    const engine = makeEngine({ applications: apps, desktop, goalLimits: { maxRecoveryAttempts: 1 } })

    const result = await engine.executeOrchestrated(await engine.orchestrate(COMPOUND_GOAL))

    expect(apps.launchCount('notepad')).toBe(1)
    expect(desktop.calls.type).toBe(0)
    expect(result.status).toBe('failed')
    expect(result.steps[0]).toMatchObject({ status: 'failed', verified: false })

    const run = lastRun(engine)
    expect(run?.recoveryAttempts).toBe(1)
    expect(run?.verifiedSteps).toBe(0)
  })

  it('8 — recovery budget exhausted → the run stops before any further verification', async () => {
    const apps = new FakeApplicationProvider([{ ...NOTEPAD, launchOutcome: 'refuted' }])
    const desktop = notepadDesktop()
    const engine = makeEngine({ applications: apps, desktop, goalLimits: { maxRecoveryAttempts: 0 } })

    const result = await engine.executeOrchestrated(await engine.orchestrate(COMPOUND_GOAL))

    expect(apps.launchCount('notepad')).toBe(1)
    expect(desktop.calls.type).toBe(0)
    expect(result.status).toBe('failed')

    const run = lastRun(engine)
    expect(run?.stoppedBy).toBe('recovery_limit')
    expect(run?.recoveryAttempts).toBe(0)
  })

  it('9 — in-flight cancellation is honored at every step boundary (ZERO side effects)', async () => {
    const apps = new GatedAppProvider([{ ...NOTEPAD, launchOutcome: 'verified' }])
    const desktop = notepadDesktop()
    const engine = makeEngine({ applications: apps, desktop })
    apps.nextLaunchGated()

    // Start the compound goal; step0 (open) will block while we cancel.
    const pending = engine.executeOrchestrated(await engine.orchestrate(COMPOUND_GOAL))

    // Wait for the first step to actually start executing.
    const started = await Promise.race([
      apps.launchStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ])
    expect(started).toBe(true)

    // Cancel while step0 is held; the boundary check must trip.
    engine.cancelCurrentTask()
    apps.release()

    const result = await pending

    expect(result.status).toBe('cancelled')
    // The held step (open) may have completed, but the dependent (type) never ran.
    expect(desktop.calls.type).toBe(0)

    const run = lastRun(engine)
    expect(run?.phase).toBe('cancelled')
    expect(run?.stoppedBy).toBe('cancellation')
  })

  it('10 — the wall-clock deadline stops the run and refuses further tools', async () => {
    const apps = new GatedAppProvider([{ ...NOTEPAD, launchOutcome: 'verified' }])
    const desktop = notepadDesktop()
    const engine = makeEngine({ applications: apps, desktop, goalLimits: { totalExecutionMs: 50 } })
    apps.nextLaunchGated()

    // Start the compound goal; step0 (open) will block while we wait past the deadline.
    const pending = engine.executeOrchestrated(await engine.orchestrate(COMPOUND_GOAL))

    const started = await Promise.race([
      apps.launchStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ])
    expect(started).toBe(true)

    // Wait past the deadline, then release step0: the NEXT boundary must trip.
    await new Promise((resolve) => setTimeout(resolve, 120))
    apps.release()

    const result = await pending

    expect(result.status).toBe('partial')
    // The dependent step (type) never ran — deadline blocks further tools.
    expect(desktop.calls.type).toBe(0)
    const run = lastRun(engine)
    expect(run?.stoppedBy).toBe('deadline')
  })

  it('11 — SECURITY: a payload smuggling permission/confirm/budget params is REJECTED, ZERO side effects', async () => {
    const apps = new FakeApplicationProvider([{ ...NOTEPAD, launchOutcome: 'verified' }])
    const engine = makeEngine({ applications: apps })
    // executeToolSteps requires an active plan (started by executeOrchestrated in
    // the real flow). This test exercises the executor's own injection guard, so
    // seed the same plan lifecycle directly.
    ;(engine as unknown as { planTracker: { start(goal: string): unknown } }).planTracker.start('security')

    const exec = engine as unknown as {
      executeToolSteps: (
        text: string,
        requests: Array<{ toolId: string; capability: string; payload: Record<string, unknown> }>,
      ) => Promise<{ toolResults: Array<{ ok?: boolean; errorKind?: string }>; failures: Array<{ errorKind?: string }> }>
    }
    const round = await exec.executeToolSteps('Open Notepad.', [
      {
        toolId: 'open_application',
        capability: 'open_application',
        payload: {
          application_id: 'notepad',
          permission: 'auto',
          confirm: 'immediate',
          budget: { maxReplans: 99, maxRecoveryAttempts: 99 },
        },
      },
    ])

    expect(apps.launchCount('notepad')).toBe(0)
    expect(round.toolResults[0]?.ok).toBe(false)
    expect(round.failures[0]?.errorKind).toBe('plan_rejected')
  })
})
