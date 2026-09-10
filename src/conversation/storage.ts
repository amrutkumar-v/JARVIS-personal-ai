import type { ConversationMessage, PersistedConversation } from './types'

/**
 * Conversation persistence — local browser storage.
 *
 * Survives a page refresh so recent discussion isn't lost. This is LOCAL
 * persistent storage for now, with a configurable message cap so localStorage
 * never grows unbounded. No API keys, no secrets, no tool payloads — just
 * role/text/timestamps (optionally a linked activity id).
 */

const STORAGE_KEY = 'jarvis.conversation'
const DEFAULT_LIMIT = 100

export interface ConversationStorageConfig {
  /** Maximum number of messages retained. Oldest are trimmed first. */
  limit?: number
}

function makeKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as Crypto & { randomUUID: () => string }).randomUUID()
  }
  return `ci-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Persist a conversation (trimmed to the limit) and return the saved copy. */
export function persistConversation(
  conversation: PersistedConversation,
  cfg: ConversationStorageConfig = {},
): PersistedConversation {
  const limit = Math.max(1, cfg.limit ?? DEFAULT_LIMIT)
  const trimmed: PersistedConversation = {
    id: conversation.id,
    createdAt: conversation.createdAt,
    messages: conversation.messages.slice(-limit),
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch (error) {
    console.warn('[conversation] persist failed', error)
  }
  return trimmed
}

/** Load a conversation from storage, or a fresh empty one. */
export function loadConversation(): PersistedConversation {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { id: makeKey(), createdAt: new Date().toISOString(), messages: [] }
    const parsed = JSON.parse(raw) as PersistedConversation
    if (
      !parsed ||
      typeof parsed.id !== 'string' ||
      !Array.isArray(parsed.messages)
    ) {
      return { id: makeKey(), createdAt: new Date().toISOString(), messages: [] }
    }
    return {
      id: parsed.id,
      createdAt: parsed.createdAt || new Date().toISOString(),
      messages: parsed.messages.filter(isValidMessage),
    }
  } catch {
    return { id: makeKey(), createdAt: new Date().toISOString(), messages: [] }
  }
}

/** Clear stored conversation history. */
export function clearStoredConversation(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

function isValidMessage(m: unknown): m is ConversationMessage {
  if (!m || typeof m !== 'object') return false
  const mm = m as Partial<ConversationMessage>
  return (
    typeof mm.id === 'string' &&
    (mm.actor === 'user' || mm.actor === 'assistant' || mm.actor === 'system') &&
    typeof mm.text === 'string'
  )
}
