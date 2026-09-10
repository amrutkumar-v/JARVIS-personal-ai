import type { Tool, ToolPermission } from '../../tools/Tool'
import { clipText } from '../../utils/text'
import type { AgentErrorKind } from './types'

/**
 * Permission enforcement for tool calls.
 *
 *   read_only          → auto-run (no side effects)
 *   low_risk           → auto-run (small, reversible side effects)
 *   user_confirmation  → pause and request explicit approval
 *   high_risk          → refused unless an explicit future policy covers it
 *
 * The memory clear-all gate is layered ON TOP of this as an extra safety
 * rail — this module only decides whether a normal tool call may proceed.
 */

export type PermissionDecision =
  | { kind: 'auto' }
  | { kind: 'confirm'; reason: string; why: string; impact: string }
  | { kind: 'denied'; reason: string }

/** Whether a permission level should block high-risk side effects forever. */
export function isReader(permission: ToolPermission): boolean {
  return permission === 'read_only' || permission === 'low_risk'
}

/**
 * Decide how the engine must treat a requested tool call.
 * `toolId` is used only to guard against undefined lookups.
 */
export function decidePermission(
  tool: Tool | undefined,
  userText: string,
  params: Record<string, unknown>,
): PermissionDecision {
  if (!tool) {
    return { kind: 'denied', reason: 'That tool is not available.' }
  }
  if (isReader(tool.permission)) return { kind: 'auto' }

  if (tool.permission === 'user_confirmation') {
    const data = summarizeParams(params)
    return {
      kind: 'confirm',
      reason: `Run ${tool.name}?`,
      why: `You asked: "${clipText(userText, 120)}"`,
      impact:
        data.length > 0
          ? `This will call "${tool.id}" with: ${data}`
          : `This will call "${tool.id}" without arguments.`,
    }
  }

  // high_risk and any future level above the safe reader tier.
  return {
    kind: 'denied',
    reason: `${tool.name} requires approval that is not available yet.`,
  }
}

/** Safe, single-line description of the params the AI wants to use. */
export function summarizeParams(params: Record<string, unknown>): string {
  try {
    const parts = Object.entries(params ?? {})
      .slice(0, 4)
      .map(([k, v]) => {
        if (typeof v === 'string') {
          return `${k}=${clipText(v, 60)}`
        }
        if (typeof v === 'number' || typeof v === 'boolean') return `${k}=${String(v)}`
        return `${k}=<${typeof v}>`
      })
    return parts.join(', ')
  } catch {
    return ''
  }
}

/** Error-kind mapping for failed user answers / refusals. */
export function errorForDecision(decision: PermissionDecision): AgentErrorKind {
  return decision.kind === 'confirm' ? 'user_cancelled' : 'permission_denied'
}