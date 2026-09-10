import type { EmbeddingProvider, ProviderHealth } from './embeddings'
import { defaultDeterministicProvider } from './deterministicEmbeddingProvider'
import { findMostSimilar } from './vectorSimilarity'

/**
 * Embedding Manager — Phase 0.6B / 0.6C
 *
 * Owns the embedding lifecycle for memories:
 * - Generates embeddings for new memory content
 * - Regenerates embeddings when content changes
 * - Batch-processes memories lacking embeddings (resumable backfill)
 * - Provides query embeddings for semantic search
 * - Tracks provider health (cached) and degrades gracefully
 * - Supports conservative semantic deduplication (real providers only)
 *
 * The manager is provider-agnostic: it interacts only with the
 * `EmbeddingProvider` interface. Core code never contains vendor-specific
 * logic. A provider is injected explicitly or defaults to the deterministic
 * (test/development) provider. Config-validation errors, missing credentials,
 * and provider failures must never crash JARVIS — callers can fall back to
 * lexical retrieval, and the deterministic provider is always available.
 */

export interface EmbeddingManagerConfig {
  /** Provider to use for embeddings. If not provided, uses the deterministic provider. */
  provider?: EmbeddingProvider
  /** Whether to skip embedding generation entirely (offline/tests). */
  skipEmbeddings?: boolean
  /** Maximum texts per embedBatch call. */
  batchSize?: number
  /** Maximum retries per batch call on provider failure. */
  maxRetries?: number
  /** Base retry delay in ms (applied with linear backoff). */
  retryDelayMs?: number
  /** Semantic deduplication similarity threshold (0-1). Conservative by default. */
  deduplicationThreshold?: number
}

/** Detailed, resumable statistics for a backfill operation. */
export interface BackfillResult {
  total: number
  alreadyEmbedded: number
  processed: number
  successful: number
  failed: number
  /** Items skipped because embeddings were disabled/empty content. */
  skipped: number
  durationMs: number
  errors: Array<{ id: string; error: string }>
}

/** Result of a semantic-duplicate check. */
export interface DeduplicationResult {
  isDuplicate: boolean
  existingId?: string
  similarity?: number
}

const DEFAULT_BATCH_SIZE = 20
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 200
const DEFAULT_DEDUPLICATION_THRESHOLD = 0.95
const HEALTH_CACHE_TTL_MS = 30_000

export class EmbeddingManager {
  private provider: EmbeddingProvider
  private skipEmbeddings: boolean
  private batchSize: number
  private maxRetries: number
  private retryDelayMs: number
  private deduplicationThreshold: number
  private healthCache: ProviderHealth | null = null
  private healthCacheExpiry = 0

  constructor(config: EmbeddingManagerConfig = {}) {
    // Default to the deterministic provider synchronously so that
    // `isEnabled()`/`generateEmbedding()` are immediately usable after
    // construction. Real providers are injected via config or setProvider(),
    // keeping the core provider-agnostic.
    this.provider = config.provider ?? defaultDeterministicProvider
    this.skipEmbeddings = config.skipEmbeddings ?? false
    this.batchSize = Math.max(1, config.batchSize ?? DEFAULT_BATCH_SIZE)
    this.maxRetries = Math.max(0, config.maxRetries ?? DEFAULT_MAX_RETRIES)
    this.retryDelayMs = Math.max(0, config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
    this.deduplicationThreshold = this.clampThreshold(
      config.deduplicationThreshold ?? DEFAULT_DEDUPLICATION_THRESHOLD,
    )
  }

  /** Swap the underlying provider (e.g., promote to a real provider). */
  setProvider(provider: EmbeddingProvider): void {
    this.provider = provider
    this.invalidateHealthCache()
  }

  /** The currently active provider. */
  getProvider(): EmbeddingProvider {
    return this.provider
  }

  /** Id of the currently active provider (e.g. 'deterministic-test'). */
  getProviderId(): string {
    return this.provider.id
  }

  /** Whether embedding generation is enabled and the provider is configured. */
  isEnabled(): boolean {
    return !this.skipEmbeddings && this.provider.isConfigured()
  }

  /**
   * Whether real semantic embeddings are available.
   * Returns false for the deterministic test provider, which must never
   * power production semantic-dedup decisions.
   */
  hasRealEmbeddings(): boolean {
    return this.isEnabled() && this.provider.id !== 'deterministic-test'
  }

  /** Force the next getHealth() call to re-check. */
  invalidateHealthCache(): void {
    this.healthCache = null
    this.healthCacheExpiry = 0
  }

  /**
   * Cached provider health. Re-checks at most every 30s.
   * Never performs a blocking network probe during search.
   * Reports `fallbackActive` when the deterministic provider is in use.
   */
  getHealth(): ProviderHealth {
    const now = Date.now()
    if (this.healthCache && now < this.healthCacheExpiry) {
      return this.healthCache
    }
    const providerHealth = this.provider.getHealth()
    const health: ProviderHealth = {
      ...providerHealth,
      fallbackActive: this.provider.id === 'deterministic-test',
    }
    this.healthCache = health
    this.healthCacheExpiry = now + HEALTH_CACHE_TTL_MS
    return health
  }

  /**
   * Generate a single embedding. Returns undefined when disabled,
   * provider unavailable, text is empty, generation fails, or the
   * provider returns a malformed vector (wrong dimensions / non-finite).
   */
  async generateEmbedding(text: string): Promise<number[] | undefined> {
    if (!this.isEnabled()) return undefined
    const trimmed = text.trim()
    if (!trimmed) return undefined
    try {
      const vector = await this.provider.embed(trimmed)
      return this.sanitizeVector(vector.values)
    } catch (error) {
      console.warn('[embedding] Failed to generate embedding:', error)
      this.invalidateHealthCache()
      return undefined
    }
  }

  /**
   * Generate embeddings for multiple texts in batches.
   * Returns an array aligned with `texts`; failed entries are undefined.
   */
  async generateEmbeddingsBatch(texts: string[]): Promise<Array<number[] | undefined>> {
    const results: Array<number[] | undefined> = new Array<number[] | undefined>(texts.length)
    if (!this.isEnabled() || texts.length === 0) {
      return results
    }
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const slice = texts.slice(i, i + this.batchSize)
      const batchResults = await this.embeddedBatchWithRetry(slice)
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j]
      }
    }
    return results
  }

  private async embeddedBatchWithRetry(
    texts: string[],
  ): Promise<Array<number[] | undefined>> {
    let lastError: Error | null = null
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const vectors = await this.provider.embedBatch(texts)
        if (!Array.isArray(vectors) || vectors.length !== texts.length) {
          throw new TypeError(
            `[embedding] Provider returned ${Array.isArray(vectors) ? vectors.length : 'an invalid'} ` +
              `result for ${texts.length} input(s)`,
          )
        }
        return vectors.map((v) => this.sanitizeVector(v.values))
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)))
        }
      }
    }
    console.warn('[embedding] Batch embedding failed after retries:', lastError)
    this.invalidateHealthCache()
    return new Array<number[] | undefined>(texts.length).fill(undefined)
  }

  /** Generate an embedding for a single memory item's content. */
  async embedMemoryItem(item: { id: string; content: string }): Promise<number[] | undefined> {
    return this.generateEmbedding(item.content)
  }

  /**
   * Generate embeddings for multiple memory items.
   * Returns a Map keyed by item id containing embeddings id->vector.
   */
  async embedMemoryItems(
    items: Array<{ id: string; content: string }>,
  ): Promise<Map<string, number[]>> {
    const map = new Map<string, number[]>()
    if (!this.isEnabled() || items.length === 0) return map
    const embeddings = await this.generateEmbeddingsBatch(items.map((i) => i.content))
    items.forEach((item, index) => {
      const embedding = embeddings[index]
      if (embedding) map.set(item.id, embedding)
    })
    return map
  }

  /**
   * Backfill embeddings for memories lacking one.
   *
   * Resumable & rerunnable: skips items that already have a valid (non-empty)
   * embedding, never deletes memories, and never overwrites valid embeddings
   * with undefined. Returns detailed statistics.
   */
  async backfillEmbeddings(
    items: Array<{ id: string; content: string; embedding?: number[] }>,
  ): Promise<BackfillResult> {
    const start = Date.now()
    const result: BackfillResult = {
      total: items.length,
      alreadyEmbedded: 0,
      processed: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
      errors: [],
    }

    if (!this.isEnabled()) {
      result.skipped = items.length
      result.durationMs = Date.now() - start
      return result
    }

    const needsEmbedding = items.filter(
      (item) => !item.embedding || item.embedding.length === 0,
    )
    result.alreadyEmbedded = items.length - needsEmbedding.length

    if (needsEmbedding.length === 0) {
      result.durationMs = Date.now() - start
      return result
    }

    for (let i = 0; i < needsEmbedding.length; i += this.batchSize) {
      const batch = needsEmbedding.slice(i, i + this.batchSize)
      const embeddingMap = await this.embedMemoryItems(
        batch.map((b) => ({ id: b.id, content: b.content })),
      )
      for (const item of batch) {
        const embedding = embeddingMap.get(item.id)
        if (embedding) {
          result.successful++
        } else {
          result.failed++
          result.errors.push({ id: item.id, error: 'Failed to generate embedding' })
        }
        result.processed++
      }
    }

    result.durationMs = Date.now() - start
    console.log(
      `[embedding] Backfill complete: ${result.successful} ok, ${result.failed} failed, ` +
        `${result.alreadyEmbedded} already embedded, ${result.skipped} skipped`,
    )
    return result
  }

  /**
   * Check for a semantic duplicate before storing new memory content.
   *
   * Only runs when a REAL provider is active (excludes `deterministic-test`),
   * so the deterministic provider can never drive production dedup decisions.
   * Conservative: returns duplicate only when similarity is at/above the
   * threshold; otherwise the caller should keep the entry. Config/embedding
   * failures never produce a false duplicate (returns isDuplicate: false).
   */
  async checkSemanticDuplicate(
    newContent: string,
    existingItems: Array<{ id: string; content: string; embedding?: number[] }>,
  ): Promise<DeduplicationResult> {
    if (!this.hasRealEmbeddings() || existingItems.length === 0) {
      return { isDuplicate: false }
    }

    const newEmbedding = await this.generateEmbedding(newContent)
    if (!newEmbedding) {
      return { isDuplicate: false }
    }

    const candidates = existingItems
      .filter((item) => item.embedding && item.embedding.length > 0)
      .map((item) => item.embedding!)

    if (candidates.length === 0) {
      return { isDuplicate: false }
    }

    const { index, similarity } = findMostSimilar(newEmbedding, candidates)
    if (index >= 0 && similarity >= this.deduplicationThreshold) {
      const match = existingItems.filter(
        (item) => item.embedding && item.embedding.length > 0,
      )[index]
      return { isDuplicate: true, existingId: match?.id, similarity }
    }

    return { isDuplicate: false }
  }

  /** Set the semantic dedup threshold, clamped to [0, 1]. */
  setDeduplicationThreshold(threshold: number): void {
    this.deduplicationThreshold = this.clampThreshold(threshold)
  }

  /** Get the semantic dedup threshold (0-1). */
  getDeduplicationThreshold(): number {
    return this.deduplicationThreshold
  }

  /** Embedding dimensions reported by the provider. */
  getDimensions(): number {
    return this.provider.dimensions
  }

  /** Human-readable provider label. */
  getProviderLabel(): string {
    return this.provider.label
  }

  private clampThreshold(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_DEDUPLICATION_THRESHOLD
    return Math.max(0, Math.min(1, value))
  }

  /**
   * Validate and normalize a provider vector.
   * Returns undefined (rather than garbage) when the response is malformed:
   * wrong dimensions for the provider, empty, or containing non-finite values.
   */
  private sanitizeVector(values: readonly number[]): number[] | undefined {
    if (!values || values.length !== this.provider.dimensions) return undefined
    for (const v of values) {
      if (!Number.isFinite(v)) return undefined
    }
    return Array.from(values)
  }
}

let defaultManager: EmbeddingManager | null = null

/** Create a new EmbeddingManager. */
export function createEmbeddingManager(config?: EmbeddingManagerConfig): EmbeddingManager {
  return new EmbeddingManager(config)
}

/** Get or lazily create the process-wide default EmbeddingManager. */
export function getDefaultEmbeddingManager(): EmbeddingManager {
  if (!defaultManager) {
    defaultManager = new EmbeddingManager()
  }
  return defaultManager
}

/** Reset the process-wide default EmbeddingManager (useful in tests). */
export function resetDefaultEmbeddingManager(): void {
  defaultManager = null
}