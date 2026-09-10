import type { ConversationMessage } from '../conversation/types'
import {
  assembleConversationWindow,
  MAX_CONVERSATION_CANDIDATES,
} from './conversationContextManager'

/**
 * Conversation context for provider prompts (Phase 0.9).
 *
 * `buildContextWindow` keeps its original synchronous signature and meaning
 * (a recency slice of the transcript) for backward compatibility, with an
 * optional `maxTokens` budget. The full retrieval-based pipeline — recency +
 * lexical + semantic ranking, deduplication and strict token budgeting — lives
 * in `ConversationContextManager` (src/engine/conversationContextManager.ts),
 * which the engine uses each turn. See docs/conversation-context.md.
 */

/** In-memory short-term context window used by providers to build prompts. */
export interface ContextWindow {
  messages: ConversationMessage[]
}

/**
 * Legacy/budget-aware recency window.
 *
 * Called without `options` this is byte-identical to the original
 * `messages.slice(-max)`. With `options.maxTokens` the newest contiguous block
 * that fits the budget is returned instead (a single message larger than the
 * budget is omitted, never truncated, never throws).
 */
export function buildContextWindow(
  messages: ConversationMessage[],
  max: number,
  options: { maxTokens?: number } = {},
): ContextWindow {
  const limit = Math.max(0, Math.floor(Number(max) || 0))
  const source = messages ?? []
  if (options.maxTokens === undefined) {
    return { messages: source.slice(-limit) }
  }
  const selected = assembleConversationWindow(source, '', {
    recentCount: limit,
    maxTokens: Math.max(0, Math.floor(options.maxTokens)),
    candidateLimit: MAX_CONVERSATION_CANDIDATES,
    weights: { semantic: 0, lexical: 0 },
  })
  return { messages: selected.messages }
}

export {
  ConversationContextManager,
  assembleConversationWindow,
  rankConversationCandidates,
  conversationScore,
  conversationMessageTokens,
  DEFAULT_CONVERSATION_RECENT,
  MAX_CONVERSATION_CONTEXT_TOKENS,
  MAX_CONVERSATION_CANDIDATES,
  DEFAULT_CONVERSATION_WEIGHTS,
} from './conversationContextManager'
export type {
  ConversationContextManagerConfig,
  ConversationContextInput,
  ConversationWindowContext,
  ConversationRankingWeights,
  RankedConversationMessage,
} from './conversationContextManager'