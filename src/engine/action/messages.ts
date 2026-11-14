import { executionErrorPhrase } from './errors'
import type { ActionKind, ExecutionErrorKind } from './types'
import type { ToolMatch } from './registry'

/**
 * Phase 2.6 — user-facing phrasing for the deterministic action layer.
 * Every string here is honest, bounded and provider-safe: no raw exceptions,
 * no chain-of-thought, no claims about actions that did not run.
 */

export const DOMAIN_LABELS: Record<string, string> = {
  files: 'file & folder operations',
  memory: 'memory and notes',
  system: 'system information',
  apps: 'application control',
  communication: 'messaging and calls',
  media: 'media playback',
  device: 'device settings',
}

/**
 * Honest reply for a request whose domain has no connected registered
 * mechanism. It MUST NOT pretend anything ran — it explains the capability is
 * not connected and points at what IS available.
 */
export function unsupportedMessage(domain: string | undefined): string {
  const what = domain ? DOMAIN_LABELS[domain] ?? `"${domain}"` : 'that'
  return `I can't do that — ${what} isn't connected in this environment, so I won't pretend it worked. Ask me for a calculation, the time, my notes, or file and folder operations, and I'll act on those for real.`
}

/**
 * Honest clarification when a state-changing request is ambiguous
 * ("delete that file" with no resolvable reference).
 */
export function clarificationMessage(text: string, candidates?: string[]): string {
  const head = `I didn't act because your request was ambiguous: "${text.slice(0, 120)}".`
  if (candidates && candidates.length > 0) {
    const list = candidates.slice(0, 6).map((c) => `- ${c}`).join('\n')
    return `${head}\nWhich one did you mean?\n${list}`
  }
  return `${head} Which file or item did you mean? Which specific file or item would you like me to target?`
}

/**
 * Deterministic engine-derived planning hint injected into the model context.
 * Names the registered mechanisms the engine already matched so a real
 * provider reliably calls them. Informational only — never a directive that
 * skips the rails.
 */
export function actionHintMessage(matchedTools: ToolMatch[], matchedCapabilities: string[]): string | null {
  const tools = matchedTools.map((m) => m.toolId)
  const parts: string[] = []
  if (tools.length > 0) parts.push(`tool(s): ${tools.join(', ')}`)
  if (matchedCapabilities.length > 0) parts.push(`capability(ies): ${matchedCapabilities.join(', ')}`)
  if (parts.length === 0) return null
  return `The engine already matched possible mechanisms for this request — ${parts.join('; ')}. If the request is a concrete action, prefer calling one of those through the normal tool/capability flow.`
}

/** Short user-safe label for an execution error (used in notices). */
export function executionErrorLabel(kind: ExecutionErrorKind): string {
  return executionErrorPhrase(kind)
}

/** Short busy-path label for an ActionKind (mostly diagnostic/UI). */
export function actionKindLabel(kind: ActionKind): string {
  switch (kind) {
    case 'informational':
      return 'Answered'
    case 'executable':
      return 'Executing'
    case 'multi_step':
      return 'Running steps'
    case 'ambiguous':
      return 'Clarifying'
    case 'unsupported':
      return 'Unavailable'
    case 'follow_up':
      return 'Following up'
    default:
      return 'Processing'
  }
}