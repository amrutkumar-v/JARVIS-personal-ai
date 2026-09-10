import { describe, expect, it } from 'vitest'
import type { GoalRunSnapshot } from '../../state/goalRun'
import { EMPTY_GOAL_RUN } from '../../state/goalRun'
import {
  budgetRatio,
  budgetText,
  presentGoalRun,
  recoveryText,
  stepLine,
  STEP_LABELS,
  VERDICT_CHIP,
} from './goalView'
import type { GoalStepStatus, GoalTaskStatus } from '../../engine/goal/types'

function snapshot(overrides: Partial<GoalRunSnapshot>): GoalRunSnapshot {
  return {
    ...EMPTY_GOAL_RUN,
    ...overrides,
  }
}

function finishedPlan(steps: Array<{ state: GoalStepStatus; action?: string }>) {
  return {
    active: false,
    goal: 'open the settings',
    status: 'COMPLETED' as const,
    steps: steps.map((s) => ({
      toolId: 'desktop.click',
      action: s.action ?? 'Click',
      status: 'COMPLETED' as const,
      state: s.state,
      attempts: 1,
      evidence: 'ok',
    })),
  }
}

describe('Phase 2.1 — goal panel presentation (pure)', () => {
  it('labels every step state with text + a glyph (never color-only)', () => {
    const states: GoalStepStatus[] = ['planned', 'executing', 'verified', 'refuted', 'unverified', 'blocked', 'failed', 'cancelled']
    for (const s of states) {
      const line = stepLine(s, 'desktop.click', 'Click', 1, 'ok')
      expect(line.label).toBe(STEP_LABELS[s])
      expect(line.signGlyph.length).toBeGreaterThan(0)
    }
  })

  it('is idle with an empty plan before anything runs', () => {
    const view = presentGoalRun(EMPTY_GOAL_RUN)
    expect(view.kind).toBe('idle')
    expect(view.showPlan).toBe(false)
    expect(view.verdict).toBeNull()
    expect(view.cancellable).toBe(false)
  })

  it('treats an active plan as LIVE — no verdict is fabricated mid-run', () => {
    const view = presentGoalRun(
      snapshot({
        plan: {
          active: true,
          goal: 'click the point',
          status: 'ACTIVE',
          steps: [{ toolId: 'desktop.click', action: 'Click', status: 'RUNNING', state: 'executing', attempts: 0, evidence: '' }],
        },
      }),
    )
    expect(view.kind).toBe('running')
    expect(view.verdict).toBeNull()
    expect(view.cancellable).toBe(true)
    expect(view.steps[0].state).toBe('executing')
  })

  it('shows the engine verdict verbatim once a run finished', () => {
    const view = presentGoalRun(
      snapshot({
        plan: finishedPlan([{ state: 'verified' }]),
        budget: { steps: 1, remaining: 9, limit: 10 },
        task: {
          status: 'completed',
          reason: 'The goal was achieved and the result was confirmed.',
          evidence: { kind: 'action_verified' },
          actionable: true,
          executedSteps: 1,
          verifiedSteps: 1,
          refutedSteps: 0,
          unverifiedSteps: 0,
          rejectedSteps: 0,
          recoveries: 0,
        } as GoalRunSnapshot['task'],
      }),
    )
    expect(view.kind).toBe('finished')
    expect(view.verdict?.title).toBe(VERDICT_CHIP.completed)
    expect(view.verdict?.detail).toContain('confirmed')
    expect(view.steps[0].state).toBe('verified')
  })

  it('HONESTY: a finished run whose goal could not be confirmed shows the unverified verdict', () => {
    // The engine closes the run normally (finalState completed) but the goal
    // stays unverified (no proof). The panel must NEVER display it as done.
    const view = presentGoalRun(
      snapshot({
        plan: finishedPlan([{ state: 'unverified' }]),
        budget: { steps: 1, remaining: 9, limit: 10 },
        task: {
          status: 'unverified',
          reason: 'Step results could not be confirmed, so the goal is NOT declared complete.',
          evidence: { kind: 'none' },
          actionable: true,
          executedSteps: 1,
          verifiedSteps: 0,
          refutedSteps: 0,
          unverifiedSteps: 1,
          rejectedSteps: 0,
          recoveries: 1,
        } as GoalRunSnapshot['task'],
      }),
    )
    expect(view.kind).toBe('finished')
    expect(view.verdict?.title).toBe('Finished — not declared complete')
    expect(view.verdict?.detail).toMatch(/NOT declared complete/)
  })

  it('maps every verdict status to a chip label', () => {
    const statuses: GoalTaskStatus[] = ['planning', 'executing', 'recovering', 'completed', 'failed', 'unverified', 'blocked', 'cancelled']
    for (const s of statuses) {
      expect(VERDICT_CHIP[s].length).toBeGreaterThan(0)
    }
  })

  it('computes the step budget ratio/clamp and budget text from the engine numbers', () => {
    const snap = snapshot({ budget: { steps: 3, remaining: 1, limit: 4 } })
    expect(budgetRatio(snap)).toBe(0.75)
    expect(budgetText(snap)).toBe('3 of 4 steps used (1 left)')
    expect(budgetRatio(snapshot({ budget: { steps: 99, remaining: 0, limit: 10 } }))).toBe(1)
    expect(budgetRatio(snapshot({ budget: { steps: 0, remaining: 0, limit: 0 } }))).toBe(0)
  })

  it('reports recovery usage only when actual recoveries exist', () => {
    const plain = snapshot({})
    expect(recoveryText(plain)).toBeNull()
    const recovering = snapshot({
      plan: finishedPlan([{ state: 'refuted' }]),
      task: {
        status: 'failed',
        reason: 'x',
        evidence: { kind: 'action_verified' },
        actionable: true,
        executedSteps: 1,
        verifiedSteps: 0,
        refutedSteps: 1,
        unverifiedSteps: 0,
        rejectedSteps: 0,
        recoveries: 1,
      } as GoalRunSnapshot['task'],
      recovery: {
        verificationFailures: 1,
        maxRecoveryAttempts: 2,
        replans: 2,
        maxReplans: 3,
        active: false,
      },
    })
    expect(recoveryText(recovering)).toBe('1 of 2 recovery attempts used · 2 of 3 replans used')
  })

  it('exposes the whole plan (including blocked / cancelled steps) after a run', () => {
    const view = presentGoalRun(
      snapshot({
        plan: finishedPlan([{ state: 'blocked', action: 'Click' }, { state: 'cancelled', action: 'Type' }]),
        task: {
          status: 'blocked',
          reason: 'A safety rail stopped the goal before it could be completed.',
          evidence: { kind: 'action_verified' },
          actionable: true,
          executedSteps: 0,
          verifiedSteps: 0,
          refutedSteps: 0,
          unverifiedSteps: 0,
          rejectedSteps: 1,
          recoveries: 0,
        } as GoalRunSnapshot['task'],
      }),
    )
    expect(view.showPlan).toBe(true)
    expect(view.steps.map((s) => s.state)).toEqual(['blocked', 'cancelled'])
    expect(view.verdict?.title).toBe('Blocked by a safety rail')
  })

  it('never leaks tool payloads into the presentation lines', () => {
    const view = presentGoalRun(
      snapshot({
        plan: finishedPlan([{ state: 'verified' }]),
        task: {
          status: 'completed',
          reason: 'confirmed',
          evidence: { kind: 'action_verified' },
          actionable: true,
          executedSteps: 1,
          verifiedSteps: 1,
          refutedSteps: 0,
          unverifiedSteps: 0,
          rejectedSteps: 0,
          recoveries: 0,
        } as GoalRunSnapshot['task'],
      }),
    )
    expect(JSON.stringify(view.steps)).not.toMatch(/payload|window_id|"x"\s*:/)
  })
})