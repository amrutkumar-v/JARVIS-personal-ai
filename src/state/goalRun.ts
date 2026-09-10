import type { GoalPlanRecoveryView, GoalPlanView } from '../engine/contracts'
import type { GoalTaskResult } from '../engine/goal/types'

/**
 * Phase 2.1 — GOAL UI STATE (store mirror).
 *
 * The store NEVER derives a goal verdict itself: it only mirrors exactly what
 * the ENGINE already computes (`goalPlan()`, `taskBudget()`,
 * `goalLimitsInfo()`, `taskResult()`). The verdict shown to the user always
 * comes from `GoalTaskResult` produced by `evaluateGoalTask` inside the
 * engine. This file is pure — no engine internals, no I/O — and is tested in
 * the node test environment.
 */

/** Composer input mode. Presentation-only: BOTH modes call engine.process(). */
export type GoalMode = 'ask' | 'goal'

/** What the Goal panel may display: the engine's own numbers, nothing else. */
export interface GoalRunSnapshot {
  mode: GoalMode
  plan: GoalPlanView
  budget: { steps: number; remaining: number; limit: number }
  /** Engines' goal limits (Phase 2.2 adds the bounded replan ceiling). */
  limits: { maxTaskSteps: number; maxRecoveryAttempts: number; maxReplans: number }
  /** Phase 2.2 bounded recovery counters mirrored from the engine.getters. */
  recovery: GoalPlanRecoveryView
  /**
   * The engine's evidence-based verdict of the CURRENT job.
   * `status === 'planning'` means no finished result exists yet.
   */
  task: GoalTaskResult | null
  /** ISO timestamp of the last engine-provided refresh. */
  refreshedAt: string
}

/** The minimal engine surface the UI may read for goal state. */
export interface GoalRunSource {
  goalPlan(): GoalPlanView
  taskBudget(): { steps: number; remaining: number; limit: number }
  goalLimitsInfo(): { maxTaskSteps: number; maxRecoveryAttempts: number; maxReplans: number }
  goalRecovery(): GoalPlanRecoveryView
  taskResult(): GoalTaskResult | null
}

export const GOAL_LIMIT_DEFAULTS = {
  maxTaskSteps: 10,
  maxRecoveryAttempts: 2,
  maxReplans: 3,
} as const

export const EMPTY_GOAL_RUN: GoalRunSnapshot = {
  mode: 'ask',
  plan: { active: false, goal: '', status: 'CANCELLED', steps: [] },
  budget: { steps: 0, remaining: GOAL_LIMIT_DEFAULTS.maxTaskSteps, limit: GOAL_LIMIT_DEFAULTS.maxTaskSteps },
  limits: { ...GOAL_LIMIT_DEFAULTS },
  recovery: {
    verificationFailures: 0,
    maxRecoveryAttempts: GOAL_LIMIT_DEFAULTS.maxRecoveryAttempts,
    replans: 0,
    maxReplans: GOAL_LIMIT_DEFAULTS.maxReplans,
    active: false,
  },
  task: null,
  refreshedAt: '',
}

/** Mirror whatever the engine reports — nothing inferred or manufactured. */
export function buildGoalRunSnapshot(
  source: GoalRunSource,
  mode: GoalMode,
  now: number = Date.now(),
): GoalRunSnapshot {
  return {
    mode,
    plan: source.goalPlan(),
    budget: source.taskBudget(),
    limits: source.goalLimitsInfo(),
    recovery: source.goalRecovery(),
    task: source.taskResult(),
    refreshedAt: new Date(now).toISOString(),
  }
}

/**
 * One engine→store refresh used by the UI (and by the same-path voice
 * regression). Reads ONLY the engine's getters, preserves the user's chosen
 * input mode, and writes the mirror snapshot atomically.
 */
export function syncGoalRun(
  source: GoalRunSource,
  getMode: () => GoalMode,
  apply: (snapshot: GoalRunSnapshot) => void,
  now?: number,
): GoalRunSnapshot {
  const snapshot = buildGoalRunSnapshot(source, getMode(), now)
  apply(snapshot)
  return snapshot
}