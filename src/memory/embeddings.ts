/**
 * Embedding Provider Abstraction — Phase 0.6A/0.6C
 *
 * Provides a vendor-neutral interface for generating text embeddings.
 * The deterministic test provider is used for development and tests.
 * Real providers can be plugged in without changing the memory architecture.
 */

export interface EmbeddingVector {
  readonly values: readonly number[]
  readonly dimensions: number
}

export type ProviderHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unhealthy'

export interface ProviderHealth {
  /** Whether the provider is configured with valid credentials/endpoints. */
  configured: boolean
  /** Current health status of the provider. */
  status: ProviderHealthStatus
  /** Provider identifier. */
  providerId: string
  /** Human-readable provider label. */
  label: string
  /** Model name being used. */
  model: string
  /** Embedding dimensions. */
  dimensions: number
  /** Whether fallback to deterministic provider is active. */
  fallbackActive: boolean
  /** Last error message if unhealthy. */
  lastError?: string
  /** Timestamp of last health check. */
  lastCheckedAt?: number
}

export interface EmbeddingProvider {
  readonly id: string
  readonly label: string
  readonly dimensions: number

  /** Generate an embedding for a single text. */
  embed(text: string): Promise<EmbeddingVector>

  /** Generate embeddings for multiple texts (batch optimization). */
  embedBatch(texts: string[]): Promise<EmbeddingVector[]>

  /** Whether this provider is configured with valid credentials/endpoints. */
  isConfigured(): boolean

  /** Whether the provider believes it can answer right now. */
  isReachable(): Promise<boolean>

  /** Get current health status of the provider. */
  getHealth(): ProviderHealth
}

/** Result of an embedding operation for logging/debugging. */
export interface EmbeddingResult {
  vector: EmbeddingVector
  durationMs: number
}

/** Configuration for embedding provider selection. */
export interface EmbeddingConfig {
  providerId: string
  model?: string
  dimensions?: number
}