import type { ConversationMessage } from '../conversation/types'
import { tokenize } from '../utils/text'
import { estimateTokens } from '../memory/contextManager'
import { lexicalOverlap } from '../memory/hybridRanking'
import { cosineSimilarity, normalizeSimilarity } from '../memory/vectorSimilarity'

/**
 * Conversation-Window Context Manager — Phase 0.9
 *
 * Upgrades the provider prompt pipeline from "take the last N transcript
 * messages" (`buildContextWindow` recency slice, Phase 0-0.8) to a
 * retrieval-based conversation-window builder over the transcript.
 *
 * Selection is assembled from three deterministic stages:
 *
 *   1. RECENCY — an appropriate recent block of the transcript is always kept
 *      for conversational continuity (a contiguous newest tail that fits the
 *      token budget).
 *   2. RETRIEVAL — older transcript messages are ranked against the current
 *      user request with the same hybrid ingredients the memory system uses:
 *      deterministic lexical overlap (via `lexicalOverlap`, shared with
 *      hybrid ranking) plus semantic similarity when a REAL embedding
 *      provider is available. Candidates outside the recent window are the
 *      only pool, so a message already in the recent block can never be
 *      injected again.
 *   3. BUDGET — a strict, separate `MAX_CONVERSATION_CONTEXT_TOKENS` cap
 *      (independent of the 800-token MEMORY context budget) is spent greedily;
 *      candidates that do not fit are skipped, never truncated, and a single
 *      oversized message is dropped safely instead of throwing.
 *
 * The final context is chronological: older retrieved messages lead into the
 * recent window, so the provider sees a coherent thread. Lexical + semantic
 * matching collapses to lexical-only when no real embeddings exist
 * (`hasRealEmbeddings() === false`), and the deterministic test provider is
 * never treated as semantic understanding — gating happens in the caller's
 * injected scorer, matching the Phase 0.6A-0.6D embedding guarantees.
 *
 * Relationship to MemoryContextManager (Phase 0.7/0.8): the memory context
 * ranks stored MemoryItems and spends MAX_MEMORY_CONTEXT_TOKENS (800); this
 * manager ranks ConversationMessages and spends MAX_CONVERSATION_CONTEXT_TOKENS
 * (1600). The two budgets are intentionally separate; the engine combines the
 * small memory snippet with this conversation window when building provider
 * messages.
 */

/** Recent transcript messages always preserved (matches the old CONTEXT_WINDOW). */
export const DEFAULT_CONVERSATION_RECENT = 8

/** Strict conversation-context token budget, separate from the memory budget. */
export const MAX_CONVERSATION_CONTEXT_TOKENS = 1600

/**
 * Upper bound on older-message candidates considered for retrieval, so very
 * long transcripts never cause unbounded matching or embedding work.
 */
export const MAX_CONVERSATION_CANDIDATES = 40

/** Conversation ranking weights mirroring the memory hybrid's weighting idea. */
export const DEFAULT_CONVERSATION_WEIGHTS = {
  semantic: 0.6,
  lexical: 0.4,
} as const

export interface ConversationRankingWeights {
  semantic: number
  lexical: number
}

export interface ConversationContextManagerConfig {
  /** Recent messages always preserved (default 8). */
  recentCount?: number
  /** Token budget for the whole conversation window (default 1600). */
  maxTokens?: number
  /** Upper bound on older-message retrieval candidates (default 40). */
  candidateLimit?: number
  /** Ranking weights (defaults: semantic 0.6, lexical 0.4). */
  weights?: Partial<ConversationRankingWeights>
}

export interface ConversationContextInput {
  /** Full transcript to select from (index order must be chronological). */
  messages: ConversationMessage[]
  /** The current user request used as the retrieval query. */
  query: string
  /**
   * Message ids to exclude from selection entirely (e.g. the current user
   * message, which is handed to the provider separately as the prompt).
   */
  excludeIds?: ReadonlySet<string> | readonly string[]
  /**
   * Optional async semantic scorer. Receives `[query, ...candidateTexts]`
   * (aligned) and returns an embedding per input, or `undefined` for inputs
   * it could not embed. When absent (or when it yields no valid vectors) the
   * builder falls back to lexical-only ranking.
   */
  semanticScorer?: (texts: string[]) => Promise<Array<number[] | undefined>>
}

export interface ConversationWindowContext {
  /** Selected messages, oldest first (chronological). */
  messages: ConversationMessage[]
  /** How many of the selected messages came from the recent window. */
  recentCount: number
  /** How many older messages were added by retrieval. */
  retrievedCount: number
  /** Sum of the per-message token costs actually selected (<= maxTokens). */
  tokenEstimate: number
  /** True when real semantic vectors contributed to retrieval this turn. */
  semanticRanked: boolean
}

export interface RankedConversationMessage {
  message: ConversationMessage
  score: number
}

export interface ConversationWindowSelectionConfig {
  recentCount: number
  maxTokens: number
  candidateLimit: number
  weights: ConversationRankingWeights
}

/** Per-message token cost: content estimate + framing/newline overhead. */
export function conversationMessageTokens(text: string): number {
  return estimateTokens(text) + 1
}

/**
 * Combined relevance score for a transcript message against the current
 * request: `(semantic * wSemantic + lexical * wLexical) / (sum of weights)`,
 * normalized to [0, 1]. Messages with no overlap at all score 0 and are
 * never retrieved. Reuses `lexicalOverlap` (hybrid ranking) so transcript
 * lexical matching is identical to memory lexical matching.
 */
export function conversationScore(
  text: string,
  queryTokens: string[],
  needle: Set<string>,
  semanticSimilarity: number | undefined,
  weights: ConversationRankingWeights = DEFAULT_CONVERSATION_WEIGHTS,
): number {
  if (!weights.semantic && !weights.lexical) return 0
  const semantic = clamp01(semanticSimilarity ?? 0)
  const lexical = lexicalOverlap(text, queryTokens, needle)
  const numerator = semantic * weights.semantic + lexical * weights.lexical
  if (numerator <= 0) return 0
  return numerator / (weights.semantic + weights.lexical)
}

/**
 * Rank retrieval candidates against a query. Deterministic: higher score
 * first, then more recent, then stable original (chronological) order. Ties
 * in score are broken by recency so the freshest older messages surface first
 * when relevance is equal.
 */
export function rankConversationCandidates(
  candidates: ConversationMessage[],
  query: string,
  weights: ConversationRankingWeights = DEFAULT_CONVERSATION_WEIGHTS,
  semanticScores?: Array<number | undefined>,
): RankedConversationMessage[] {
  const tokens = tokenize(query ?? '')
  const needle = new Set(tokens)
  const ranked: RankedConversationMessage[] = []
  for (let i = 0; i < candidates.length; i += 1) {
    const message = candidates[i]
    const semantic = semanticScores ? semanticScores[i] : undefined
    const score = conversationScore(message.text, tokens, needle, semantic, weights)
    if (score > 0) {
      ranked.push({ message, score })
    }
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score || recencyMs(b.message.createdAt) - recencyMs(a.message.createdAt),
  )
  return ranked
}

/**
 * Pure, synchronous selection core:
 *
 * - A contiguous newest recent tail that fits `maxTokens` is always preserved.
 * - Older messages (beyond the recent window, bounded by `candidateLimit`)
 *   are ranked by the hybrid score and greedily added while the budget lasts.
 * - Retrieved messages all predate the recent window, so `[retrieved asc] ++
 *   [recent asc]` is globally chronological and contains no duplicate ids.
 * - Any single message larger than the whole budget is skipped (never
 *   thrown, never truncated).
 */
export function assembleConversationWindow(
  messages: ConversationMessage[],
  query: string,
  config: ConversationWindowSelectionConfig,
  semanticScores?: Array<number | undefined>,
): ConversationWindowContext {
  const visible = messages ?? []
  const hasQuery = tokenize(query ?? '').length > 0

  const recentCount = Math.max(0, Math.floor(config.recentCount))
  const maxTokens = Math.max(0, Math.floor(config.maxTokens))
  const candidateLimit = Math.max(0, Math.floor(config.candidateLimit))

  const recent = visible.slice(-recentCount)

  // Stage 1: recency. Walk newest -> oldest keeping a CONTIGUOUS tail inside
  // the budget. An individual message larger than the entire budget can never
  // fit, so the window stops there (such a message is simply absent).
  const recentKept: ConversationMessage[] = []
  let used = 0
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const message = recent[i]
    const cost = conversationMessageTokens(message.text)
    if (cost > maxTokens) break
    if (used + cost > maxTokens) break
    recentKept.unshift(message)
    used += cost
  }

  // Stage 2: retrieval candidates = everything older than the recent window,
  // bounded to the most recent `candidateLimit` (deterministic, bounded).
  const older = visible.slice(0, Math.max(0, visible.length - recent.length))
  const candidates = older.slice(-candidateLimit)

  let selectedRetrieved: ConversationMessage[] = []
  let semanticRanked = false
  if (hasQuery && candidates.length > 0) {
    semanticRanked = (semanticScores ?? []).some((s) => (s ?? 0) > 0)
    const ranked = rankConversationCandidates(candidates, query, config.weights, semanticScores)
    for (const entry of ranked) {
      const cost = conversationMessageTokens(entry.message.text)
      if (cost > maxTokens) continue
      if (used + cost > maxTokens) continue
      selectedRetrieved.push(entry.message)
      used += cost
    }
  }

  // Stage 3: chronological assembly (retrieved messages all predate recent).
  const retrievedChronological = [...selectedRetrieved].sort(
    (a, b) => recencyMs(a.createdAt) - recencyMs(b.createdAt),
  )

  return {
    messages: [...retrievedChronological, ...recentKept],
    recentCount: recentKept.length,
    retrievedCount: selectedRetrieved.length,
    tokenEstimate: used,
    semanticRanked,
  }
}

export class ConversationContextManager {
  private recentCount: number
  private maxTokens: number
  private candidateLimit: number
  private weights: ConversationRankingWeights

  constructor(config: ConversationContextManagerConfig = {}) {
    this.recentCount = Math.max(0, Math.floor(config.recentCount ?? DEFAULT_CONVERSATION_RECENT))
    this.maxTokens = Math.max(0, Math.floor(config.maxTokens ?? MAX_CONVERSATION_CONTEXT_TOKENS))
    this.candidateLimit = Math.max(0, Math.floor(config.candidateLimit ?? MAX_CONVERSATION_CANDIDATES))
    this.weights = resolveWeights(config.weights)
  }

  setRecentCount(count: number): void {
    this.recentCount = Math.max(0, Math.floor(count))
  }

  setMaxTokens(tokens: number): void {
    this.maxTokens = Math.max(0, Math.floor(tokens))
  }

  setCandidateLimit(limit: number): void {
    this.candidateLimit = Math.max(0, Math.floor(limit))
  }

  setWeights(weights: Partial<ConversationRankingWeights>): void {
    this.weights = resolveWeights(weights)
  }

  /**
   * Build the conversation window for one turn. Excluded ids (e.g. the current
   * user message) are filtered before selection; the optional semantic scorer
   * is consulted once, against a bounded candidate list, so embedding work is
   * race-safe (single batch call) and never unbounded.
   */
  async build(input: ConversationContextInput): Promise<ConversationWindowContext> {
    const source = input.messages ?? []
    const excludeIds = input.excludeIds
    const visible = excludeIds ? source.filter((m) => !isExcluded(excludeIds, m.id)) : source
    const query = (input.query ?? '').trim()
    const config: ConversationWindowSelectionConfig = {
      recentCount: this.recentCount,
      maxTokens: this.maxTokens,
      candidateLimit: this.candidateLimit,
      weights: this.weights,
    }

    let semanticScores: Array<number | undefined> | undefined
    if (input.semanticScorer && this.weights.semantic > 0) {
      const recentCount = Math.min(this.recentCount, visible.length)
      const older = visible.slice(0, Math.max(0, visible.length - recentCount))
      const candidates = older.slice(-this.candidateLimit)
      const texts = candidates.map((c) => c.text)
      if (texts.length > 0 && tokenize(query).length > 0) {
        semanticScores = await this.embeddingScores(input.semanticScorer, query, texts)
      }
    }

    return assembleConversationWindow(visible, query, config, semanticScores)
  }

  private async embeddingScores(
    semanticScorer: (texts: string[]) => Promise<Array<number[] | undefined>>,
    query: string,
    texts: string[],
  ): Promise<Array<number | undefined>> {
    let embeds: Array<number[] | undefined>
    try {
      embeds = await semanticScorer([query, ...texts])
    } catch (error) {
      console.warn('[conversation] semantic retrieval failed, falling back to lexical:', error)
      return texts.map(() => undefined)
    }
    if (!Array.isArray(embeds) || embeds.length !== 1 + texts.length) {
      return texts.map(() => undefined)
    }
    const queryEmbedding = embeds[0]
    return texts.map((_, i) => {
      const embedding = embeds[i + 1]
      // Never compute cross-dimension similarity: a mismatched (or missing)
      // candidate vector contributes 0 to the hybrid score.
      if (
        !queryEmbedding ||
        queryEmbedding.length === 0 ||
        !embedding ||
        embedding.length !== queryEmbedding.length
      ) {
        return undefined
      }
      return normalizeSimilarity(cosineSimilarity(queryEmbedding, embedding))
    })
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function resolveWeights(weights?: Partial<ConversationRankingWeights>): ConversationRankingWeights {
  return {
    semantic: clamp01(weights?.semantic ?? DEFAULT_CONVERSATION_WEIGHTS.semantic),
    lexical: clamp01(weights?.lexical ?? DEFAULT_CONVERSATION_WEIGHTS.lexical),
  }
}

function isExcluded(ids: ReadonlySet<string> | readonly string[], id: string): boolean {
  if (Array.isArray(ids)) return ids.includes(id)
  return (ids as ReadonlySet<string>).has(id)
}

function recencyMs(iso: string): number {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}