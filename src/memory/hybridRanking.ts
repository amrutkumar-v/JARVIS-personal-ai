import type { MemoryItem, MemoryType } from './MemoryManager'
import { cosineSimilarity, normalizeSimilarity } from './vectorSimilarity'
import { tokenize } from '../utils/text'

/**
 * Hybrid Ranking Configuration — Phase 0.6A
 *
 * All weights in one place for explainability and tuning.
 * Scores are combined as: final = (semantic * wSemantic) + (lexical * wLexical) + (importance * wImportance) + (recency * wRecency)
 * Then normalized to [0, 1] range.
 */
export interface HybridRankingConfig {
  /** Weight for semantic similarity (cosine similarity of embeddings). */
  semanticWeight: number
  /** Weight for lexical overlap (token matching). */
  lexicalWeight: number
  /** Weight for importance boost (0..1). */
  importanceWeight: number
  /** Weight for recency boost (0..1, decays over time). */
  recencyWeight: number

  /** Minimum final score to consider a memory relevant. */
  minScore: number
  /** Maximum number of results to return. */
  limit: number
  /** Optional filter by memory type. */
  types?: MemoryType[]
}

export const DEFAULT_HYBRID_CONFIG: HybridRankingConfig = {
  semanticWeight: 0.55,
  lexicalWeight: 0.25,
  importanceWeight: 0.1,
  recencyWeight: 0.1,
  minScore: 0.25,
  limit: 5,
}

/**
 * Lexical token overlap of arbitrary text against a query's token needle,
 * using the existing tokenization logic. Returns a normalized score in
 * [0, 1] (1 = the whole query term list appears; 0 = no overlap). Phase 0.9
 * reuses this for conversation-window retrieval over transcript messages,
 * so lexical matching is byte-identical for memories and transcript lines.
 */
export function lexicalOverlap(text: string, queryTokens: string[], needle: Set<string>): number {
  const bodyTokens = tokenize(text)
  if (!bodyTokens.length) return 0
  let overlap = 0
  for (const t of bodyTokens) if (needle.has(t)) overlap += 1
  if (overlap === 0) return 0
  return overlap / Math.max(1, queryTokens.length)
}

/**
 * Compute lexical score using the existing tokenization logic.
 * Returns score in [0, 1].
 */
export function lexicalScore(item: MemoryItem, queryTokens: string[], needle: Set<string>): number {
  return lexicalOverlap(item.content, queryTokens, needle)
}

/**
 * Compute semantic score from embeddings.
 * Returns normalized score in [0, 1], or 0 if no embeddings available.
 */
export function semanticScore(
  item: MemoryItem,
  queryEmbedding: number[] | undefined,
): number {
  if (!queryEmbedding || !item.embedding || item.embedding.length === 0) {
    return 0
  }
  const sim = cosineSimilarity(queryEmbedding, item.embedding)
  return normalizeSimilarity(sim)
}

/**
 * Compute importance boost from item importance (0..1).
 * Returns value in [0, 1] based on importance field.
 */
export function importanceBoost(item: MemoryItem): number {
  // Importance is already 0..1, use it directly
  return item.importance
}

/**
 * Compute recency boost based on age.
 * Returns value in [0, 1] with 1 = now, decaying over time.
 * Half-life of 30 days.
 */
export function recencyBoost(item: MemoryItem, nowMs: number): number {
  const itemTime = Date.parse(item.updatedAt || item.createdAt)
  if (!Number.isFinite(itemTime)) return 0.5
  const ageDays = Math.max(0, (nowMs - itemTime) / 86_400_000)
  return 1 / (1 + ageDays / 30)
}

/**
 * Combined hybrid score for a single memory item.
 *
 * Semantic component comes from `semanticScore` (inline item embedding).
 * Returns normalized score in [0, 1].
 */
export function hybridScore(
  item: MemoryItem,
  queryEmbedding: number[] | undefined,
  queryTokens: string[],
  needle: Set<string>,
  nowMs: number,
  config: HybridRankingConfig = DEFAULT_HYBRID_CONFIG,
): number {
  return hybridScoreFromSimilarity(
    item,
    semanticScore(item, queryEmbedding),
    queryTokens,
    needle,
    nowMs,
    config,
  )
}

/**
 * Hybrid score with a precomputed semantic-similarity value.
 *
 * Additive Phase 0.6D variant used when the semantic component is resolved
 * elsewhere (e.g. a companion vector store) instead of from the item's inline
 * embedding. `semanticSimilarity` is a normalized [0, 1] value (typically
 * `normalizeSimilarity(cosineSimilarity(query, stored))`), so callers that
 * feed `semanticScore()` into this helper get byte-identical results to
 * `hybridScore()`. Lexical / importance / recency behave exactly as before.
 */
export function hybridScoreFromSimilarity(
  item: MemoryItem,
  semanticSimilarity: number,
  queryTokens: string[],
  needle: Set<string>,
  nowMs: number,
  config: HybridRankingConfig = DEFAULT_HYBRID_CONFIG,
): number {
  const semantic = clamp01(semanticSimilarity)
  const lexical = lexicalScore(item, queryTokens, needle)
  const importance = importanceBoost(item)
  const recency = recencyBoost(item, nowMs)

  let score =
    semantic * config.semanticWeight +
    lexical * config.lexicalWeight +
    importance * config.importanceWeight +
    recency * config.recencyWeight

  // Normalize by sum of weights to keep in [0, 1]
  const totalWeight =
    config.semanticWeight +
    config.lexicalWeight +
    config.importanceWeight +
    config.recencyWeight
  if (totalWeight > 0) {
    score /= totalWeight
  }

  return Math.max(0, Math.min(1, score))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}