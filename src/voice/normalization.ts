/**
 * Deterministic wake-phrase / session-phrase normalization (Phase 1.6).
 *
 * No LLM is ever used for wake-word detection. Text is normalized (lowercase,
 * punctuation stripped, whitespace collapsed) and compared against canonical
 * phrases. The exact primary wake phrase is "Wake up, JARVIS" —
 * casing/punctuation differences are tolerated, and a bare "Jarvis" or
 * "wake up" is NOT a wake phrase.
 */

export const CANONICAL_WAKE_PHRASE = 'wake up jarvis'
export const WAKE_COMMAND_TIMEOUT_MS = 8_000
export const WAKE_SESSION_TIMEOUT_MS = 30_000

const SLEEP_PHRASES = new Set(['go to sleep', 'sleep', 'stop listening'])
const CANCEL_PHRASES = new Set(['stop', 'cancel'])

/**
 * Lowercase, strip punctuation, collapse whitespace.
 * " WAKE   UP,   JARVIS!! " → "wake up jarvis"
 */
export function normalizeSpeechText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface WakeParse {
  matched: boolean
  /** Trailing command captured after the wake phrase (raw text, preserved). */
  command?: string
}

/** Consume the first run of words that normalizes to the wake phrase. */
function deriveCommandFromRaw(raw: string, canonical: string): string {
  const words = raw.split(/\s+/).filter((w) => w.length > 0)
  const canonicalWords = canonical.split(' ')
  for (let i = 0; i <= words.length - canonicalWords.length; i += 1) {
    const chunk = words.slice(i, i + canonicalWords.length).join(' ')
    if (normalizeSpeechText(chunk) === canonical) {
      return words.slice(i + canonicalWords.length).join(' ').trim()
    }
  }
  return ''
}

/**
 * Split a recognized utterance into wake phrase + optional trailing command.
 * - "Wake up, JARVIS"                    → { matched: true }
 * - "Wake up, JARVIS, open Chrome."      → { matched: true, command: "open Chrome." }
 * - "Jarvis" / "wake up" / "hello jarvis" → { matched: false }
 */
export function splitWakeAndCommand(text: string): WakeParse {
  const norm = normalizeSpeechText(text)
  if (norm === CANONICAL_WAKE_PHRASE) return { matched: true }
  if (norm.startsWith(`${CANONICAL_WAKE_PHRASE} `)) {
    const command = deriveCommandFromRaw(text, CANONICAL_WAKE_PHRASE)
    return { matched: true, command }
  }
  return { matched: false }
}

/** True when the utterance normalizes to the wake phrase (with or without a command). */
export function isWakeWordText(text: string): boolean {
  return splitWakeAndCommand(text).matched
}

export type UtteranceKind = 'sleep' | 'cancel' | 'command' | 'none'

/**
 * Deterministic classification of a recognized utterance.
 * Sleep/cancel phrases are handled by the voice session BEFORE any text is
 * sent to the Agent Core; everything else is a normal user command.
 */
export function classifyUtterance(text: string): UtteranceKind {
  const norm = normalizeSpeechText(text)
  if (norm.length === 0) return 'none'
  if (SLEEP_PHRASES.has(norm)) return 'sleep'
  if (CANCEL_PHRASES.has(norm)) return 'cancel'
  return 'command'
}