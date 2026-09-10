import type { MemoryItem, MemorySource, MemoryType } from './MemoryManager'

/**
 * Deterministic heuristics used when the user provides a durable fact without
 * an explicit "remember / preference" label, and to keep secrets OUT of
 * persistent memory.
 *
 * This is NOT AI classification — it is a small, honest rule layer. The real
 * LLM (via the memory tool) is still the primary classifier; these helpers
 * just give structured defaults and a safety net.
 */

/** Empties / obvious robot text should never be persisted. */
export function isMemorableInput(text: string): boolean {
  const clean = (text ?? '').trim()
  if (!clean) return false
  if (clean.length < 3) return false
  // Reject pure command articulation that carries no durable fact.
  if (/^(remember|recall|forget|search|list|clear)\b/i.test(clean) && clean.split(/\s+/).length < 4) {
    return false
  }
  return true
}

/** Anything that looks like a credential must be rejected. */
export function looksLikeCredential(text: string): boolean {
  const low = text.toLowerCase()
  const markers =
    /\b(password|passwd|pwd|api[ _-]?key|secret|token|authorization|bearer|client[ _-]?secret|private[ _-]?key|connection[ _-]?string)\b/i
  if (markers.test(low)) return true
  // 32+ char high-entropy base64-ish blob next to a "key" style word.
  if (/[A-Za-z0-9+/]{20,}={0,2}/.test(text)) return true
  return false
}

const MEMORY_COMMANDS = /\b(remember|recall|remembered|recalled|forget|forgot|search|list|clear)\b/i

/**
 * True when the user is explicitly talking TO the memory system ("remember X",
 * "recall Y", "list memories", "forget that", …) rather than stating a fact in
 * passing. Used by the auto-capture safety net to avoid double-writing what a
 * memory command already handles explicitly.
 */
export function isExplicitMemoryCommand(text: string): boolean {
  const clean = (text ?? '').trim()
  return MEMORY_COMMANDS.test(clean)
}

/** True for obvious questions (trailing '?' or a question starter word). */
export function looksLikeQuestion(text: string): boolean {
  const clean = (text ?? '').trim()
  if (!clean) return false
  if (/\?\s*$/.test(clean)) return true
  return /^(what|what's|whats|who|who's|whos|whom|whose|when|where|why|how|does|do|did|is|am|are|can|could|would|should|shall|will|may|might|have|has|had)\b/i.test(
    clean,
  )
}

/**
 * Deterministic auto-capture predicate (Phase 0.7 safety net). A raw user
 * utterance is auto-remembered ONLY when every guard passes:
 * - not an explicit memory command (those are already handled by the tool),
 * - not a question,
 * - a durable personal fact (durable + not credential + basic sanity),
 * - free of credential-like content.
 */
export function shouldAutoCapture(text: string): boolean {
  if (isExplicitMemoryCommand(text)) return false
  if (looksLikeQuestion(text)) return false
  if (!isDurableFact(text)) return false
  return !looksLikeCredential(text)
}

const PROFILE_PATTERNS: RegExp[] = [
  /\bmy name is\b/i,
  /\bi am called\b/i,
  /\bi go by\b/i,
  /\bcall me\b/i,
  /\bmy full name\b/i,
  /\bname:\s*[A-Za-z]/i,
]

const PREFERENCE_PATTERNS: RegExp[] = [
  /\bi (prefer|like|love|enjoy|favorite|favourite)\b/i,
  /\bmy favorite\b/i,
  /\bi prefer (to )?/i,
  /\bprefer concise\b/i,
  /\bprefer (long|short|detailed|concise|verbose)/i,
  /\bmy (favourite|favorite)\b/i,
]

const FACT_PATTERNS: RegExp[] = [
  /\bi (am|work on|work at|stud(y|ying) at|live in|use|play|code in|write)\b/i,
  /\bmy (project|job|role|team|company|school|major|city|country|hometown|birthday)\b/i,
  /\bi have been\b/i,
  /\bi started\b/i,
  /\btoday is my\b/i,
]

/** Classify a durable fact into a memory type using simple, obvious cues. */
export function detectMemoryType(content: string): MemoryType {
  const c = (content ?? '').trim()
  if (!c) return 'FACT'
  if (PROFILE_PATTERNS.some((re) => re.test(c))) return 'PROFILE'
  if (PREFERENCE_PATTERNS.some((re) => re.test(c))) return 'PREFERENCE'
  if (FACT_PATTERNS.some((re) => re.test(c))) return 'FACT'
  return 'FACT'
}

/** Decides whether a piece of text is a durable fact worth saving. */
export function isDurableFact(content: string): boolean {
  const c = (content ?? '').trim()
  if (!isMemorableInput(c)) return false
  if (looksLikeCredential(c)) return false
  // Explicit remember / preference signals are always durable.
  if (/\bremember\b/i.test(c)) return true
  if (detectMemoryType(c) !== 'FACT') return true
  // Bare facts still need at least one strong personal cue to be considered
  // "obviously useful" rather than transient small talk.
  return /\bmy\b|\bi am\b|\bi prefer\b|\bi work|\bi study|\bi live|\bi use\b/i.test(c)
}

export function detectSource(content: string): MemorySource {
  if (/\bremember\b/i.test(content)) return 'user'
  return 'user'
}

/** Normalize a durable fact caught mid-sentence, e.g. "remember that X". */
export function normalizeFact(content: string): string {
  return (content ?? '')
    .trim()
    .replace(/^(please\s+)?remember\s+(that\s+)?/i, '')
    .replace(/^please\s+/, '')
    .trim()
}

/** Convenience: build a fully-formed draft item for a remembered fact. */
export function classifyFact(content: string): Pick<MemoryItem, 'type' | 'importance' | 'source' | 'content'> {
  const clean = normalizeFact(content)
  return {
    content: clean,
    type: detectMemoryType(clean),
    importance: lookUpImportance(clean),
    source: detectSource(content),
  }
}

/** Slight importance bump for profile/preference, which matter more. */
function lookUpImportance(clean: string): number {
  if (PROFILE_PATTERNS.some((re) => re.test(clean))) return 0.8
  if (PREFERENCE_PATTERNS.some((re) => re.test(clean))) return 0.7
  return 0.5
}
