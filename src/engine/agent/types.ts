/**
 * Agent plan types — the internal representation of a multi-step task.
 *
 * The plan is deliberately UI-independent: a structured trace the engine
 * grows as the provider reasons and requests tool calls. The engine owns
 * mutation through PlanTracker; these are the pure shape contracts.
 */

import type { AgentState } from './stateMachine'
import type { GoalTaskResult } from '../goal/types'
import type { CapabilityPreview } from '../capabilities/types'

export type AgentStepStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING_CONFIRMATION'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED'
  | 'CANCELLED'

export type AgentPlanStatus = 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

/** Root-cause of a failed step. The engine maps tool/provider errors here. */
export type AgentErrorKind =
  | 'invalid_input'
  | 'permission_denied'
  | 'user_cancelled'
  | 'tool_failure'
  | 'timeout'
  | 'provider_failure'
  | 'orchestration_limit'
  | 'plan_rejected'

/**
 * Structured failure category for deterministic recovery (Phase 2.2).
 * The engine classifies a failed step into exactly one of these before
 * deciding whether/how to recover; never exposed to the provider as reasoning.
 */
export type RecoveryFailureKind =
  | 'transient' // machinery failure / timeout the tool may retry
  | 'stale_observation' // effect may exist but our view of the world is stale
  | 'state_changed' // application/window state moved on between steps
  | 'permission_denied'
  | 'invalid_input'
  | 'unsupported_capability'
  | 'tool_unavailable'
  | 'verification_failure' // effect refuted / could not be confirmed
  | 'budget_exhausted'
  | 'cancellation'
  | 'device_not_found' // no device matches the target
  | 'device_disconnected' // the device exists but is offline/reachable only
  | 'device_untrusted' // the target is not a trusted ecosystem device
  | 'device_permission_required' // the device/platform needs explicit permission
  | 'device_unavailable' // device/protocol/transfer could not complete
  | 'fatal' // fatal / unknown

/** Bounded recovery actions the classification policy may return (Phase 2.2). */
export type RecoveryAction = 'retry' | 'reobserve' | 'replan' | 'stop'

/**
 * Structured observation of one tool execution (Phase 1.0). Distinguishes
 * success / failure / partial / informational / verification results so the
 * agent can reason over what actually happened instead of raw strings.
 */
export type ObservationKind =
  | 'success' // tool executed AND its verifier confirmed the effect
  | 'failure' // tool returned failure or threw
  | 'partial' // tool executed but the effect could not be confirmed (unverified)
  | 'informational' // tool executed and no effect needs external confirmation
  | 'verification' // tool executed but its verifier REFUTED the claimed effect

export interface AgentObservation {
  kind: ObservationKind
  toolId: string
  /** Concise, provider-safe summary. */
  summary: string
  /** Structured output the agent/UI can reason over. */
  data?: unknown
  errorKind?: AgentErrorKind
  attempts: number
  durationMs: number
  verification?: AgentVerification
}

/** Outcome of the optional tool-owned verification step (Phase 1.0). */
export type VerificationStatus = 'verified' | 'unverified' | 'not_applicable' | 'failed'

/**
 * Structured operational event recorded on the per-run trace (Phase 2.2).
 * ONLY operational facts — tool ids, step ids, classification kinds, budget
 * numbers, verdict outcomes. NEVER model prompts, reasoning or
 * chain-of-thought.
 */
export type AgentTraceEvent =
  | { type: 'capability_selected'; toolId: string; at: number }
  | { type: 'capability_refused'; toolId: string; reason: string; at: number }
  | { type: 'plan_validated'; ok: boolean; accepted: number; rejected: number; at: number }
  | { type: 'plan_rejected'; toolId: string; reason: string; at: number }
  | { type: 'step_started'; stepId: string; toolId: string; at: number }
  | { type: 'step_failed'; stepId: string; toolId: string; reason: string; at: number }
  | { type: 'step_blocked'; stepId: string; toolId: string; reason: string; at: number }
  | { type: 'recovery_classified'; toolId: string; stepId?: string; kind: RecoveryFailureKind; action: RecoveryAction; at: number; reason?: string }
  | { type: 'recovery_attempted'; attempt: number; limit: number; at: number }
  | { type: 'replan_requested'; at: number }
  | { type: 'replan_accepted'; at: number }
  | { type: 'replan_rejected'; reason: string; at: number }
  | { type: 'repeated_failure_detected'; kind: 'same_action' | 'identical_replan'; repeated: number; at: number }
  | { type: 'verification_attempted'; stepId: string; toolId: string; at: number }
  | { type: 'verification_result'; stepId: string; toolId: string; status: VerificationStatus; at: number }
  | { type: 'capability_requested'; capability: string; at: number }
  | { type: 'capability_resolved'; capability: string; toolId: string; fallback: boolean; at: number }
  | { type: 'capability_rejected'; capability: string; code: string; reason: string; at: number }
  | { type: 'capability_fallback'; capability: string; from: string; to: string; at: number }
  | { type: 'tool_selected'; toolId: string; capability?: string; at: number }
  | { type: 'capability_unavailable'; capability: string; at: number }
  // Phase 2.4 — capability intelligence & personalization events. These carry
  // ONLY id-level/class-level operational facts and deterministic decisions,
  // never scores, ranking numbers, chain-of-thought or execution secrets.
  | { type: 'capability_ranked'; capability: string; toolId: string; ranked: string[]; at: number }
  | { type: 'policy_filtered'; capability: string; toolId: string; reason: string; at: number }
  | { type: 'confirmation_required'; capability: string; toolId: string; at: number }
  | { type: 'confirmation_refused'; capability: string; toolId: string; at: number }
  // Phase 13 — structured-reasoning operational facts. These carry ONLY
  // intents, ids and counts — NEVER the user prompt, the model output or any
  // argument values (which could hold secrets).
  | { type: 'reasoning_requested'; capabilities: number; at: number }
  | { type: 'reasoning_plan_validated'; intent: string; steps: number; at: number }
  | { type: 'reasoning_rejected'; code: string; reason: string; at: number }
  | { type: 'reasoning_unavailable'; reason: string; at: number }
  // Grounded answer synthesis (orchestrator/answerSynthesis). Carries ONLY
  // operational facts — never the model's prose, which is the reply itself.
  | { type: 'synthesis_completed'; chars: number; at: number }
  | { type: 'synthesis_rejected'; reason: string; at: number }
  | { type: 'synthesis_unavailable'; reason: string; at: number }

export interface AgentVerification {
  status: VerificationStatus
  /** Provider-safe reason; empty when not_applicable. */
  message: string
  /** Optional named checks the verifier performed (future UIs/audits). */
  checks?: string[]
  durationMs: number
}

/** One executed step, captured on the per-run execution trace (Phase 1.0). */
export interface TraceStep {
  toolId: string
  /** User-facing label of what ran (tool name). */
  action: string
  arguments: Record<string, unknown>
  status: AgentStepStatus
  observation?: AgentObservation
  verification?: AgentVerification
}

/**
 * Deterministic, internally-held record of one agent run: the goal, the
 * states it passed through, and every executed step with its observation and
 * verification outcome. NEVER pushed to the provider or leaked to the user as
 * raw internal state — surfaced through `engine.lastRunTrace()` for the UI,
 * debuggers and future audit surfaces.
 */
export interface AgentTrace {
  goal: string
  startedAt?: number
  completedAt?: number
  finalState?: AgentState
  steps: TraceStep[]
  /** Phase 2.2 operational events appended while the run progressed. */
  events?: AgentTraceEvent[]
  /** Phase 2.0 evidence-based goal verdict, computed from this trace. */
  task?: GoalTaskResult
}

export interface AgentStepResult {
  /** Concise, safe text fed back to the provider (never a raw exception). */
  message: string
  /** Structured output the AI can reason over. */
  value?: unknown
  /** Root-cause classification when the step did not succeed. */
  errorKind?: AgentErrorKind
  /** Executed attempts (retries included). */
  attempts: number
  durationMs: number
}

export interface AgentStep {
  id: string
  toolId: string
  input: Record<string, unknown>
  status: AgentStepStatus
  dependsOn?: string[]
  /**
   * Phase 2.3 — the capability this step was resolved from, when the plan
   * named a capability instead of a concrete tool (e.g. `open_application`).
   * The step still EXECUTES the concrete resolved tool in `toolId`.
   */
  capability?: string
  /** Phase 2.4 — high-level, UI-safe metadata of the resolved capability:
   * risk class, permission class, verification preference and whether
   * confirmation is required. Engine-computed preview data ONLY — never
   * scores, ranking internals or chain-of-thought. */
  capabilityMeta?: CapabilityPreview
  /**
   * True only when dependencies were declared explicitly (plan `dependsOn` or
   * a programmatic `setDependencies`). The default sequential chain is
   * informational ordering and is NEVER enforced, so a failed step can be
   * retried with different arguments in the same goal run.
   */
  dependenciesExplicit?: boolean
  /** Phase 2.2 human note explaining a skip/recovery decision (UI + audit). */
  note?: string
  requiresConfirmation: boolean
  result?: AgentStepResult
  observation?: AgentObservation
  verification?: AgentVerification
  error?: string
  callId?: string
  startedAt?: number
  completedAt?: number
}

export interface AgentPlan {
  id: string
  goal: string
  status: AgentPlanStatus
  steps: AgentStep[]
  createdAt: number
  completedAt?: number
}

/**
 * Lightweight snapshot for the UI task indicator. Never exposes internal
 * details — just "we are on step N of M doing X".
 */
export interface TaskSnapshot {
  active: boolean
  label: string
  step: number
  total: number
  status: AgentStepStatus | AgentPlanStatus
}