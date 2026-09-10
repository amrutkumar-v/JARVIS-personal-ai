import type { ProviderHealth } from './embeddings'

/**
 * Deterministic Test Embedding Provider — Phase 0.6A
 *
 * A fake embedding provider for development and tests.
 *
 * IMPORTANT: This does NOT provide real semantic understanding.
 * It exists ONLY for:
 * - Architecture validation
 * - Deterministic tests
 * - Offline development
 *
 * Real semantic quality requires a real embedding model/provider.
 *
 * This implementation uses a simple deterministic hash-based approach
 * that produces consistent vectors for the same input, but does NOT
 * capture genuine semantic similarity between different texts.
 */
const DEFAULT_DIMENSIONS = 384

function hashToVector(text: string, dimensions: number): Float32Array {
  // Simple deterministic hash: split text into words, hash each word,
  // distribute across vector dimensions
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 0)
  const vector = new Float32Array(dimensions)

  for (let i = 0; i < dimensions; i++) {
    let hash = 0
    for (let j = 0; j < words.length; j++) {
      const word = words[j]
      for (let k = 0; k < word.length; k++) {
        hash = ((hash << 5) - hash + word.charCodeAt(k)) | 0
      }
      // Mix in position
      hash = ((hash << 5) - hash + i + j) | 0
    }
    // Normalize to [-1, 1] range
    vector[i] = ((hash & 0x7fffffff) / 0x7fffffff) * 2 - 1
  }

  // L2 normalize
  let norm = 0
  for (let i = 0; i < dimensions; i++) {
    norm += vector[i] * vector[i]
  }
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      vector[i] /= norm
    }
  }

  return vector
}

export class DeterministicEmbeddingProvider {
  readonly id = 'deterministic-test'
  readonly label = 'Deterministic Test Embeddings (NO real semantics)'
  readonly dimensions: number

  constructor(dimensions: number = DEFAULT_DIMENSIONS) {
    this.dimensions = dimensions
  }

  async embed(text: string): Promise<{ values: readonly number[]; dimensions: number }> {
    if (!text || !text.trim()) {
      return { values: new Array(this.dimensions).fill(0), dimensions: this.dimensions }
    }
    const vector = hashToVector(text.trim(), this.dimensions)
    return { values: Array.from(vector), dimensions: this.dimensions }
  }

  async embedBatch(texts: string[]): Promise<Array<{ values: readonly number[]; dimensions: number }>> {
    return Promise.all(texts.map((t) => this.embed(t)))
  }

  isConfigured(): boolean {
    return true
  }

  async isReachable(): Promise<boolean> {
    return true
  }

  getHealth(): ProviderHealth {
    return {
      configured: true,
      status: 'healthy',
      providerId: this.id,
      label: this.label,
      model: 'deterministic-hash',
      dimensions: this.dimensions,
      fallbackActive: false,
      lastCheckedAt: Date.now(),
    }
  }
}

export const defaultDeterministicProvider = new DeterministicEmbeddingProvider()