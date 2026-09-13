/**
 * Phase 13 — the structured reasoning contract.
 *
 * A reasoning provider converts one natural-language request into a SINGLE
 * structured JSON document — the only thing the engine will ever accept from
 * it. That output is ALWAYS untrusted: it must pass `parseAndValidatePlan`
 * before a single capability may be selected, and even then every step runs
 * through the EXISTING execution rails (validatePlan → permission →
 * confirmation → execution → verification). AI output NEVER becomes a shell
 * command or an arbitrary call.
 */

/** The four intents a reasoning provider may declare (plus `reject` when the
 * request is against policy). Anything else fails validation. */
export type ReasoningIntent = 'execute' | 'status' | 'unsupported' | 'clarification' | 'reject'

/** One step inside a structured plan. `capabilityId` MUST be registered. */
export interface ReasoningStep {
  /** A registered capability id (see `ReasoningRequest.capabilities`). */
  capabilityId: string
  /** Arguments validated against the capability's declared schema. */
  arguments: Record<string, unknown>
  /** Optional short human-readable justification (informational only). */
  reason?: string
}

/** The validated structured plan — the ONLY executable output of reasoning. */
export interface StructuredPlan {
  intent: ReasoningIntent
  /** Ordered steps. Empty only for non-executable intents. */
  steps: ReasoningStep[]
  /** Human clarifying question when `intent === 'clarification'`. */
  asking?: string
  /** Human reason when `intent === 'unsupported' | 'reject'`. */
  reason?: string
}

/** Schema of ONE argument a capability accepts (tool-schema mirror). */
export interface ReasoningCapabilityArgument {
  name: string
  type: 'string' | 'number' | 'boolean'
  description?: string
  required: boolean
}

/** The shrink-wrapped capability catalog handed to the model — and nothing
 * else. Only capabilities that can ACTUALLY resolve to a registered tool are
 * advertised, so the model can never select something that cannot run. */
export interface ReasoningCapabilityDescriptor {
  id: string
  name: string
  description: string
  arguments: ReasoningCapabilityArgument[]
  requiresConfirmation: boolean
  readOnly: boolean
}

/** Everything the reasoning provider needs; nothing it could abuse. */
export interface ReasoningRequest {
  /** Verbatim natural-language request. */
  text: string
  /** ONLY capabilities registered in the engine right now. */
  capabilities: ReasoningCapabilityDescriptor[]
  /** Static security rules the model must obey (never optional). */
  constraints: string
}

/** Bounded reasoning-plan limits (aligned with the orchestrator's own caps). */
export const REASONING_PLAN_LIMITS = {
  /** Matches `ORCHESTRATION_PLAN_LIMITS.maxSteps`. */
  maxSteps: 4,
  /** Upper bound on arguments per step. */
  maxArgumentKeys: 16,
  /** Upper bound on one plan() call (the engine also owns a watchdog). */
  planDeadlineMs: 45_000,
} as const