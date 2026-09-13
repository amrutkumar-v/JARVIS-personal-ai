import type { GoalRunSnapshot } from '../../state/goalRun'
import { GOAL_LIMIT_DEFAULTS } from '../../state/goalRun'
import type { GoalTaskStatus, GoalStepStatus } from '../../engine/goal/types'
import type { CapabilityPreview } from '../../engine/capabilities/types'

/**
 * Phase 2.1 — GOAL PANEL PRESENTATION (pure, tested, UI-stateless).
 *
 * This module only FORMATS data that the ENGINE already computed (verdict =
 * `task.reason`/`task.status` from `evaluateGoalTask`, budget = `taskBudget`,
 * plan = `goalPlan`). It never derives a verdict itself and never touches
 * tool payloads. Colors are presentation-only; every state also carries a
 * text label and a glyph so meaning never depends on color alone.
 */

export type StepSign =
  | 'pending' // stepped and scheduled: ◦
  | 'running' // executing: ↻
  | 'verified' // effect confirmed: ✓
  | 'refuted' // effect contradicted: ✗
  | 'unverified' // not provable:?
  | 'blocked' // refused by a rail: ⛔ (glyph left as text)
  | 'failed' // genuine failure: !
  | 'cancelled' // never ran: —

export interface StepViewLine {
  toolId: string
  action: string
  state: GoalStepStatus
  label: string
  sign: StepSign
  signGlyph: string
  attempts: number
  evidence: string
  /** Phase 2.2 engine note (dependency block / recovery classification). */
  note?: string
  /** Phase 2.3 — capability a step resolved from (e.g. `open_application`). */
  capability?: string
  /** Phase 2.4 — engine-computed, high-level preview of the resolved
   * capability (risk, permission, verification preference, confirmation). */
  capabilityMeta?: CapabilityPreview
}

export interface VerdictView {
  status: GoalTaskStatus
  title: string
  detail: string
}

export type GoalViewKind = 'idle' | 'running' | 'finished'

export interface GoalViewPresentation {
  kind: GoalViewKind
  goal: string
  /** Human-readable plan status (ACTIVE / COMPLETED / FAILED / CANCELLED). */
  planLabel: string
  steps: StepViewLine[]
  /** True when there is at least one planned/executed step to show. */
  showPlan: boolean
  /** Engine-provided verdict; present only after a real run finished. */
  verdict: VerdictView | null
  /** Relative step budget progress in [0,1] (from engine taskBudget). */
  budgetRatio: number
  /** Step budget text, e.g. "3 of 10 steps used". */
  budgetText: string
  /** Recovery budget text, e.g. "1 of 2 recoveries used", or null. */
  recoveryText: string | null
  /** Phase 2.2 — true while the engine is mid-replan (plan being rebuilt). */
  replanActive: boolean
  /** True when the UI must keep the cancellation control visible. */
  cancellable: boolean
}

export const STEP_LABELS: Record<GoalStepStatus, string> = {
  planned: 'Planned',
  executing: 'Running',
  verified: 'Verified',
  refuted: 'Refuted',
  unverified: 'Unverified',
  blocked: 'Blocked',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const STEP_SIGNS: Record<GoalStepStatus, { sign: StepSign; glyph: string }> = {
  planned: { sign: 'pending', glyph: '•' },
  executing: { sign: 'running', glyph: '↻' },
  verified: { sign: 'verified', glyph: '✓' },
  refuted: { sign: 'refuted', glyph: '✗' },
  unverified: { sign: 'unverified', glyph: '?' },
  blocked: { sign: 'blocked', glyph: '⛔' },
  failed: { sign: 'failed', glyph: '!' },
  cancelled: { sign: 'cancelled', glyph: '–' },
}

const PLAN_LABELS: Record<string, string> = {
  ACTIVE: 'Active plan',
  COMPLETED: 'Completed plan',
  FAILED: 'Failed plan',
  CANCELLED: 'Cancelled plan',
}

/** Verdict title aligns with the engine's own status vocabulary (evaluator). */
export const VERDICT_CHIP: Record<GoalTaskStatus, string> = {
  planning: 'Goal run starting',
  executing: 'Goal executing',
  recovering: 'Recovering after a refuted step',
  completed: 'Goal completed',
  partial: 'Partially completed',
  unverified: 'Finished — not declared complete',
  failed: 'Goal failed',
  blocked: 'Blocked by a safety rail',
  cancelled: 'Goal cancelled',
}

const EMPTY_VERDICT_DETAIL: Record<GoalTaskStatus, string> = {
  planning: 'The goal is still being prepared.',
  executing: 'A step is still running.',
  recovering: 'A step failed verification; recovery retries within the limit.',
  completed: 'The effect was confirmed.',
  partial: 'Some steps were completed and verified, but the goal was not fully achieved.',
  unverified: 'The run finished, but step results could not be confirmed — I am not claiming the goal was achieved.',
  failed: 'The expected result was not achieved.',
  blocked: 'A safety rail stopped the run before completion.',
  cancelled: 'No further actions ran.',
}

export function stepLine(
  state: GoalStepStatus,
  toolId: string,
  action: string,
  attempts: number,
  evidence: string,
  note?: string,
  capability?: string,
  capabilityMeta?: CapabilityPreview,
): StepViewLine {
  const sign = STEP_SIGNS[state]
  return {
    toolId,
    action,
    state,
    label: STEP_LABELS[state],
    sign: sign.sign,
    signGlyph: sign.glyph,
    attempts,
    evidence,
    note,
    ...(capability ? { capability } : {}),
    ...(capabilityMeta ? { capabilityMeta } : {}),
  }
}

export function budgetRatio(snapshot: GoalRunSnapshot): number {
  if (snapshot.budget.limit <= 0) return 0
  return Math.min(1, Math.max(0, snapshot.budget.steps / snapshot.budget.limit))
}

export function budgetText(snapshot: GoalRunSnapshot): string {
  const { steps, remaining, limit } = snapshot.budget
  return `${steps} of ${limit} step${limit === 1 ? '' : 's'} used${remaining > 0 ? ` (${remaining} left)` : ''}`
}

export function recoveryText(snapshot: GoalRunSnapshot): string | null {
  const failures = snapshot.recovery?.verificationFailures ?? snapshot.task?.recoveries ?? 0
  const limit = snapshot.limits.maxRecoveryAttempts
  const anyRecovery = failures > 0 || snapshot.plan.steps.some((s) => s.state === 'refuted' || s.state === 'unverified')
  if (!anyRecovery) return null
  const parts = [`${failures} of ${limit} recovery attempt${limit === 1 ? '' : 's'} used`]
  if (snapshot.recovery && snapshot.recovery.replans > 0) {
    const replans = snapshot.recovery.replans
    const maxReplans = snapshot.recovery.maxReplans
    parts.push(`${replans} of ${maxReplans} replans used`)
  }
  return parts.join(' · ')
}

/** The full presentational model for the Goal panel. */
export function presentGoalRun(snapshot: GoalRunSnapshot | null): GoalViewPresentation {
  const none: GoalViewPresentation = {
    kind: 'idle',
    goal: '',
    planLabel: PLAN_LABELS.ACTIVE,
    steps: [],
    showPlan: false,
    verdict: null,
    budgetRatio: 0,
    budgetText: budgetText(EMPTY_BUDGET(snapshot)),
    recoveryText: null,
    replanActive: false,
    cancellable: false,
  }
  if (!snapshot) return none

  const live = snapshot.plan.active
  const hasVerdict = snapshot.task !== null && snapshot.task.status !== 'planning'
  const task = snapshot.task

  const steps = snapshot.plan.steps.map((s) =>
    stepLine(s.state, s.toolId, s.action, s.attempts, s.evidence, s.note, s.capability, s.capabilityMeta),
  )

  const showPlan = live || snapshot.plan.steps.length > 0
  const verdict: VerdictView | null =
    live || !hasVerdict || !task
      ? null
      : {
          status: task.status,
          title: VERDICT_CHIP[task.status],
          detail: task.reason || EMPTY_VERDICT_DETAIL[task.status],
        }

  return {
    kind: live ? 'running' : hasVerdict ? 'finished' : 'idle',
    goal: snapshot.plan.goal,
    planLabel: PLAN_LABELS[snapshot.plan.status] ?? 'Plan',
    steps,
    showPlan,
    verdict,
    budgetRatio: budgetRatio(snapshot),
    budgetText: budgetText(snapshot),
    recoveryText: recoveryText(snapshot),
    replanActive: snapshot.recovery?.active === true,
    cancellable: live,
  }
}

function EMPTY_BUDGET(snapshot: GoalRunSnapshot | null): GoalRunSnapshot {
  // Used only to render the default "no run" budget line from the defaults.
  const l = snapshot?.limits.maxTaskSteps ?? 10
  const maxReplans = snapshot?.limits.maxReplans ?? GOAL_LIMIT_DEFAULTS.maxReplans
  return {
    mode: 'ask',
    plan: { active: false, goal: '', status: 'CANCELLED', steps: [] },
    budget: { steps: 0, remaining: l, limit: l },
    limits: {
      maxTaskSteps: l,
      maxRecoveryAttempts: snapshot?.limits.maxRecoveryAttempts ?? GOAL_LIMIT_DEFAULTS.maxRecoveryAttempts,
      maxReplans,
    },
    task: null,
    recovery: {
      verificationFailures: snapshot?.recovery?.verificationFailures ?? 0,
      maxRecoveryAttempts: snapshot?.recovery?.maxRecoveryAttempts ?? GOAL_LIMIT_DEFAULTS.maxRecoveryAttempts,
      replans: snapshot?.recovery?.replans ?? 0,
      maxReplans,
      active: false,
    },
    refreshedAt: '',
  }
}