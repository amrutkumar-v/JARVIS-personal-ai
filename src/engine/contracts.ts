import type { JarvisStatus } from '../types'
import type { TaskSnapshot, AgentStepStatus, AgentPlanStatus } from './agent/types'
import type { GoalStepStatus } from './goal/types'
import type { CapabilityPreview } from './capabilities/types'

/**
 * Transcript / UI channel message. Flowing *out* of the engine
 * (from the model, the tools, the memory…) so the UI can react.
 */
export type EngineOutMessage =
  | { type: 'status'; status: JarvisStatus }
  | { type: 'activity'; activity: ActivityOut }
  | { type: 'transcript'; speaker: 'assistant' | 'user'; text: string }
  | { type: 'tool'; toolId: string; status: ToolRunStatus; detail?: string }
  | { type: 'error'; message: string; ids?: string[] }
  | { type: 'notice'; kind: 'info' | 'success' | 'warning' | 'error'; text: string }
  | { type: 'memory'; action: MemoryActivityAction; scope: string }
  | {
      type: 'memory-confirm'
      reason: 'clear_all'
      text: string
      onConfirm: () => Promise<void>
      onCancel: () => void
    }
  | {
      type: 'tool-confirm'
      request: ToolConfirmationRequest
    }
  | { type: 'task'; task: TaskSnapshot }
  | { type: 'capabilities'; capabilities: CapabilityCatalogItem[] }

/** One LIVE registered capability, aired from the engine's single capability
 * registry so the UI can render capability panels from the same source the
 * model addresses (never a UI-side hard-coded copy). */
export interface CapabilityCatalogItem {
  id: string
  name: string
  category: string
  description: string
}

export type MemoryActivityAction =
  | 'saved'
  | 'recalled'
  | 'searched'
  | 'deleted'
  | 'listed'
  | 'cleared'
  | 'archived'

/** Memory-specific confirmation (legacy: clear-all only). */
export interface MemoryConfirmRequest {
  reason: 'clear_all'
  text: string
  onConfirm: () => Promise<void>
  onCancel: () => void
}

/** Why a confirmation is being asked, and what data it touches. */
export interface ToolConfirmationRequest {
  id: string
  /** WHAT: user-facing title of the proposed action. */
  title: string
  /** WHAT: plain-language description of the action. */
  description: string
  /** WHY: the request that triggered it. */
  why: string
  /** WHICH / DATA: tool and data that would be used or changed. */
  toolId: string
  impact: string
  payload?: Record<string, unknown>
  onConfirm: () => Promise<void>
  onCancel: () => void
}

export interface AwaitingConfirmation {
  kind: 'clear_all' | 'tool'
  title: string
  description?: string
  why?: string
  toolId?: string
  impact?: string
  payload?: Record<string, unknown>
  onConfirm: () => Promise<void>
  onCancel: () => void
}

export interface ActivityOut {
  id: string
  step: string
  status: ActivityStatus
  kind: ActivityKind
  detail: string
  startedAt: number
  runId?: string
}

/**
 * Phase 2.1 — UI-safe projection of ONE requested plan step. Exposes only
 * identity, lifecycle state and a safe evidence summary: never the raw
 * arguments/payloads, never chain-of-thought, never internal reasoning.
 */
export interface GoalPlanStepView {
  toolId: string
  /** User-facing tool name (falls back to the tool id). */
  action: string
  status: AgentStepStatus
  /** Real execution attempts (retries included); 0 when never started. */
  attempts: number
  /** Goal-vocabulary step state computed by the ENGINE (classifyPlanStep). */
  state: GoalStepStatus
  /** Concise, provider-safe evidence summary (empty when none yet). */
  evidence: string
  /** Phase 2.2 human note explaining a block/skip/recovery decision. */
  note?: string
  /** Phase 2.3 — the capability this step was resolved from (e.g.
   * `open_application`), when a plan named a capability. The step still
   * executes the concrete resolved tool in `toolId`. */
  capability?: string
  /** Phase 2.4 — high-level, UI-safe preview metadata of the resolved
   * capability (risk class, permission class, verification preference,
   * confirmation requirement). Engine-computed preview ONLY — never scores,
   * ranking internals or chain-of-thought. */
  capabilityMeta?: CapabilityPreview
}

export type GoalPlanStepState = GoalStepStatus

/** Phase 2.2 — bounded recovery counters, mirrored for the UI. Never armed
 * by the model; read-only projection of engine budget state. */
export interface GoalPlanRecoveryView {
  /** Refuted/unverified steps recorded on the current run. */
  verificationFailures: number
  /** Ceiling from the engine's goal limits. */
  maxRecoveryAttempts: number
  /** Recovery continuations requested so far in this run. */
  replans: number
  /** Ceiling from the engine's goal limits. */
  maxReplans: number
  /** True while a replan continuation is being requested / pending. */
  active: boolean
}

/** Phase 2.1 — the engine's current (or last) plan, projected for the UI. */
export interface GoalPlanView {
  active: boolean
  goal: string
  status: AgentPlanStatus
  steps: GoalPlanStepView[]
  /** Phase 2.2 recovery state (present once the run starts). */
  recovery?: GoalPlanRecoveryView
}

export type { JarvisStatus } from '../types'
export type { MemoryItem, MemoryType } from '../memory/MemoryManager'
export type { TaskSnapshot, AgentStepStatus, AgentPlanStatus } from './agent/types'
export type { GoalStepStatus } from './goal/types'
export type { AgentErrorKind } from './agent/types'

export type ActivityKind = 'input' | 'think' | 'tool' | 'output' | 'memory'
export type ActivityStatus = 'pending' | 'running' | 'success' | 'error' | 'rejected'
export type ToolRunStatus = 'running' | 'success' | 'error' | 'rejected'