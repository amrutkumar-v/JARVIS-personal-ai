import type { Tool, ToolContext, ToolInput } from '../../tools/Tool'
import { clipText } from '../../utils/text'
import type { AgentErrorKind } from './types'

/**
 * Standardized tool execution result.
 *
 * `summary` is the ONLY field fed back to the provider — always concise and
 * safe (never a raw exception). `output` holds structured data for the plan /
 * UI; `errorKind` classifies the failure so the agent can decide next steps.
 */
export interface ToolExecutionResult {
  success: boolean
  toolId: string
  /** Concise, provider-safe summary. */
  summary: string
  /** Structured output (data) the AI/UI can reason over. */
  output: unknown
  error?: string
  errorKind?: AgentErrorKind
  durationMs: number
  attempts: number
}

/** Typed execution failure (thrown by the runner or classification layer). */
export class ToolExecutionError extends Error {
  readonly kind: AgentErrorKind
  constructor(kind: AgentErrorKind, message: string) {
    super(message)
    this.name = 'ToolExecutionError'
    this.kind = kind
  }
}

/** Summary length cap so provider context never grows without bound. */
export const TOOL_SUMMARY_LIMIT = 1200

/** Build a safe, bounded summary from a raw execution result. */
export function summarizeToolResult(result: ToolExecutionResult): string {
  if (result.success) {
    return clipText(`${result.toolId}: ${result.summary}`, TOOL_SUMMARY_LIMIT)
  }
  const kind = result.errorKind ? ` (${result.errorKind})` : ''
  return clipText(`${result.toolId} failed${kind}: ${result.summary}`, TOOL_SUMMARY_LIMIT)
}

/**
 * Execute one tool call exactly once, with an optional wall-clock timeout.
 *
 * Retries are deliberately NOT handled here — the engine decides retries
 * through the retry policy so permission/invalid/cancelled failures are
 * never re-tried automatically.
 */
export async function runToolOnce(
  tool: Tool,
  input: ToolInput,
  ctx: ToolContext,
  timeoutMs?: number,
): Promise<ToolExecutionResult> {
  const startedAt = Date.now()
  try {
    if (timeoutMs && timeoutMs > 0) {
      const result = await withTimeout(tool, input, ctx, timeoutMs)
      return finalize(tool.id, result, startedAt)
    }
    const result = await tool.execute(input, ctx)
    return finalize(tool.id, result, startedAt)
  } catch (error) {
    const kind = error instanceof ToolExecutionError ? error.kind : 'tool_failure'
    const message = error instanceof Error ? error.message : 'Unknown tool failure.'
    const durationMs = Date.now() - startedAt
    return {
      success: false,
      toolId: tool.id,
      summary: message,
      output: undefined,
      error: message,
      errorKind: kind,
      durationMs,
      attempts: 1,
    }
  }
}

async function withTimeout(
  tool: Tool,
  input: ToolInput,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<{ ok: boolean; message: string; data?: unknown; rejected?: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Absorb a tool that settles after the timeout has already fired, so its
    // late rejection can never surface as an unhandled promise rejection.
    const execution = tool.execute(input, ctx)
    execution.catch(() => {})
    return await Promise.race([
      execution,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ToolExecutionError('timeout', `Timed out after ${timeoutMs}ms.`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function finalize(
  toolId: string,
  result: { ok: boolean; message: string; data?: unknown; rejected?: boolean },
  startedAt: number,
): ToolExecutionResult {
  const durationMs = Date.now() - startedAt
  if (result.ok) {
    return {
      success: true,
      toolId,
      summary: result.message || `${toolId} completed`,
      output: result.data ?? null,
      durationMs,
      attempts: 1,
    }
  }
  const kind: AgentErrorKind = result.rejected ? 'permission_denied' : 'tool_failure'
  return {
    success: false,
    toolId,
    summary: result.message || `${toolId} failed`,
    output: result.data ?? null,
    error: result.message,
    errorKind: kind,
    durationMs,
    attempts: 1,
  }
}