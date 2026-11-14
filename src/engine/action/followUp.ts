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
  | { kind: 'retry_last'; requestText: string }
  | { kind: 'explain_last'; targetContext: ExecutionContext }
  | { kind: 'save_last'; artifact?: ExecutionArtifact; text: string }
  | { kind: 'candidate_select'; index: number; candidateText?: string }
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

const RETRY_PATTERNS = [
  /^(?:please\s+)?(?:retry|try\s+again|run\s+it\s+again|redo\s+(?:that|it)|do\s+it\s+again)[.!]?$/i,
]

const EXPLAIN_PATTERNS = [
  /^(?:why\s+did\s+you\s+do\s+that|explain\s+(?:what\s+you\s+(?:just\s+)?did|your\s+reasoning|the\s+result|that)|how\s+did\s+you\s+do\s+that|what\s+happened(?:\s+there)?)\??$/i,
]

const SAVE_PATTERNS = [
  /^(?:please\s+)?save\s+(?:that|this|it|the\s+result|the\s+output|to\s+a\s+file)\b/i,
]

const ORDINAL_MAP: Record<string, number> = {
  first: 0,
  '1st': 0,
  '1': 0,
  second: 1,
  '2nd': 1,
  '2': 1,
  third: 2,
  '3rd': 2,
  '3': 2,
  fourth: 3,
  '4th': 3,
  '4': 3,
  fifth: 4,
  '5th': 4,
  '5': 4,
}

function parseCandidateIndex(text: string): number | null {
  const match = text.match(
    /\b(?:option\s+(\d+)|candidate\s+(\d+)|(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(?:option|one|candidate)|(?:pick|choose|select)\s+(?:the\s+)?(\d+)(?:st|nd|rd|th)?)\b/i
  )
  if (!match) {
    if (/\b(?:what\s+about\s+(?:the\s+)?(?:second|first|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+option)\b/i.test(text)) {
      const ord = text.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b/i)
      if (ord && ord[1].toLowerCase() in ORDINAL_MAP) {
        return ORDINAL_MAP[ord[1].toLowerCase()]
      }
    }
    return null
  }
  const numStr = match[1] || match[2] || match[4]
  if (numStr) {
    const val = parseInt(numStr, 10)
    return isNaN(val) ? null : val - 1
  }
  const ordStr = (match[3] || '').toLowerCase()
  return ordStr in ORDINAL_MAP ? ORDINAL_MAP[ordStr] : null
}

/**
 * Resolve a follow-up request against the last execution context.
 * - Pure confirmatives replay the last request when it is unambiguous and
 *   fresh; otherwise they ask what the user means.
 * - Retry requests replay the previous request directly.
 * - Explain requests provide diagnostic/reasoning insights into the last action.
 * - Save requests preserve the result or primary artifact of the last action.
 * - Candidate indexing ("option 2", "the second one") resolves to that candidate.
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

  // 1. Retry last command
  if (RETRY_PATTERNS.some((p) => p.test(t))) {
    if (stale) return { kind: 'ask_what' }
    return { kind: 'retry_last', requestText: last.resolvedText || last.requestText }
  }

  // 2. Explain last action
  if (EXPLAIN_PATTERNS.some((p) => p.test(t))) {
    if (stale) return { kind: 'ask_what' }
    return { kind: 'explain_last', targetContext: last }
  }

  // 3. Save last output/artifact
  if (SAVE_PATTERNS.some((p) => p.test(t))) {
    if (stale) return { kind: 'ask_what' }
    return { kind: 'save_last', artifact: last.artifacts[0], text: t }
  }

  // 4. Candidate indexing ("What about the second option?", "choose option 2")
  const candidateIdx = parseCandidateIndex(t)
  if (candidateIdx !== null) {
    if (stale) return { kind: 'ask_what' }
    const candidateText = last.artifacts[candidateIdx]?.path ?? last.artifacts[candidateIdx]?.label
    return { kind: 'candidate_select', index: candidateIdx, candidateText }
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