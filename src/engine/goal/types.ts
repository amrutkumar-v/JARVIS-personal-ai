/**
 * Goal-level contracts for bounded, evidence-driven task execution (Phase 2.0).
 *
 * Phase 1.x gave JARVIS safe hands, eyes and per-action verification. Phase 2.0
 * adds an explicit goal/task lifecycle ON TOP of the existing engine — it does
 * NOT add a second agent loop. One run is one goal: the plan comes from the
 * same provider loop, execution still passes through every existing rail, and
 * the engine derives an evidence-based verdict AFTER the run ends.
 *
 * These types are deliberately narrow. PLAN (PlanTracker) vs EXECUTION
 * (TraceStep) vs EVIDENCE (observation/verification) vs RESULT (GoalTaskResult
 * below) stay distinguishable, and nothing here holds typed secrets, raw
 * screenshots or chain-of-thought.
 */

/** Goal lifecycle states (Phase 2.0). The engine maps the run onto these. */
export type GoalTaskStatus =
  | 'planning' // goal accepted, plan being produced
  | 'executing' // at least one step executed, still running
  | 'recovering' // a step failed verification; controlled recovery in progress
  | 'blocked' // a safety rail stopped the run (budget / rejected plan / limit)
  | 'completed' // goal work done AND supported by evidence (or read-only)
  | 'partial' // some steps verified but the goal was NOT fully achieved
  | 'failed' // the goal was not achieved (a step failed / contradicted)
  | 'unverified' // steps executed but the goal result could NOT be confirmed
  | 'cancelled' // the user (or engine) cancelled the run

/** Per-step goal outcome, derived deterministically from the trace. */
export type GoalStepStatus =
  | 'planned' // requested but not yet executed
  | 'executing' // running (never on a finished trace)
  | 'verified' // executed AND its own verifier confirmed the effect
  | 'refuted' // executed BUT its verifier contradicted the effect
  | 'unverified' // executed; the effect could not be confirmed
  | 'blocked' // never ran — a plan/budget/safety rail refused it
  | 'failed' // ran and failed (tool/provider error, retries exhausted)
  | 'cancelled' // stopped mid-run by cancellation

/**
 * What counts as evidence for a goal verdict. Goals are never declared
 * complete on claims: only a confirmed effect (or an entirely read-only
 * answer) produces the `completed` status.
 */
export type GoalEvidenceOutcome =
  | { kind: 'action_verified' } // an injective action was confirmed by its verifier
  | { kind: 'read_only_answer' } // no injective action occurred; text IS the answer
  | { kind: 'none'; reason: string } // goal work happened but no confirmation

/** Structured, evidence-based verdict for one goal run (Phase 2.0). */
export interface GoalTaskResult {
  status: GoalTaskStatus
  /** Concise, user-honest reason for the verdict. */
  reason: string
  evidence: GoalEvidenceOutcome
  /** True when the run performed at least one injective (hands) action. */
  actionable: boolean
  /** Executed steps (real tool executions, retry attempts still one step). */
  executedSteps: number
  verifiedSteps: number
  refutedSteps: number
  unverifiedSteps: number
  /** Steps refused before execution (plan rejection / budget / invalid input). */
  rejectedSteps: number
  /** Refuted or unverified steps — the bounded recovery count. */
  recoveries: number
}