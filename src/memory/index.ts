export type { Store } from './MemoryManager'
export {
  MemoryManager,
  LocalStorageStore,
  DEFAULT_PROFILE,
  DEFAULT_PREFERENCES,
} from './MemoryManager'
export type {
  Profile,
  UserPreferences,
  MemorySnapshot,
  Note,
  MemoryItem,
  MemoryType,
  MemorySource,
  RankedMemory,
  MemorySearchOptions,
  RememberResult,
  EmbeddingHealthSummary,
} from './MemoryManager'
export { isValidEmbedding } from './MemoryManager'

export type {
  EmbeddingProvider,
  EmbeddingVector,
  ProviderHealth,
  ProviderHealthStatus,
  EmbeddingConfig,
} from './embeddings'
export {
  DeterministicEmbeddingProvider,
  defaultDeterministicProvider,
} from './deterministicEmbeddingProvider'
export {
  OpenAIEmbeddingProvider,
  openAIEmbeddingProvider,
} from './openaiEmbeddingProvider'
export type { BackfillResult, DeduplicationResult } from './embeddingManager'
export {
  EmbeddingManager,
  createEmbeddingManager,
  getDefaultEmbeddingManager,
  resetDefaultEmbeddingManager,
} from './embeddingManager'
export {
  hybridScore,
  hybridScoreFromSimilarity,
  DEFAULT_HYBRID_CONFIG,
  type HybridRankingConfig,
  lexicalScore,
  lexicalOverlap,
  semanticScore,
  importanceBoost,
  recencyBoost,
} from './hybridRanking'
export {
  cosineSimilarity,
  normalizeSimilarity,
  findMostSimilar,
} from './vectorSimilarity'
export {
  LocalStorageVectorStore,
  VECTOR_STORE_VERSION,
  DEFAULT_VECTOR_STORAGE_KEY,
  defaultVectorStorageKey,
  type VectorStore,
  type VectorEntry,
  type VectorStoreRecord,
  type RankedVector,
  type VectorSearchOptions,
  type VectorSearchResult,
  type VectorDiagnostics,
  type VectorStoreSourceItem,
} from './vectorStore'
export {
  buildMemoryContext,
  DEFAULT_MEMORY_CONTEXT_LIMIT,
  MAX_MEMORY_CONTEXT_TOKENS,
  MemoryContextManager,
  selectMemoryWithinBudget,
  renderMemoryLine,
  estimateTokens,
  type MemoryContext,
  type MemoryContextManagerConfig,
} from './context'
export {
  DEFAULT_LIFECYCLE_CONFIG,
  defaultLifecycleConfig,
  archiveCandidates,
  isLifecycleDue,
  itemAgeDays,
  isStaleCandidate,
  overflowCandidates,
} from './lifecycle'
export type {
  LifecycleConfig,
  LifecycleReport,
  ArchiveReason,
  ArchivedMemory,
  ArchiveCandidacy,
} from './lifecycle'
export {
  EPISODE_META_KEY,
  episodeIdOf,
  tagWithEpisode,
  validateEpisode,
  withIncrementedCount,
} from './episodes'
export type { Episode } from './episodes'