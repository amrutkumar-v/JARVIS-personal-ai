import type { AgentState } from './stateMachine'
import type { AgentTraceEvent, AgentStepStatus, TraceStep } from './types'
import type { GoalTaskResult } from '../goal/types'

/**
 * Per-run execution trace (Phase 1.0).
 *
 * Holds a deterministic, internally-visible record of one agent run — goal,
 * timing, final state and every executed step with its observation and
 * verification outcome. Internal only: it is surfaced via
 * `engine.lastRunTrace()` for debugging / audit / future UI, and is never
 * pushed to the provider or printed to the user as raw internals.
 *
 * Phase 2.2 extends it with a compact `events[]` list of operational facts
 * (capability selection, plan validation results, recovery classifications,
 * replan requests) so audits and future UIs can reconstruct why the run took
 * the decisions it did — without holding any model reasoning.
 */

export interface AgentTrace {
  goal: string
  startedAt?: number
  completedAt?: number
  finalState?: AgentState
  steps: TraceStep[]
  /** Phase 2.2 operational events appended while the run progressed. */
  events?: AgentTraceEvent[]
  /** Phase 2.0 evidence-based goal verdict, attached by the engine. */
  task?: GoalTaskResult
}

export class ExecutionTracer {
  private run: AgentTrace | null = null

  /** Start a fresh trace for a new goal (overwrites the previous run). */
  begin(goal: string): void {
    this.run = { goal, startedAt: Date.now(), steps: [], events: [] }
  }

  get active(): boolean {
    return this.run !== null
  }

  /** Record one completed tool step on the trace. */
  addStep(step: TraceStep): void {
    if (!this.run) return
    this.run.steps.push(step)
  }

  /** Append a structured operational event (Phase 2.2). No-op when inactive. */
  recordEvent(event: AgentTraceEvent): void {
    if (!this.run) return
    this.run.events = this.run.events ?? []
    this.run.events.push(event)
  }

  /**
   * Phase 6 — upgrade the LAST completed step for `toolId` with a NEW
   * post-action verification outcome (e.g. a cross-tool observation that
   * confirmed the effect after the step's own verifier left it unverified).
   *
   * Bounded deliberately: only ever upgrades to `verified` (never downgrades),
   * only touches the most recent matching step, and only when the run holds
   * that step. This is what lets `makeResult` count a genuinely confirmed
   * effect as verified without fabricating evidence.
   */
  updateStepVerification(
    toolId: string,
    status: AgentStepStatus,
    verification: { status: 'verified'; message: string },
  ): boolean {
    if (!this.run) return false
    for (let i = this.run.steps.length - 1; i >= 0; i -= 1) {
      const step = this.run.steps[i]
      if (step.toolId !== toolId || !step.observation) continue
      step.verification = {
        ...(step.verification ?? {}),
        status: 'verified',
        message: verification.message,
        durationMs: step.verification?.durationMs ?? 0,
      }
      step.status = status
      return true
    }
    return false
  }

  /** Close the trace with a terminal agent state. */
  end(finalState: AgentState): AgentTrace {
    if (this.run) {
      this.run.finalState = finalState
      this.run.completedAt = Date.now()
    }
    return this.snapshot()
  }

  /** Detached deep copy safe to hand out. */
  snapshot(): AgentTrace {
    if (!this.run) {
      return { goal: '', steps: [] }
    }
    return structuredClone(this.run)
  }

  clear(): void {
    this.run = null
  }
}