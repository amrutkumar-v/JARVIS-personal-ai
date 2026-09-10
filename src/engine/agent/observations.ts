import type { ToolExecutionResult } from './runTool'
import type { AgentObservation, AgentVerification } from './types'

/**
 * Observation model (Phase 1.0).
 *
 * Every tool execution on the agent loop is classified into a structured
 * observation: success / failure / partial / informational / verification.
 * Classification is deterministic and derives from the execution result plus
 * (when present) the tool-owned verification outcome:
 *
 *   - failure passed       → 'failure'           (never pretend success)
 *   - success + verified   → 'success'
 *   - success + unverified → 'partial'           (effect not confirmed)
 *   - success + failed     → 'verification'      (verifier REFUTED the effect)
 *   - success + no verify  → 'informational'     (nothing external to confirm)
 */

/**
 * Classify one tool execution into a structured observation.
 * @param result  execution result produced by `runToolOnce` / the retry loop
 * @param verification optional outcome of the tool's verifier (run by the engine)
 */
export function classifyObservation(
  result: ToolExecutionResult,
  verification?: AgentVerification,
): AgentObservation {
  if (!result.success) {
    return {
      kind: 'failure',
      toolId: result.toolId,
      summary: result.summary,
      data: result.output,
      errorKind: result.errorKind,
      attempts: result.attempts,
      durationMs: result.durationMs,
      verification,
    }
  }

  if (verification?.status === 'verified') {
    return {
      kind: 'success',
      toolId: result.toolId,
      summary: result.summary,
      data: result.output,
      attempts: result.attempts,
      durationMs: result.durationMs,
      verification,
    }
  }

  if (verification?.status === 'failed') {
    return {
      kind: 'verification',
      toolId: result.toolId,
      summary: `Executed but not confirmed: ${verification.message}`,
      data: result.output,
      errorKind: 'tool_failure',
      attempts: result.attempts,
      durationMs: result.durationMs,
      verification,
    }
  }

  if (verification?.status === 'unverified') {
    return {
      kind: 'partial',
      toolId: result.toolId,
      summary: `Executed, unverified: ${verification.message}`,
      data: result.output,
      attempts: result.attempts,
      durationMs: result.durationMs,
      verification,
    }
  }

  return {
    kind: 'informational',
    toolId: result.toolId,
    summary: result.summary,
    data: result.output,
    attempts: result.attempts,
    durationMs: result.durationMs,
  }
}