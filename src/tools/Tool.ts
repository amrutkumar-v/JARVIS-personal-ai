import type { MemoryManager } from '../memory/MemoryManager'
import type { ToolDefinition, ToolInputSchema } from '../engine/provider'

/**
 * Permission tiers for tool execution (Phase 0.2 foundation).
 *
 * - read_only           reads local state only — safe to auto-run.
 * - low_risk            small side effects (notes, settings) — auto-run.
 * - user_confirmation   needs explicit user approval before running.
 * - high_risk           mutates the world — never auto-approved.
 *
 * Phase 0.2 registers only read_only / low_risk tools; the engine refuses
 * anything above unless a confirmation flow exists.
 */
export type ToolPermission = 'read_only' | 'low_risk' | 'user_confirmation' | 'high_risk'

export type ToolCategory = 'info' | 'compute' | 'memory' | 'communication' | 'system' | 'future'

/**
 * Environment/domain a tool targets (Phase 2.2 capability metadata). Used for
 * bounded capability selection — a tool may be registered yet unavailable in
 * the current environment (no camera, no android device). Optional so existing
 * tools stay untouched; defaults are derived from the tool id when absent.
 */
export type ToolContextId =
  | 'desktop'
  | 'app'
  | 'files'
  | 'web'
  | 'memory'
  | 'camera'
  | 'network'
  | 'android'
  | 'generic'

export interface ToolInput {
  /** Original user utterance. */
  query: string
  /** Structured arguments chosen by the AI. */
  params: Record<string, unknown>
}

export interface ToolContext {
  /** Unique id for this execution round. */
  requestId: string
  /** Long-term memory, available to memory tools. */
  memory?: MemoryManager
  /**
   * Run-level cancellation signal (Phase 1.7). Aborted when the user cancels
   * the task or the task hits its safety deadline. Long-running tools SHOULD
   * observe it before every real side effect. Optional so pre-existing tools
   * are unaffected.
   */
  signal?: AbortSignal
}

export interface ToolResult {
  ok: boolean
  /** Human-readable summary — fed back to the AI as the tool result. */
  message: string
  /** Structured value the AI can reason over. */
  data?: unknown
  /** True when execution was blocked by permissions. */
  rejected?: boolean
}

/** Controlled retry policy a tool may declare (never used for safety tiers). */
export interface ToolRetryPolicy {
  /** Whether transient failures may be retried by the engine. */
  retryable: boolean
  /** Max retries on top of the first attempt. */
  maxRetries: number
  /** Base backoff in ms (scaled by attempt count). Defaults to 80ms. */
  backoffMs?: number
  /** Kinds allowed to retry; defaults to tool_failure + timeout. */
  kinds?: Array<'tool_failure' | 'timeout'>
}

/**
 * Optional tool-owned confirmation signal (Phase 1.0 verification system).
 * When a tool declares `verifiable: true`, the engine runs `verify` after each
 * execution and records the outcome; the verification state is fed back to the
 * reasoning loop so a claimed action is never reported as confirmed unless its
 * verifier confirmed it.
 */
export interface ToolVerification {
  /** True when the effect was confirmed (e.g. destination exists). */
  ok: boolean
  /** Provider-safe reason; shown to the model when `ok` is false. */
  message?: string
  /** Optional named checks performed (future audits / UI). */
  checks?: string[]
}

export interface Tool {
  readonly id: string
  readonly category: ToolCategory
  readonly name: string
  readonly description: string
  /** Auto-runs for read_only / low_risk; higher tiers require approval. */
  readonly permission: ToolPermission
  /** JSON-schema-flavoured input contract for the AI. */
  readonly inputSchema: ToolInputSchema
  /** Short description of the structured output the tool returns. */
  readonly outputDescription?: string
  /** Optional wall-clock execution budget for one call (ms). */
  readonly timeoutMs?: number
  /** Optional retry policy; absent means never retried. */
  readonly retry?: ToolRetryPolicy
  /** Legacy flag derived from `permission`. */
  readonly requiresPermission: boolean
  /** True when the tool can confirm its own effects after execution. */
  readonly verifiable?: boolean
  /** Environments/domains this tool targets (Phase 2.2 capability metadata). */
  readonly contexts?: ToolContextId[]
  /** Tool-owned verifier; ignored unless `verifiable` is true. */
  verify?(input: ToolInput, result: ToolResult, ctx: ToolContext): ToolVerification | Promise<ToolVerification>
  canRun(query: string): boolean
  execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult>
}

/** True when a tool needs explicit user confirmation to run. */
export function requiresUserConfirmation(tool: Tool | undefined): boolean {
  if (!tool) return true
  return tool.permission !== 'read_only' && tool.permission !== 'low_risk'
}

/** Build a provider-ready definition (OpenAI `tools` entry). */
export function toToolDefinition(tool: Tool): ToolDefinition {
  return { id: tool.id, description: tool.description, parameters: tool.inputSchema }
}