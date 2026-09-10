import { MemoryContextManager, DEFAULT_MEMORY_CONTEXT_LIMIT as CONTEXT_LIMIT } from './contextManager'
import type { MemoryContext } from './contextManager'
import type { MemoryItem, MemorySearchOptions, RankedMemory } from './MemoryManager'
import type { HybridRankingConfig } from './hybridRanking'

/**
 * Controlled memory-context mechanism (Phase 0.7).
 *
 * `buildMemoryContext` is a thin backward-compatible facade over
 * `MemoryContextManager` (src/memory/contextManager.ts): it ranks memories for
 * the utterance and enforces a token budget during selection, the "seam where
 * vector retrieval will slot in" — which since 0.6D is the injected `search`
 * (MemoryManager hybrid search backed by the companion vector store). The
 * engine builds prompts from the tiny, relevant snippet, never the whole
 * database.
 */

export { MemoryContextManager }
export {
  selectMemoryWithinBudget,
  renderMemoryLine,
  estimateTokens,
  DEFAULT_MEMORY_CONTEXT_LIMIT,
  MAX_MEMORY_CONTEXT_TOKENS,
} from './contextManager'
export type { MemoryContextManagerConfig } from './contextManager'
export type { MemoryContext }

/**
 * Build a compact memory context snippet for a user utterance.
 *
 * Rules:
 * - Only explicitly selected/relevant items enter the context.
 * - Results are ranked (search) first, then spend a token budget.
 * - When `preferEpisodeId` is set, candidates from that session episode are
 *   considered first under token pressure (Phase 0.8: the engine passes the
 *   active session id so the conversation stays salient).
 * - Never include credentials (the store never contains them).
 */
export async function buildMemoryContext(
  search: (query: string, opts?: MemorySearchOptions & { embeddingConfig?: HybridRankingConfig }) => Promise<RankedMemory[]>,
  allItems: () => MemoryItem[],
  query: string,
  limit: number = CONTEXT_LIMIT,
  embeddingConfig?: HybridRankingConfig,
  preferEpisodeId?: string,
): Promise<MemoryContext> {
  return new MemoryContextManager({ limit, preferEpisodeId }).build(search, allItems, query, embeddingConfig)
}

/** Compact one-line summary for the settings/status UI. */
export function memoryContextSummary(ctx: MemoryContext): string {
  if (ctx.empty) return 'No relevant memory'
  return `${ctx.memories.length} relevant memory item(s)`
}