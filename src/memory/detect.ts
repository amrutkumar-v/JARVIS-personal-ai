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

/**
 * HIGH-CONFIDENCE credential detector, enforced at the memory WRITE BOUNDARY.
 *
 * `looksLikeCredential` is intentionally broad (it powers the auto-capture
 * safety net and the memory tool), so a false positive only means "don't
 * auto-remember this sentence". At `MemoryManager.remember/update` we must
 * NEVER reject a legitimately remembered sentence, so only unambiguous
 * credential phrasing counts — generic prose uses of "secret"/"token" (e.g.
 * "kept secret", "token ring") remain storable, while anything carrying an
 * actual password/api-key/bearer/otp/private-key/connection-string marker or
 * a high-entropy blob is refused.
 */
export function looksLikeHighRiskCredential(text: string): boolean {
  const low = text.toLowerCase()
  const markers =
    /\b(password|passwd|pwd|api[ _-]?key|api-key|authorization|bearer|client[ _-]?secret|private[ _-]?key|connection[ _-]?string|otp|one[- ]?time[ -]?passcode|2fa|two[- ]?factor)\b/i
  if (markers.test(low)) return true
  // 20+ char base64-ish blob in the same string as a key-like word.
  if (/[A-Za-z0-9+/]{20,}={0,2}/.test(low) && /\b(key|token|secret|pass)\b/i.test(low)) return true
  // A bearer/authorization prefix is never prose.
  if (/^bearer\s+/i.test(low) || /^authorization\s*:/i.test(low)) return true
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

const PROJECT_DECISION_PATTERNS: RegExp[] = [
  /\b(?:architecture\s+decision|we\s+decided\s+to|decision\s+is\s+to|chose\s+to\s+use|standardized\s+on|convention\s+is|tech\s+stack\s+is)\b/i,
  /\b(?:we\s+use|we\s+chose|decision:)\b/i,
]

const WORKFLOW_PATTERNS: RegExp[] = [
  /\b(?:workflow|routine|procedure|every\s+time\s+we|to\s+deploy|run\s+tests\s+using|steps\s+to|test\s+procedure)\b/i,
  /\b(?:to\s+build|to\s+test|to\s+run|to\s+start)\s+the\s+project\b/i,
]

const REFERENCE_PATTERNS: RegExp[] = [
  /\b(?:docs?\s+(?:url|is|at)|documentation\s+(?:url|is\s+at|at|is)|repository\s+(?:is\s+at|at|path)|path\s+is|environment\s+variable|endpoint\s+is|reference:)\b/i,
  /\b(?:api\s+docs?|api\s+documentation|handbook\s+at|wiki\s+is\s+at)\b/i,
]

const PREFERENCE_PATTERNS: RegExp[] = [
  /\bi (prefer|like|love|enjoy|favorite|favourite)\b/i,
  /\bmy favorite\b/i,
  /\bi prefer (to )?/i,
  /\bprefer concise\b/i,
  /\bprefer (long|short|detailed|concise|verbose)/i,
  /\bmy (favourite|favorite)\b/i,
  /\b(dark mode|light mode|coding style|communication tone)\b/i,
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
  if (PROJECT_DECISION_PATTERNS.some((re) => re.test(c))) return 'PROJECT_DECISION'
  if (WORKFLOW_PATTERNS.some((re) => re.test(c))) return 'WORKFLOW'
  if (REFERENCE_PATTERNS.some((re) => re.test(c))) return 'REFERENCE'
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

/**
 * Determine the ORIGIN of a durable fact from its content.
 *
 * The architecture models three sources (`MemorySource`):
 *   - 'user'     — the fact was voiced by the user (explicit memory command or
 *                  a first-person personal claim/preference).
 *   - 'inferred' — JARVIS derived the fact (in-passing capture, third-person
 *                  summaries with no user voice).
 *   - 'system'   — written by a system process.
 *
 * Only content is available here, so 'system' is never returned: a system
 * origin cannot be honestly detected from free text. Callers that know the
 * write path (e.g. the engine's auto-capture) pass an explicit source instead.
 */
export function detectSource(content: string): MemorySource {
  const clean = (content ?? '').trim()
  if (!clean) return 'user'
  // JARVIS-authored narration ("jarvis recalled…", "the user …") is JARVIS's
  // summary → inferred. A vocative ("jarvis, …") means the USER is addressing
  // JARVIS, so those fall through to the command/voice checks below.
  if (!/^jarvis[,:!]/i.test(clean) && /\b(the user|jarvis)\b/i.test(clean)) return 'inferred'
  // Explicit "remember/save/..." phrasing always originates from the user.
  if (isExplicitMemoryCommand(clean)) return 'user'
  // First-person personal statements are the user's own words.
  if (hasUserVoice(clean)) return 'user'
  // No user voice (detached summary) → JARVIS derived it.
  return 'inferred'
}

/** First-person cues that mark a fact as explicitly voiced by the user. */
function hasUserVoice(content: string): boolean {
  return (
    PROFILE_PATTERNS.some((re) => re.test(content)) ||
    PREFERENCE_PATTERNS.some((re) => re.test(content)) ||
    FACT_PATTERNS.some((re) => re.test(content)) ||
    /\bmy\b/i.test(content) ||
    /\bi['’]m\b|\bi am\b|\bi work\b|\bi live\b|\bi prefer\b|\bi use\b|\bi like\b|\bi play\b|\bi study\b|\bi code\b|\bi started\b/i.test(content)
  )
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
