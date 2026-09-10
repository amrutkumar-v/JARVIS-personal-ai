import type { ToolPermission } from '../../tools/Tool'

/**
 * Phase 2.6 — Real action execution: pure contracts for the deterministic
 * action layer.
 *
 * The engine already owns the real execution pipeline (typed tools, registry,
 * permission gates, budgets, verification, recovery, cancellation, traces).
 * This module adds the deterministic layer ON TOP of it — it never executes
 * anything and never grants permission. It ONLY decides how a request should
 * be routed and keeps a bounded, conversation-scoped record of what actually
 * happened, so follow-ups resolve against real history instead of guesses.
 *
 * Every contract here is pure data + deterministic policy. The action layer
 * must never:
 *   - execute a tool, reach a provider, or fabricate results;
 *   - read or write storage, do I/O, or log raw inputs/secrets;
 *   - override the tool permission / confirmation / verification rails.
 */

/**
 * Structured execution error vocabulary (§18 of the Phase 2.6 brief).
 * `unsupported` means the capability genuinely is not connected here; the
 * other kinds map onto failures the execution pipeline already classifies.
 */
export type ExecutionErrorKind =
  | 'invalid_input'
  | 'tool_unavailable'
  | 'permission_denied'
  | 'target_not_found'
  | 'execution_failure'
  | 'timeout'
  | 'verification_failure'
  | 'cancelled'
  | 'unsupported'

/**
 * How the deterministic action layer classified ONE request before the
 * provider/execution rails were (or were not) involved.
 */
export type ActionKind =
  /** A question or a request with no matched registered mechanism. */
  | 'informational'
  /** A request a registered tool's `canRun` understood (or a real action). */
  | 'executable'
  /** Could be a follow-on step to an earlier request. */
  | 'multi_step'
  /** The request was a deictic/underspecified action that must be clarified. */
  | 'ambiguous'
  /** An imperative action whose domain has NO registered tool or capability. */
  | 'unsupported'
  /** The request was resolved against the previous execution context. */
  | 'follow_up'

/**
 * Terminal result of a run for the execution record. Deliberately small and
 * evidence-based — mirrors the goal-vocabulary verdicts so the record never
 * over-claims.
 */
export type ExecutionOutcome =
  | 'completed'
  | 'partial'
  | 'cancelled'
  | 'failed'
  | 'unverified'
  | 'refused'
  | 'clarified'
  | 'info_answer'

/**
 * A bounded, user-safe trace of one executed thing the user can later point at
 * ("that file", "the PDF", "the result"). Contains identity + a short summary
 * only; never raw payloads, screenshots or chain-of-thought.
 */
export interface ExecutionArtifact {
  id: string
  kind: 'file' | 'result' | 'target'
  label: string
  /** Absolute/relative path when the artifact has one (file-kind only). */
  path?: string
  /** Provider-safe, one-line summary. */
  summary: string
}

/** One execution-time error worth remembering for honest follow-ups. */
export interface ExecutionErrorEntry {
  kind: ExecutionErrorKind
  toolId?: string
  message: string
  at: number
}

/**
 * The per-run execution context (§13 of the Phase 2.6 brief): bounded,
 * conversation-scoped, and populated ONLY from engine-owned facts. It is what
 * makes follow-ups ("do it", "now open the PDF") resolve against what really
 * happened — never against guesses or stale references.
 */
export interface ExecutionContext {
  runId: string
  requestId: string
  executionId: string
  conversationId?: string
  requestedAt: number
  /** The user's original request text. */
  requestText: string
  /** The request text after deterministic follow-up resolution, if any. */
  resolvedText?: string
  actionKind: ActionKind
  /** Tool ids a registered tool's `canRun` matched (engine-selected hints). */
  matchedTools: string[]
  /** Capability ids whose description matched the request domain. */
  matchedCapabilities: string[]
  /** Executed-tool artifacts captured for later deictic resolution. */
  artifacts: ExecutionArtifact[]
  executedSteps: number
  verifiedSteps: number
  refutedSteps: number
  unverifiedSteps: number
  errors: ExecutionErrorEntry[]
  outcome: ExecutionOutcome
  /** The engine run-state terminal value this context ended at. */
  terminalStatus: string
}

/** Minimal structural view of a registered tool used by the action layer. */
export interface ActionToolView {
  id: string
  label: string
  permission: ToolPermission
  canRun(query: string): boolean
}

/** Minimal structural view of a registered capability used by the action layer. */
export interface ActionCapabilityView {
  id: string
  label: string
  description: string
  /**
   * Concrete registered tool ids this capability resolves to (in preference
   * order). A capability is only "backed" when at least one of these is
   * actually registered in the engine's tool registry.
   */
  toolIds: string[]
}

/** Read-only projection of everything the action layer may consult. */
export interface ActionRegistryView {
  tools: ActionToolView[]
  capabilities: ActionCapabilityView[]
}