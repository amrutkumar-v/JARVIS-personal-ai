import { describe, expect, it } from 'vitest'
import type { AgentStep, AgentTrace, TraceStep } from '../agent/types'
import { ACTIONABLE_TOOL_IDS, classifyPlanStep, classifyTaskStep, countRecoveries, evaluateGoalTask, isActionableToolId } from './evidence'

function step(overrides: Partial<TraceStep>): TraceStep {
  return {
    toolId: 'desktop.click',
    action: 'Click',
    arguments: {},
    status: 'COMPLETED',
    ...overrides,
  }
}

function planStep(overrides: Partial<AgentStep>): AgentStep {
  return {
    id: 'step-1',
    toolId: 'desktop.click',
    input: {},
    status: 'PENDING',
    requiresConfirmation: false,
    ...overrides,
  }
}

function trace(finalState: AgentTrace['finalState'], steps: TraceStep[]): AgentTrace {
  return { goal: 'open it', finalState, steps }
}

describe('Phase 2.0 — actionable tools', () => {
  it('treats injective hand/app tools as actionable', () => {
    expect(isActionableToolId('desktop.click')).toBe(true)
    expect(isActionableToolId('desktop.visualClick')).toBe(true)
    expect(isActionableToolId('desktop.key_press')).toBe(true)
    expect(isActionableToolId('app.launch')).toBe(true)
  })

  it('treats eyes, reads and inspectors as read-only', () => {
    for (const id of ['window.list', 'window.status', 'desktop.screenshot', 'desktop.visualInspect', 'notes.get', 'calculator', 'app.list']) {
      expect(isActionableToolId(id)).toBe(false)
      expect(ACTIONABLE_TOOL_IDS.has(id)).toBe(false)
    }
  })
})

describe('Phase 2.0 — per-step classification', () => {
  it('maps completed+verified to verified', () => {
    expect(classifyTaskStep(step({ status: 'COMPLETED', verification: { status: 'verified', message: '', durationMs: 1 } }))).toBe('verified')
  })

  it('maps completed+refuted to refuted', () => {
    expect(classifyTaskStep(step({ status: 'COMPLETED', verification: { status: 'failed', message: 'nope', durationMs: 1 } }))).toBe('refuted')
  })

  it('maps an engine FAILED step whose verifier refuted the effect to refuted', () => {
    expect(
      classifyTaskStep(
        step({
          status: 'FAILED',
          observation: { kind: 'verification', toolId: 'desktop.click', summary: '[verification failed]', errorKind: 'tool_failure', attempts: 1, durationMs: 0 },
          verification: { status: 'failed', message: 'nope', durationMs: 1 },
        }),
      ),
    ).toBe('refuted')
  })

  it('maps completed without confirmation to unverified (never success)', () => {
    expect(classifyTaskStep(step({ status: 'COMPLETED', verification: undefined }))).toBe('unverified')
    expect(classifyTaskStep(step({ status: 'COMPLETED', verification: { status: 'unverified', message: '', durationMs: 1 } }))).toBe('unverified')
    expect(classifyTaskStep(step({ status: 'COMPLETED', verification: { status: 'not_applicable', message: '', durationMs: 1 } }))).toBe('unverified')
  })

  it('maps refused/limited failures to blocked', () => {
    expect(classifyTaskStep(step({ status: 'FAILED', observation: { kind: 'failure', toolId: 'desktop.click', summary: '', errorKind: 'orchestration_limit', attempts: 1, durationMs: 0 } }))).toBe('blocked')
    expect(classifyTaskStep(step({ status: 'FAILED', observation: { kind: 'failure', toolId: 'desktop.click', summary: '', errorKind: 'plan_rejected', attempts: 1, durationMs: 0 } }))).toBe('blocked')
  })

  it('maps cancelled and plain failures honestly', () => {
    expect(classifyTaskStep(step({ status: 'CANCELLED' }))).toBe('cancelled')
    expect(classifyTaskStep(step({ status: 'FAILED', observation: { kind: 'failure', toolId: 'desktop.click', summary: 'boom', errorKind: 'tool_failure', attempts: 1, durationMs: 0 } }))).toBe('failed')
    expect(classifyTaskStep(step({ status: 'SKIPPED' }))).toBe('blocked')
  })
})

describe('Phase 2.1 — plan-step classification (UI step labels)', () => {
  it('labels requested-but-not-started steps as planned', () => {
    expect(classifyPlanStep(planStep({ status: 'PENDING' }))).toBe('planned')
  })

  it('labels running and waiting steps as executing', () => {
    expect(classifyPlanStep(planStep({ status: 'RUNNING' }))).toBe('executing')
    expect(classifyPlanStep(planStep({ status: 'WAITING_CONFIRMATION' }))).toBe('executing')
  })

  it('labels completed steps by their verified/refuted/unverified evidence', () => {
    expect(classifyPlanStep(planStep({ status: 'COMPLETED', verification: { status: 'verified', message: 'ok', durationMs: 1 } }))).toBe('verified')
    expect(classifyPlanStep(planStep({ status: 'COMPLETED', verification: { status: 'failed', message: 'nope', durationMs: 1 } }))).toBe('refuted')
    expect(classifyPlanStep(planStep({ status: 'COMPLETED', verification: { status: 'unverified', message: '', durationMs: 1 } }))).toBe('unverified')
    expect(classifyPlanStep(planStep({ status: 'COMPLETED' }))).toBe('unverified')
  })

  it('labels failed steps by their root cause (rail=blocked, cancel=cancelled)', () => {
    expect(classifyPlanStep(planStep({ status: 'FAILED', result: { message: '', attempts: 1, durationMs: 0, errorKind: 'plan_rejected' } }))).toBe('blocked')
    expect(classifyPlanStep(planStep({ status: 'FAILED', result: { message: '', attempts: 1, durationMs: 0, errorKind: 'orchestration_limit' } }))).toBe('blocked')
    expect(classifyPlanStep(planStep({ status: 'FAILED', result: { message: '', attempts: 1, durationMs: 0, errorKind: 'user_cancelled' } }))).toBe('cancelled')
    expect(classifyPlanStep(planStep({ status: 'FAILED', result: { message: 'boom', attempts: 1, durationMs: 0, errorKind: 'tool_failure' } }))).toBe('failed')
  })

  it('labels a FAILED step whose verifier refuted it as refuted (not an error)', () => {
    expect(
      classifyPlanStep(
        planStep({
          status: 'FAILED',
          observation: { kind: 'verification', toolId: 'desktop.click', summary: '[verification failed]', errorKind: 'tool_failure', attempts: 1, durationMs: 0 },
          verification: { status: 'failed', message: 'nope', durationMs: 1 },
        }),
      ),
    ).toBe('refuted')
  })

  it('labels cancelled and skipped steps honestly', () => {
    expect(classifyPlanStep(planStep({ status: 'CANCELLED' }))).toBe('cancelled')
    expect(classifyPlanStep(planStep({ status: 'SKIPPED' }))).toBe('blocked')
  })
})

describe('Phase 2.0 — recovery counting', () => {
  it('counts refuted and unverified steps, never informational ones', () => {
    const steps = [
      step({ status: 'COMPLETED', verification: { status: 'failed', message: '', durationMs: 1 }, observation: { kind: 'verification', toolId: 'desktop.click', summary: '', attempts: 1, durationMs: 0 } }),
      step({ status: 'COMPLETED', verification: { status: 'unverified', message: '', durationMs: 1 }, observation: { kind: 'partial', toolId: 'desktop.click', summary: '', attempts: 1, durationMs: 0 } }),
      step({ status: 'COMPLETED', observation: { kind: 'informational', toolId: 'notes.get', summary: '', attempts: 1, durationMs: 0 } }),
    ]
    expect(countRecoveries(steps)).toBe(2)
  })
})

describe('Phase 2.0 — evidence-based goal verdict', () => {
  it('completes when the final actionable action is verified', () => {
    const t = trace('completed', [
      step({ toolId: 'desktop.visualInspect', status: 'COMPLETED', verification: { status: 'not_applicable', message: '', durationMs: 1 } }),
      step({ status: 'COMPLETED', verification: { status: 'verified', message: 'ok', durationMs: 1 } }),
    ])
    const result = evaluateGoalTask(t)
    expect(result.status).toBe('completed')
    expect(result.evidence).toEqual({ kind: 'action_verified' })
    expect(result.actionable).toBe(true)
    expect(result.recoveries).toBe(0)
  })

  it('never completes an actionable run whose final action is unverified', () => {
    const result = evaluateGoalTask(trace('completed', [step({ status: 'COMPLETED', verification: { status: 'unverified', message: '', durationMs: 1 } })]))
    expect(result.status).toBe('unverified')
    expect(result.reason).toMatch(/not declared complete/i)
    expect(result.actionable).toBe(true)
    expect(result.evidence.kind).toBe('none')
  })

  it('refuses a model "success" claim without evidence', () => {
    const result = evaluateGoalTask(trace('completed', [step({ status: 'COMPLETED', verification: undefined })]))
    expect(result.status).toBe('unverified')
  })

  it('fails an actionable run whose final action was refuted', () => {
    const result = evaluateGoalTask(trace('completed', [step({ status: 'COMPLETED', verification: { status: 'failed', message: 'contradicted', durationMs: 1 } })]))
    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/NOT achieved/i)
  })

  it('stays completed for read-only runs (Q&A keeps its semantics)', () => {
    const t = trace('completed', [
      step({ toolId: 'notes.get', status: 'COMPLETED', observation: { kind: 'informational', toolId: 'notes.get', summary: '', attempts: 1, durationMs: 0 } }),
    ])
    const result = evaluateGoalTask(t)
    expect(result.status).toBe('completed')
    expect(result.evidence).toEqual({ kind: 'read_only_answer' })
    expect(result.actionable).toBe(false)
  })

  it('maps orchestration-limit stops with prior verified progress to partial (multi-step honesty)', () => {
    const t = trace('failed', [
      step({ status: 'COMPLETED', verification: { status: 'verified', message: '', durationMs: 1 } }),
      step({ status: 'FAILED', observation: { kind: 'failure', toolId: 'desktop.click', summary: '', errorKind: 'orchestration_limit', attempts: 1, durationMs: 0 } }),
    ])
    const result = evaluateGoalTask(t)
    expect(result.status).toBe('partial')
    expect(result.reason).toMatch(/NOT fully achieved/i)
    expect(result.verifiedSteps).toBe(1)
    expect(result.executedSteps).toBe(2)
  })

  it('reports partial when steps 1-3 verified but step 4 failed (never SUCCESS)', () => {
    const t = trace('failed', [
      step({ toolId: 'app.launch', status: 'COMPLETED', verification: { status: 'verified', message: '', durationMs: 1 } }),
      step({ status: 'COMPLETED', verification: { status: 'verified', message: '', durationMs: 1 } }),
      step({ status: 'COMPLETED', verification: { status: 'verified', message: '', durationMs: 1 } }),
      step({ status: 'FAILED', observation: { kind: 'failure', toolId: 'desktop.click', summary: 'boom', errorKind: 'tool_failure', attempts: 1, durationMs: 0 } }),
    ])
    const result = evaluateGoalTask(t)
    expect(result.status).toBe('partial')
    expect(result.verifiedSteps).toBe(3)
    expect(result.status).not.toBe('completed')
  })

  it('stays failed when zero steps were verified (no false partial)', () => {
    const t = trace('failed', [
      step({ toolId: 'app.launch', status: 'FAILED', observation: { kind: 'failure', toolId: 'app.launch', summary: 'boom', errorKind: 'tool_failure', attempts: 1, durationMs: 0 } }),
    ])
    const result = evaluateGoalTask(t)
    expect(result.status).toBe('failed')
  })

  it('keeps blocked when a rail stopped before any verification but no verified progress', () => {
    const t = trace('failed', [
      step({ status: 'FAILED', observation: { kind: 'failure', toolId: 'desktop.click', summary: '', errorKind: 'plan_rejected', attempts: 1, durationMs: 0 } }),
    ])
    const result = evaluateGoalTask(t)
    expect(result.status).toBe('blocked')
  })

  it('never reports an all-rejected run (hallucinated capability) as completed', () => {
    const t = trace('completed', [
      step({ toolId: 'delete_everything', status: 'FAILED', observation: { kind: 'failure', toolId: 'delete_everything', summary: '', errorKind: 'plan_rejected', attempts: 1, durationMs: 0 } }),
    ])
    const result = evaluateGoalTask(t)
    expect(result.status).toBe('blocked')
    expect(result.status).not.toBe('completed')
    expect(result.evidence.kind).toBe('none')
    expect(result.actionable).toBe(false)
  })

  it('keeps Q&A completed when read-only steps executed alongside rejections', () => {
    const t = trace('completed', [
      step({ toolId: 'notes.get', status: 'COMPLETED', observation: { kind: 'informational', toolId: 'notes.get', summary: '', attempts: 1, durationMs: 0 } }),
      step({ toolId: 'file.read', status: 'FAILED', observation: { kind: 'failure', toolId: 'file.read', summary: '', errorKind: 'plan_rejected', attempts: 1, durationMs: 0 } }),
    ])
    const result = evaluateGoalTask(t)
    expect(result.status).toBe('completed')
    expect(result.evidence).toEqual({ kind: 'read_only_answer' })
  })

  it('reports partial when the final action was refuted after earlier verified steps', () => {
    const t = trace('completed', [
      step({ toolId: 'app.launch', status: 'COMPLETED', verification: { status: 'verified', message: '', durationMs: 1 } }),
      step({ status: 'COMPLETED', verification: { status: 'failed', message: 'contradicted', durationMs: 1 } }),
    ])
    const result = evaluateGoalTask(t)
    expect(result.status).toBe('partial')
    expect(result.verifiedSteps).toBe(1)
    expect(result.reason).toMatch(/NOT fully achieved/i)
  })

  it('maps cancelled traces to cancelled', () => {
    const result = evaluateGoalTask(trace('cancelled', [step({ status: 'CANCELLED' })]))
    expect(result.status).toBe('cancelled')
  })
})