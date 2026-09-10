import type { MemoryItem, MemorySearchOptions, RankedMemory } from './MemoryManager'
import type { HybridRankingConfig } from './hybridRanking'
import { episodeIdOf } from './episodes'

/**
 * Phase 0.7 — controlled memory-context retrieval manager.
 *
 * The engine calls this to assemble a SMALL, relevant snippet of stored memory
 * for the AI — never the whole database. It ranks candidates with the injected
 * `search`, then makes a TOKEN-AWARE selection: only the best-scoring items
 * that fit the budget enter the prompt, so a burst of verbose memories can't
 * blow the model context. Optionally prefers memories from one episode (the
 * current session) when the budget is tight.
 *
 * This is the seam the codebase reserved for vector retrieval: `search` is
 * injected by the caller (MemoryManager's hybrid search, powered by the
 * companion vector store since 0.6D), keeping prompt sizing independent of the
 * retrieval backend.
 */

export const DEFAULT_MEMORY_CONTEXT_LIMIT = 6
export const MAX_MEMORY_CONTEXT_TOKENS = 800

export interface MemoryContext {
  memories: RankedMemory[]
  /** Compact, human/LLM-readable rendering of the selected memories. */
  text: string
  /** True when the store had memories but none were relevant enough. */
  empty: boolean
}

export interface MemoryContextManagerConfig {
  /** Maximum number of memory items to include (default 6). */
  limit?: number
  /** Token budget for the rendered context (default 800). */
  maxTokens?: number
  /** Prefer memories from this episode when selecting within the budget. */
  preferEpisodeId?: string
}

/**
 * Cheap, honest token estimate (~4 chars per token, never 0). Good enough to
 * bound the prompt without pulling in a tokenizer dependency.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4))
}

/** Render a single memory as a tagged `- [tag] content` line. */
export function renderMemoryLine(item: MemoryItem): string {
  const tag =
    item.type === 'PROFILE'
      ? 'profile'
      : item.type === 'PREFERENCE'
        ? 'preference'
        : item.type === 'NOTE'
          ? 'note'
          : 'fact'
  return `- [${tag}] ${item.content}`
}

/**
 * Pick, among ranked candidates, the best-scoring items that fit inside the
 * token budget and the item cap. When `preferEpisodeId` is set, candidates
 * from that episode are considered first (so the current session stays
 * salient under token pressure); the returned list is re-ordered back to
 * original rank order so the prompt snippet stays score-ordered.
 */
export function selectMemoryWithinBudget(
  ranked: RankedMemory[],
  maxTokens: number,
  maxItems: number,
  preferEpisodeId?: string,
): RankedMemory[] {
  if (maxItems <= 0 || maxTokens <= 0 || ranked.length === 0) return []
  if (maxItems >= ranked.length && maxTokens >= MAX_MEMORY_CONTEXT_TOKENS) {
    return ranked
  }

  const order = ranked.map((_, i) => i)
  if (preferEpisodeId) {
    order.sort((i, j) => {
      const left = episodeIdOf(ranked[i].item) === preferEpisodeId ? 0 : 1
      const right = episodeIdOf(ranked[j].item) === preferEpisodeId ? 0 : 1
      return left - right || i - j
    })
  }

  const selected = new Set<number>()
  let used = 0
  for (const idx of order) {
    if (selected.size >= maxItems) break
    const cost = estimateTokens(renderMemoryLine(ranked[idx].item)) + 1 // trailing newline
    if (used + cost > maxTokens) continue // skip; later items may be cheaper
    selected.add(idx)
    used += cost
  }
  return ranked.filter((_, i) => selected.has(i))
}

export class MemoryContextManager {
  private limit: number
  private maxTokens: number
  private preferEpisodeId: string | undefined

  constructor(config: MemoryContextManagerConfig = {}) {
    this.limit = config.limit ?? DEFAULT_MEMORY_CONTEXT_LIMIT
    this.maxTokens = config.maxTokens ?? MAX_MEMORY_CONTEXT_TOKENS
    this.preferEpisodeId = config.preferEpisodeId
  }

  setLimit(limit: number): void {
    this.limit = Math.max(0, Math.floor(limit))
  }

  setMaxTokens(tokens: number): void {
    this.maxTokens = Math.max(0, Math.floor(tokens))
  }

  setPreferEpisode(id: string | undefined): void {
    this.preferEpisodeId = id
  }

  async build(
    search: (query: string, opts?: MemorySearchOptions & { embeddingConfig?: HybridRankingConfig }) => Promise<RankedMemory[]>,
    allItems: () => MemoryItem[],
    query: string,
    embeddingConfig?: HybridRankingConfig,
  ): Promise<MemoryContext> {
    const trimmed = (query ?? '').trim()
    let ranks: RankedMemory[] = []
    if (trimmed) {
      // Ask for a pool larger than the final cap so budget-aware selection can
      // favor compact, relevant items instead of only score order.
      const candidateLimit = Math.max(this.limit, Math.min(24, this.limit * 4))
      ranks = await search(trimmed, { limit: candidateLimit, embeddingConfig })
    }
    const selected = selectMemoryWithinBudget(ranks, this.maxTokens, this.limit, this.preferEpisodeId)
    const total = allItems().length

    if (!selected.length) {
      return {
        memories: [],
        text:
          total === 0
            ? 'No personal memory has been stored yet.'
            : 'No specific stored memory matched the current request.',
        empty: true,
      }
    }

    return {
      memories: selected.map((r) => ({ item: r.item, score: r.score })),
      text: selected.map((r) => renderMemoryLine(r.item)).join('\n'),
      empty: false,
    }
  }
}