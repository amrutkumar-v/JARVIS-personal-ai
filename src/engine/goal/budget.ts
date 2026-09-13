/**
 * Goal-level budget contract (Phase 2.0).
 *
 * A goal may execute a bounded number of steps BEFORE the engine refuses to
 * run more — regardless of rounds, time or what the model says. The budget is
 * a pure, model-immune ceiling: it must NOT be settable from a tool payload or
 * plan (see `validatePlan`), only from engine construction config.
 */

export type GoalLimits = {
  /** Max executed steps allowed per goal run. */
  maxTaskSteps: number
  /** Max refuted/unverified steps allowed before a controlled stop. */
  maxRecoveryAttempts: number
  /** Max bounded replan (recovery continuation) requests per goal run. */
  maxReplans: number
  /** Phase 6 — max wall-clock time (ms) for the whole goal run. When set,
   * the execution loop stops once `now - startedAt` reaches this ceiling.
   * Model-immune: never settable from a tool payload or plan. */
  totalExecutionMs: number
}

/**
 * Conservative initial limits.
 *
 *  - `maxTaskSteps: 10` — placed one step above the per-round burst cap
 *    (AGENT_LIMITS.MAX_AGENT_STEPS = 8 checks only at ROUND boundaries, so up
 *    to 8 genuine executions can complete inside one round). The goal budget
 *    is instead checked PER REQUEST inside a round, making it the explicit,
 *    separate goal-work ceiling. 10 keeps an allowed 8-step burst intact while
 *    capping any goal that tries to slip extra requests past the burst check.
 *    Deployments may tighten it via engine `goalLimits`; the model cannot.
 *  - `maxRecoveryAttempts: 2` — a goal may refute/leave-unverified a step at
 *    most twice before the engine stops on an orchestration limit. Two is
 *    enough for one stale/UI recovery plus one re-attempt, never a loop.
 *  - `maxReplans: 3` — Phase 2.2 peer budget for bounded replanning: after a
 *    classified failure the engine may request (at most) three corrected
 *    continuations from the model. Replans are NOT allowed to reset any
 *    budget — trace/evidence/recovery counts survive every replan, and the
 *    loop-top recovery gate still stops a goal that keeps leaving evidence
 *    unverified.
 */
export const GOAL_LIMITS: GoalLimits = {
  maxTaskSteps: 10,
  maxRecoveryAttempts: 2,
  maxReplans: 3,
  totalExecutionMs: 120_000,
}

/** Phase 6 — TRUE when the run's wall-clock elapsed time reached the ceiling. */
export function deadlineReached(
  startedAtMs: number,
  elapsedMs: number,
  limitMs: number = GOAL_LIMITS.totalExecutionMs,
): boolean {
  if (limitMs <= 0) return false
  return elapsedMs >= limitMs || Date.now() - startedAtMs >= limitMs
}

/** True when the goal has already executed `stepCount` steps. */
export function taskBudgetExceeded(
  stepCount: number,
  maxSteps: number = GOAL_LIMITS.maxTaskSteps,
): boolean {
  return stepCount >= maxSteps
}

/** How many more executed steps this goal may run before the ceiling. */
export function taskBudgetRemaining(
  stepCount: number,
  maxSteps: number = GOAL_LIMITS.maxTaskSteps,
): number {
  return Math.max(0, maxSteps - stepCount)
}

/** True when `recoveries` refuted/unverified steps exceed the ceiling. */
export function recoveryBudgetExceeded(
  recoveries: number,
  max: number = GOAL_LIMITS.maxRecoveryAttempts,
): boolean {
  return recoveries > max
}

/** True when all `replans` recovery continuations have been used up. */
export function replanBudgetExceeded(
  replans: number,
  max: number = GOAL_LIMITS.maxReplans,
): boolean {
  return replans >= max
}

/** How many replan (recovery continuation) requests remain. */
export function replanBudgetRemaining(
  replans: number,
  max: number = GOAL_LIMITS.maxReplans,
): number {
  return Math.max(0, max - replans)
}