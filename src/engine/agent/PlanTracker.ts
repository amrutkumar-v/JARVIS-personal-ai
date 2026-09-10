import type {
  AgentObservation,
  AgentPlan,
  AgentPlanStatus,
  AgentStep,
  AgentStepResult,
  AgentStepStatus,
  AgentVerification,
  TaskSnapshot,
} from './types'
import type { CapabilityPreview } from '../capabilities/types'

/**
 * Pure state-transition rule for a step.
 * `undefined` means the transition is not allowed (caller keeps current).
 */
export function transitionStatus(
  current: AgentStepStatus,
  next: AgentStepStatus,
): AgentStepStatus | undefined {
  if (current === next) return next
  switch (current) {
    case 'PENDING':
      if (
        next === 'RUNNING' ||
        next === 'WAITING_CONFIRMATION' ||
        next === 'SKIPPED' ||
        next === 'CANCELLED' ||
        // Phase 2.1 — pre-execution refusals and verification-refuted steps
        // (plan_rejected / unknown tool / invalid input / permission denied /
        // user declined / budget stop) are FAILED even though they never ran.
        next === 'FAILED' ||
        // The engine may run a step without a separate RUNNING marker when the
        // tracker step is created at execution time.
        next === 'COMPLETED'
      ) {
        return next
      }
      return undefined
    case 'RUNNING':
      if (next === 'COMPLETED' || next === 'FAILED' || next === 'WAITING_CONFIRMATION' || next === 'CANCELLED') {
        return next
      }
      return undefined
    case 'WAITING_CONFIRMATION':
      if (next === 'RUNNING' || next === 'SKIPPED' || next === 'CANCELLED' || next === 'FAILED') {
        return next
      }
      return undefined
    default:
      // COMPLETED / FAILED / SKIPPED / CANCELLED are terminal.
      return undefined
  }
}

/** A plan is done when its status leaves ACTIVE. */
export function planTerminal(status: AgentPlanStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED'
}

/** A single prerequisite unblocks dependents only once it COMPLETED. */
export function prerequisiteSatisfied(step: AgentStep | undefined): boolean {
  return step?.status === 'COMPLETED'
}

/**
 * True when a step's EXPLICIT dependencies (plan `dependsOn` /
 * `setDependencies`) are all satisfied. The default sequential chain added by
 * the tracker is NEVER enforced — it is informational ordering only, so a
 * failed step can be retried with different arguments in the same goal run.
 * Unknown or non-completed dependencies block the step.
 */
export function dependenciesSatisfied(plan: AgentPlan | null, stepId: string): boolean {
  if (!plan) return false
  const step = plan.steps.find((s) => s.id === stepId)
  if (!step?.dependenciesExplicit || !step.dependsOn || step.dependsOn.length === 0) return true
  return step.dependsOn.every((depId) => prerequisiteSatisfied(plan.steps.find((s) => s.id === depId)))
}

function nextStepId(goalId: string, index: number): string {
  return `step-${goalId}-${index}`
}

/**
 * Mutable, UI-independent record of the current agent task.
 * The engine drives it; pure transition rules keep states consistent.
 */
export class PlanTracker {
  private plan: AgentPlan | null = null
  private counter = 0

  start(goal: string): AgentPlan {
    const id = `plan-${Date.now().toString(36)}-${++this.counter}`
    this.plan = {
      id,
      goal,
      status: 'ACTIVE',
      steps: [],
      createdAt: Date.now(),
    }
    return this.snapshotPlan()
  }

  get active(): boolean {
    return this.plan !== null && this.plan.status === 'ACTIVE'
  }

  get current(): AgentPlan | null {
    return this.plan ? this.snapshotPlan() : null
  }

  /** How many steps exist (grows as the provider plans further). */
  get totalSteps(): number {
    return this.plan?.steps.length ?? 0
  }

  /** Steps that have left PENDING (started, blocked or done). */
  get startedSteps(): number {
    if (!this.plan) return 0
    return this.plan.steps.filter((s) => s.status !== 'PENDING').length
  }

  get steps(): AgentStep[] {
    return this.plan ? this.snapshotPlan().steps : []
  }

  addStep(opts: {
    toolId: string
    input: Record<string, unknown>
    requiresConfirmation: boolean
    callId?: string
    dependsOn?: string[]
    /** Phase 2.3 — capability this step was resolved from (optional). */
    capability?: string
    /** Phase 2.4 — engine-computed, UI-safe preview metadata of the resolved
     * capability (risk/permission/verification/confirmation). */
    capabilityMeta?: CapabilityPreview
  }): AgentStep {
    if (!this.plan) throw new Error('PlanTracker has no active plan')
    // Sequential plans link each new step to the previous one by default for
    // inspection. This chain is NOT enforced (see dependenciesSatisfied) —
    // explicit `dependsOn` from the plan request IS enforced.
    const dependsOn =
      opts.dependsOn ??
      (this.plan.steps.length > 0
        ? [this.plan.steps[this.plan.steps.length - 1].id]
        : undefined)
    const step: AgentStep = {
      id: nextStepId(this.plan.id, this.totalSteps),
      toolId: opts.toolId,
      input: opts.input,
      status: 'PENDING',
      requiresConfirmation: opts.requiresConfirmation,
      callId: opts.callId,
      capability: opts.capability,
      capabilityMeta: opts.capabilityMeta,
      dependsOn,
      dependenciesExplicit: opts.dependsOn !== undefined,
    }
    this.plan.steps.push(step)
    return { ...step }
  }

  /**
   * Phase 2.2 — declare explicit dependencies for a step (same-round plan
   * `dependsOn`, referenced by request index). Overwrites the informational
   * chain and marks the step's dependencies as enforced.
   */
  setDependencies(stepId: string, dependencyIds: string[]): void {
    const step = this.find(stepId)
    if (!step) return
    step.dependsOn = dependencyIds
    step.dependenciesExplicit = true
  }

  /** Phase 2.2 — attach/replace a human-readable note (UI + audit). */
  setNote(stepId: string, note: string): void {
    const step = this.find(stepId)
    if (!step) return
    step.note = note
  }

  /** True when the step's EXPLICIT dependencies are all satisfied. */
  isReady(stepId: string): boolean {
    return dependenciesSatisfied(this.plan, stepId)
  }

  setStatus(stepId: string, status: AgentStepStatus): void {
    if (!this.plan) return
    const step = this.plan.steps.find((s) => s.id === stepId)
    if (!step) return
    const next = transitionStatus(step.status, status)
    if (!next) return
    step.status = next
    if (status === 'RUNNING' || status === 'WAITING_CONFIRMATION') {
      step.startedAt = step.startedAt ?? Date.now()
    }
    if (next === 'FAILED') step.completedAt = Date.now()
  }

  completeStep(stepId: string, result: AgentStepResult): void {
    const step = this.find(stepId)
    if (!step) return
    const next = transitionStatus(step.status, 'COMPLETED')
    if (!next) return
    step.status = next
    step.result = result
    step.completedAt = Date.now()
  }

  failStep(stepId: string, result: AgentStepResult): void {
    const step = this.find(stepId)
    if (!step) return
    const next = transitionStatus(step.status, 'FAILED')
    if (!next) return
    step.status = next
    step.result = result
    step.error = result.message
    step.completedAt = Date.now()
  }

  skipStep(stepId: string): void {
    const step = this.find(stepId)
    if (!step) return
    const next = transitionStatus(step.status, 'SKIPPED')
    if (!next) return
    step.status = next
    step.completedAt = Date.now()
  }

  /** Attach the structured observation of a step's execution (Phase 1.0). */
  setObservation(stepId: string, observation: AgentObservation): void {
    const step = this.find(stepId)
    if (!step) return
    step.observation = observation
  }

  /** Attach the tool-owned verification outcome (Phase 1.0). */
  setVerification(stepId: string, verification: AgentVerification): void {
    const step = this.find(stepId)
    if (!step) return
    step.verification = verification
  }

  /** Mark every non-terminal step CANCELLED (used when the task is stopped). */
  cancelRemaining(): void {
    if (!this.plan) return
    for (const step of this.plan.steps) {
      const next = transitionStatus(step.status, 'CANCELLED')
      if (!next) continue
      step.status = next
      if (!step.completedAt) step.completedAt = Date.now()
    }
  }

  finish(status: AgentPlanStatus): void {
    if (!this.plan || planTerminal(this.plan.status)) return
    this.plan.status = status
    this.plan.completedAt = Date.now()
  }

  /** Snapshot for the UI task indicator. `label` comes from the engine. */
  snapshot(label: string): TaskSnapshot {
    if (!this.plan || planTerminal(this.plan.status)) {
      return { active: false, label: '', step: 0, total: 0, status: 'COMPLETED' }
    }
    return {
      active: true,
      label,
      step: this.startedSteps,
      total: this.totalSteps || this.startedSteps,
      status: this.plan.status,
    }
  }

  private find(stepId: string): AgentStep | undefined {
    return this.plan?.steps.find((s) => s.id === stepId)
  }

  private snapshotPlan(): AgentPlan {
    if (!this.plan)
      return { id: '', goal: '', status: 'CANCELLED', steps: [], createdAt: Date.now() }
    return {
      id: this.plan.id,
      goal: this.plan.goal,
      status: this.plan.status,
      steps: this.plan.steps.map((s) => ({ ...s, result: s.result ? { ...s.result } : undefined })),
      createdAt: this.plan.createdAt,
      completedAt: this.plan.completedAt,
    }
  }
}