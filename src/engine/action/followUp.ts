import type { ExecutionArtifact, ExecutionContext } from './types'
import { EXECUTION_CONTEXT_TTL_MS } from './executionContext'
import { hasExplicitTarget, hasLocative } from './classifier'

/**
 * Phase 2.6 — conversational follow-up resolution (§14).
 *
 * Turns deictic follow-ups ("do it", "now open the PDF", "that file") into a
 * request that can be re-routed safely. Resolution happens ONLY against the
 * last committed execution context; anything ambiguous (or with no recent
 * context) is escalated to a clarification instead of guessed. Stale context
 * is never used.
 */

export type FollowUpResolution =
  | { kind: 'none' }
  | { kind: 'replay'; requestText: string }
  | { kind: 'augment'; text: string }
  | { kind: 'ask_which'; candidates: string[] }
  | { kind: 'ask_what' }

const CONFIRM_SINGLE = new Set([
  'yes', 'yep', 'yeah', 'yup', 'sure', 'ok', 'okay', 'proceed', 'start', 'begin',
  'go ahead', 'do it', 'do that', 'yes do it', 'yes please', 'please do', 'confirm',
  'execute', 'run it', "let's do it", 'lets do it', 'okay do it', 'ok do it',
  'now do it', 'go', 'go on', 'continue', 'right', 'alright', 'yep do it', 'sure do it',
])

const CONFIRM_CORE = new Set([
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'proceed', 'start', 'begin',
  'continue', 'go', 'do it', 'do that', 'go ahead', 'run it', 'go on',
])

const FILLER = new Set(['please', 'pls', 'then', 'already', 'now', 'right', 'ok', 'okay', 'yes', 'yeah'])

/** Pure confirmatives: "yes", "do it", "go ahead", "ok do it now please". */
export function isPureConfirm(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  const lower = t.toLowerCase().replace(/[.,!?]+$/g, '').trim()
  if (CONFIRM_SINGLE.has(lower)) return true
  const tokens = lower.split(/\s+/).filter(Boolean)
  if (tokens.length === 0 || tokens.length > 5) return false
  while (tokens.length > 0 && FILLER.has(tokens[0])) tokens.shift()
  while (tokens.length > 0 && FILLER.has(tokens[tokens.length - 1])) tokens.pop()
  return CONFIRM_CORE.has(tokens.join(' '))
}

const ACTION_VERBS = [
  'open', 'show', 'read', 'list', 'rename', 'move', 'copy', 'delete', 'remove',
  'close', 'use', 'select', 'send', 'view', 'display', 'preview', 'run', 'edit',
  'play', 'investigate', 'analyze', 'examine', 'search', 'find', 'reveal',
]

const ENTITY_HINTS: ReadonlyArray<{ key: string; pattern: RegExp; extensions: string[] }> = [
  { key: 'pdf', pattern: /\b(pdf|document|docs?)\b/i, extensions: ['.pdf'] },
  { key: 'text', pattern: /\b(text file|txt)\b/i, extensions: ['.txt', '.md'] },
  { key: 'image', pattern: /\b(image|picture|photo|screenshot|png|jpe?g)\b/i, extensions: ['.png', '.jpg', '.jpeg', '.webp', '.bmp'] },
  { key: 'spreadsheet', pattern: /\b(spreadsheet|sheet|csv|excel|xls)\b/i, extensions: ['.csv', '.xlsx', '.xls'] },
  { key: 'archive', pattern: /\b(archive|zip|compressed)\b/i, extensions: ['.zip', '.7z', '.tar', '.gz'] },
  { key: 'media', pattern: /\b(audio|music|song|video|movie|mp3|mp4)\b/i, extensions: ['.mp3', '.mp4', '.wav', '.mov'] },
  { key: 'file', pattern: /\b(file)\b/i, extensions: [] },
  { key: 'folder', pattern: /\b(folder|dir|directory)\b/i, extensions: [] },
]

function resolveArtifactCandidates(
  last: ExecutionContext,
  text: string,
): ExecutionArtifact[] {
  const hint = ENTITY_HINTS.find((h) => h.pattern.test(text))
  const files = last.artifacts.filter((a) => a.kind === 'file')
  if (!hint) {
    return files.slice(-3)
  }
  return files
    .filter((a) => {
      const path = (a.path ?? a.label).toLowerCase()
      if (hint.extensions.length === 0) return true
      return hint.extensions.some((ext) => path.endsWith(ext) || path.includes(hint.key))
    })
    .slice(-3)
}

/** Deictic-entity follow-up: "now open the PDF", "move that file to Desktop". */
function isDeicticEntityReference(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t || hasExplicitTarget(t) || hasLocative(t)) return false
  const verb = ACTION_VERBS.find((v) => new RegExp(`\\b${v}\\b`, 'i').test(t))
  if (!verb) return false
  if (DEICTIC_PRONOUN.test(t)) return true
  return /\b(?:the|that|this|a|an)\s+(?:pdf|document|docs?|file|text file|image|picture|photo|png|jpe?g|screenshot|folder|dir|directory|zip|mp3|mp4)\b/i.test(t)
}

const DEICTIC_PRONOUN = /\b(?:it|this|that|them|those|these)\b/i

/**
 * Resolve a follow-up request against the last execution context.
 * - Pure confirmatives replay the last request when it is unambiguous and
 *   fresh; otherwise they ask what the user means.
 * - Deictic refs to a file are resolved to a concrete path when there is
 *   exactly one candidate; multiple candidates ask which one.
 * - Anything unresolvable or without fresh context asks for clarification.
 * NEVER uses stale context (older than EXECUTION_CONTEXT_TTL_MS).
 */
export function resolveFollowUp(
  text: string,
  last: ExecutionContext | undefined,
  now?: number,
): FollowUpResolution {
  const t = (text ?? '').trim()
  if (!t) return { kind: 'none' }
  const at = now ?? Date.now()
  const stale = !last || at - last.requestedAt > EXECUTION_CONTEXT_TTL_MS

  if (isPureConfirm(t)) {
    if (stale) return { kind: 'ask_what' }
    if (last.resolvedText) return { kind: 'replay', requestText: last.resolvedText }
    return { kind: 'replay', requestText: last.requestText }
  }

  if (isDeicticEntityReference(t)) {
    // A deictic reference is only a FOLLOW-UP when something ran before it.
    // With no prior execution context it is a fresh request — route it
    // normally (the provider and/or the risky-deictic guard handle it).
    if (!last) return { kind: 'none' }
    if (stale) return { kind: 'ask_what' }
    const candidates = resolveArtifactCandidates(last, t)
    if (candidates.length === 0) {
      return { kind: 'ask_what' }
    }
    if (candidates.length === 1) {
      const target = candidates[0].path ?? candidates[0].label
      return { kind: 'augment', text: `${t} (target: "${target}")` }
    }
    return { kind: 'ask_which', candidates: candidates.map((c) => c.label) }
  }

  return { kind: 'none' }
}