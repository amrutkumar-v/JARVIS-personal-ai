import { describe, expect, it } from 'vitest'
import { PlanTracker, transitionStatus, prerequisiteSatisfied, dependenciesSatisfied } from './PlanTracker'
import type { AgentErrorKind } from './types'

/**
 * Phase 2.1 — the plan tracker's step lifecycle is the dataset the UI mirrors
 * through `goalPlan()`. These tests lock the corrected transition set:
 *
 *   PENDING  → RUNNING → COMPLETED / FAILED / CANCELLED
 *   PENDING  → FAILED / COMPLETED directly (pre-flight refusal / created at
 *             execution time — an executed step may arrive with no RUNNING
 *             marker, and a refused step may never have run at all)
 *   terminal states never leave
 */

const TERMINAL: Array<Parameters<typeof transitionStatus>[1]> = ['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED']

function result(message: string, errorKind?: AgentErrorKind) {
  return { message, attempts: 1, durationMs: 1, ...(errorKind ? { errorKind } : {}) }
}

describe('transitionStatus — step-state transition matrix', () => {
  it('PENDING → RUNNING (a step may start executing)', () => {
    expect(transitionStatus('PENDING', 'RUNNING')).toBe('RUNNING')
  })

  it('PENDING → COMPLETED (step created at execution time, no RUNNING marker)', () => {
    expect(transitionStatus('PENDING', 'COMPLETED')).toBe('COMPLETED')
  })

  it('PENDING → FAILED (pre-execution refusal: plan rejection, budget, permission)', () => {
    expect(transitionStatus('PENDING', 'FAILED')).toBe('FAILED')
  })

  it('PENDING → CANCELLED / SKIPPED / WAITING_CONFIRMATION', () => {
    expect(transitionStatus('PENDING', 'CANCELLED')).toBe('CANCELLED')
    expect(transitionStatus('PENDING', 'SKIPPED')).toBe('SKIPPED')
    expect(transitionStatus('PENDING', 'WAITING_CONFIRMATION')).toBe('WAITING_CONFIRMATION')
  })

  it('RUNNING → COMPLETED / FAILED / CANCELLED', () => {
    expect(transitionStatus('RUNNING', 'COMPLETED')).toBe('COMPLETED')
    expect(transitionStatus('RUNNING', 'FAILED')).toBe('FAILED')
    expect(transitionStatus('RUNNING', 'CANCELLED')).toBe('CANCELLED')
    expect(transitionStatus('RUNNING', 'WAITING_CONFIRMATION')).toBe('WAITING_CONFIRMATION')
  })

  it('a RUNNING step may not silently SKIP', () => {
    expect(transitionStatus('RUNNING', 'SKIPPED')).toBeUndefined()
  })

  it('WAITING_CONFIRMATION → RUNNING / SKIPPED / CANCELLED / FAILED', () => {
    expect(transitionStatus('WAITING_CONFIRMATION', 'RUNNING')).toBe('RUNNING')
    expect(transitionStatus('WAITING_CONFIRMATION', 'SKIPPED')).toBe('SKIPPED')
    expect(transitionStatus('WAITING_CONFIRMATION', 'CANCELLED')).toBe('CANCELLED')
    expect(transitionStatus('WAITING_CONFIRMATION', 'FAILED')).toBe('FAILED')
  })

  it('terminal states never leave', () => {
    for (const t of TERMINAL) {
      for (const n of ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED'] as const) {
        if (t !== n) expect(transitionStatus(t, n), `${t} → ${n}`).toBeUndefined()
      }
    }
  })

  it('same-state transitions are legal no-ops', () => {
    expect(transitionStatus('PENDING', 'PENDING')).toBe('PENDING')
    expect(transitionStatus('COMPLETED', 'COMPLETED')).toBe('COMPLETED')
  })
})

describe('PlanTracker — lifecycle integration', () => {
  it('PENDING → RUNNING records startedAt and leaves the plan ACTIVE', () => {
    const tracker = new PlanTracker()
    tracker.start('click')
    const step = tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })

    expect(step.status).toBe('PENDING')
    expect(tracker.startedSteps).toBe(0)
    expect(tracker.active).toBe(true)

    tracker.setStatus(step.id, 'RUNNING')

    expect(tracker.steps[0].status).toBe('RUNNING')
    expect(tracker.steps[0].startedAt).toBeDefined()
    expect(tracker.startedSteps).toBe(1)
    expect(tracker.active).toBe(true)
  })

  it('RUNNING → COMPLETED attaches the result and sets completedAt', () => {
    const tracker = new PlanTracker()
    tracker.start('click')
    const step = tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })
    tracker.setStatus(step.id, 'RUNNING')
    tracker.completeStep(step.id, result('clicked'))

    const done = tracker.steps[0]
    expect(done.status).toBe('COMPLETED')
    expect(done.result?.message).toBe('clicked')
    expect(done.completedAt).toBeDefined()
  })

  it('RUNNING → FAILED attaches the failure and the error copy stays safe', () => {
    const tracker = new PlanTracker()
    tracker.start('click')
    const step = tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })
    tracker.setStatus(step.id, 'RUNNING')
    tracker.failStep(step.id, result('boom', 'tool_failure'))

    const failed = tracker.steps[0]
    expect(failed.status).toBe('FAILED')
    expect(failed.result?.errorKind).toBe('tool_failure')
    expect(failed.error).toBe('boom')
    expect(failed.completedAt).toBeDefined()
  })

  it('a rail refusal reaches FAILED straight from PENDING (never executed)', () => {
    const tracker = new PlanTracker()
    tracker.start('click')
    const step = tracker.addStep({ toolId: 'shell.exec', input: {}, requiresConfirmation: false })
    tracker.failStep(step.id, result('managed by the engine', 'plan_rejected'))

    expect(tracker.steps[0].status).toBe('FAILED')
    expect(tracker.steps[0].startedAt).toBeUndefined() // never started
  })

  it('cancelRemaining cancels PENDING/RUNNING but preserves terminal steps', () => {
    const tracker = new PlanTracker()
    tracker.start('multi')
    const ran = tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })
    const waiting = tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })
    tracker.setStatus(ran.id, 'RUNNING')
    tracker.setStatus(waiting.id, 'WAITING_CONFIRMATION')
    tracker.completeStep(ran.id, result('clicked'))

    tracker.cancelRemaining()

    expect(tracker.steps[0].status).toBe('COMPLETED')
    expect(tracker.steps[1].status).toBe('CANCELLED')
  })

  it('finish(COMPLETED) makes the plan terminal and snapshot() reports idle', () => {
    const tracker = new PlanTracker()
    tracker.start('click')
    const step = tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })
    tracker.setStatus(step.id, 'RUNNING')
    tracker.completeStep(step.id, result('clicked'))
    tracker.finish('COMPLETED')

    expect(tracker.active).toBe(false)
    const snap = tracker.snapshot('Click')
    expect(snap.active).toBe(false)
    expect(snap.status).toBe('COMPLETED')
  })

  it('snapshot() reports live progress while ACTIVE and an idle baseline when empty', () => {
    const tracker = new PlanTracker()
    expect(tracker.current).toBeNull()
    expect(tracker.snapshot('x')).toEqual({ active: false, label: '', step: 0, total: 0, status: 'COMPLETED' })

    tracker.start('multi')
    const a = tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })
    tracker.addStep({ toolId: 'desktop.type', input: {}, requiresConfirmation: false })
    tracker.setStatus(a.id, 'RUNNING')
    tracker.completeStep(a.id, result('clicked'))
    // the second step stays PENDING — only *started* steps count toward progress.

    const live = tracker.snapshot('Parse')
    expect(live.active).toBe(true)
    expect(live.step).toBe(1) // started
    expect(live.total).toBe(2) // planned (b exists but stays PENDING)
    expect(live.status).toBe('ACTIVE')
    expect(tracker.steps[1]).toBeDefined()
  })

  it('tracker.current snapshots never hand out the mutable plan', () => {
    const tracker = new PlanTracker()
    tracker.start('click')
    const step = tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })
    tracker.current!.steps[0].status = 'CANCELLED' // tamper with the snapshot copy
    expect(tracker.steps[0].status).toBe('PENDING') // internal state untouched
    expect(step.id).toBe(tracker.steps[0].id)
  })
})

describe('Phase 2.2 — explicit dependencies (plan dependsOn) and notes', () => {
  it('addStep marks implicit sequential links as NOT enforced', () => {
    const tracker = new PlanTracker()
    tracker.start('multi')
    tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })
    const second = tracker.addStep({ toolId: 'notes.get', input: {}, requiresConfirmation: false })
    expect(second.dependenciesExplicit).toBe(false)
    expect(second.dependsOn).toHaveLength(1)
  })

  it('explicit dependsOn marks the step enforced', () => {
    const tracker = new PlanTracker()
    tracker.start('multi')
    const a = tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })
    const b = tracker.addStep({ toolId: 'notes.get', input: {}, requiresConfirmation: false, dependsOn: [a.id] })
    expect(b.dependenciesExplicit).toBe(true)
    expect(b.dependsOn).toEqual([a.id])
  })

  it('a step with unmet explicit dependencies is NOT ready', () => {
    const tracker = new PlanTracker()
    tracker.start('multi')
    const a = tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })
    const b = tracker.addStep({ toolId: 'notes.get', input: {}, requiresConfirmation: false, dependsOn: [a.id] })

    expect(tracker.isReady(b.id)).toBe(false)
    expect(dependenciesSatisfied(tracker.current, b.id)).toBe(false)
  })

  it('a step is ready once every explicit prerequisite COMPLETED', () => {
    const tracker = new PlanTracker()
    tracker.start('multi')
    const a = tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })
    const b = tracker.addStep({ toolId: 'notes.get', input: {}, requiresConfirmation: false, dependsOn: [a.id] })

    tracker.setStatus(a.id, 'RUNNING')
    tracker.completeStep(a.id, result('clicked'))

    expect(tracker.isReady(b.id)).toBe(true)
    expect(prerequisiteSatisfied(tracker.steps[0])).toBe(true)
  })

  it('a FAILED prerequisite still blocks its dependent (explicit only)', () => {
    const tracker = new PlanTracker()
    tracker.start('multi')
    const a = tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })
    const b = tracker.addStep({ toolId: 'notes.get', input: {}, requiresConfirmation: false, dependsOn: [a.id] })
    tracker.failStep(a.id, result('boom', 'tool_failure'))

    expect(tracker.isReady(b.id)).toBe(false)
  })

  it('implicit sequential chains are purely informational and never block', () => {
    const tracker = new PlanTracker()
    tracker.start('multi')
    const a = tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })
    const b = tracker.addStep({ toolId: 'desktop.type', input: {}, requiresConfirmation: false })

    // `b` follows `a` implicitly but is NOT explicitly dependent, so a failed
    // `a` must not prevent `b` from running (supports retry-with-different-args).
    tracker.failStep(a.id, result('boom', 'tool_failure'))
    expect(tracker.isReady(b.id)).toBe(true)
  })

  it('setDependencies overwrites the chain and marks the step enforced', () => {
    const tracker = new PlanTracker()
    tracker.start('multi')
    const a = tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })
    const b = tracker.addStep({ toolId: 'notes.get', input: {}, requiresConfirmation: false })
    const c = tracker.addStep({ toolId: 'notes.get', input: {}, requiresConfirmation: false })

    tracker.setDependencies(c.id, [a.id, b.id])
    const step = tracker.steps[2]
    expect(step.dependenciesExplicit).toBe(true)
    expect(step.dependsOn).toEqual([a.id, b.id])
    expect(tracker.isReady(c.id)).toBe(false)
  })

  it('setNote attaches a UI-safe recovery/block note and persists in snapshots', () => {
    const tracker = new PlanTracker()
    tracker.start('click')
    const step = tracker.addStep({ toolId: 'desktop.click', input: {}, requiresConfirmation: false })
    tracker.setNote(step.id, 'Recovery: verification_failure → replan. A step produced no verified effect.')

    expect(tracker.steps[0].note).toBe('Recovery: verification_failure → replan. A step produced no verified effect.')
    expect(tracker.current?.steps[0].note).toBe('Recovery: verification_failure → replan. A step produced no verified effect.')
  })
})