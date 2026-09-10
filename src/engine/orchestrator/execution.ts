/**
 * Phase 3.0B — structured execution result for the personal AI Core.
 *
 * One bridge run returns a single OrchestrationExecutionResult that is honest
 * about the FULL lifecycle actually observed: how many steps executed, how
 * many were independently verified, what observations came back, and at what
 * terminal status the plan finished. The status never claims something that
 * did not happen (`executed` is distinct from `verified`).
 */

import type { RequestClass } from './goalUnderstanding'
import type { OrchestrationPlanStep } from './planner'

export type OrchestrationExecutionStatus =
  | 'completed'
  | 'partial'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'requires_confirmation'
  | 'requires_clarification'

export type OrchestrationVerificationStatus =
  | 'verified'
  | 'unverified'
  | 'refuted'
  | 'not_requested'

export interface OrchestrationStepOutcome {
  /** The planned capability that produced this step. */
  capability: string
  /** The concrete registered tool that actually ran. */
  toolId: string
  status: 'success' | 'failed' | 'skipped'
  observation?: { kind: string; summary: string }
  verified?: boolean
}

export interface OrchestrationExecutionResult {
  status: OrchestrationExecutionStatus
  goal: string
  requestClass: RequestClass
  /** The plan that was validated and executed (empty when not run). */
  plan: OrchestrationPlanStep[]
  steps: OrchestrationStepOutcome[]
  completedSteps: number
  failedSteps: number
  skippedSteps: number
  /** Steps with an independently verified effect. Never implies execution. */
  verifiedSteps: number
  /** Steps that executed but were NOT independently verified. */
  unverifiedSteps: number
  observations: Array<{ toolId: string; kind: string; summary: string }>
  verification: Array<{ toolId: string; status: OrchestrationVerificationStatus }>
  /** Explicit device targets preserved from the request. */
  targetDevices: string[]
  implicitTargetDevice?: string
  error?: string
  reason?: string
  requiresUserAction?: boolean
  finishedAt: number
}