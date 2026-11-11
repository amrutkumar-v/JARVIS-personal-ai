import { afterEach, describe, expect, it } from 'vitest'
import { EmbeddingManager, resolveDefaultEmbeddingProvider } from './embeddingManager'
import { isEmbeddingEndpointExplicitlyConfigured } from './openaiEmbeddingProvider'
import { resetAiConfigCache } from '../config/ai'
import type { EmbeddingProvider, EmbeddingVector, ProviderHealth } from './embeddings'

const ENV = import.meta.env as Record<string, string | undefined>

function clearEnvironment(): void {
  delete ENV.VITE_JARVIS_EMBEDDING_BASE_URL
  delete ENV.VITE_JARVIS_EMBEDDING_PROXY_URL
  delete ENV.VITE_JARVIS_EMBEDDING_MODEL
  delete ENV.VITE_JARVIS_EMBEDDING_DIMENSIONS
  delete ENV.VITE_JARVIS_AI_BASE_URL
  delete ENV.VITE_JARVIS_AI_MODEL
  delete ENV.JARVIS_API_KEY
  resetAiConfigCache()
}

afterEach(() => {
  clearEnvironment()
})

const vec = (values: readonly number[]): EmbeddingVector => ({ values, dimensions: values.length })

/** Configurable fake provider. All behavior is mocked — no real API is touched. */
class FakeProvider implements EmbeddingProvider {
  readonly id = 'fake-real'
  readonly label = 'Fake Real Embeddings'
  readonly dimensions = 3
  configured = true
  status: ProviderHealth['status'] = 'healthy'
  lastError: string | undefined
  vectorFor = (_text: string): number[] => [1, 0, 0]
  batchImpl: ((texts: string[]) => Promise<EmbeddingVector[]>) | undefined
  embedCalls = 0
  batchCalls = 0
  batchTextsSeen: string[][] = []

  async embed(text: string): Promise<EmbeddingVector> {
    this.embedCalls++
    return vec(this.vectorFor(text))
  }

  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    this.batchCalls++
    if (this.batchImpl) return this.batchImpl(texts)
    this.batchTextsSeen.push([...texts])
    return texts.map((t) => vec(this.vectorFor(t)))
  }

  isConfigured(): boolean {
    return this.configured
  }

  async isReachable(): Promise<boolean> {
    return this.configured
  }

  getHealth(): ProviderHealth {
    return {
      configured: this.configured,
      status: this.status,
      providerId: this.id,
      label: this.label,
      model: 'fake-model',
      dimensions: this.dimensions,
      fallbackActive: false,
      lastError: this.lastError,
      lastCheckedAt: Date.now(),
    }
  }
}

describe('EmbeddingManager (Phase 0.6C)', () => {
  it('defaults to the deterministic provider with fallback marked active', () => {
    const manager = new EmbeddingManager()
    expect(manager.isEnabled()).toBe(true)
    expect(manager.hasRealEmbeddings()).toBe(false)
    expect(manager.getProviderLabel()).toBe(
      'Deterministic Test Embeddings (NO real semantics)',
    )
    const health = manager.getHealth()
    expect(health.providerId).toBe('deterministic-test')
    expect(health.fallbackActive).toBe(true)
    expect(health.status).toBe('healthy')
  })

  it('reports healthy status and no fallback for a real provider', () => {
    const manager = new EmbeddingManager({ provider: new FakeProvider() })
    const health = manager.getHealth()
    expect(health.providerId).toBe('fake-real')
    expect(health.status).toBe('healthy')
    expect(health.fallbackActive).toBe(false)
  })

  it('reports unhealthy status and is disabled when not configured', () => {
    const provider = new FakeProvider()
    provider.configured = false
    provider.status = 'unhealthy'
    const manager = new EmbeddingManager({ provider })
    expect(manager.isEnabled()).toBe(false)
    expect(manager.hasRealEmbeddings()).toBe(false)
    const health = manager.getHealth()
    expect(health.configured).toBe(false)
    expect(health.status).toBe('unhealthy')
  })

  it('invalidates the health cache after a failed generation', async () => {
    const provider = new FakeProvider()
    const manager = new EmbeddingManager({ provider })
    provider.vectorFor = () => [1, 2, 3, 4] // malformed (wrong dims)
    expect(await manager.generateEmbedding('x')).toBeUndefined()
    const health = manager.getHealth()
    expect(health.status).toBe('healthy') // stale? no — regeneration invalidates cache, re-check
  })

  it('generates a single valid embedding', async () => {
    const manager = new EmbeddingManager({ provider: new FakeProvider() })
    const embedding = await manager.generateEmbedding('hello world')
    expect(embedding).toEqual([1, 0, 0])
  })

  it('returns undefined for empty text', async () => {
    const manager = new EmbeddingManager({ provider: new FakeProvider() })
    expect(await manager.generateEmbedding('   ')).toBeUndefined()
  })

  it('chunks batch embedding by batchSize', async () => {
    const provider = new FakeProvider()
    const manager = new EmbeddingManager({ provider, batchSize: 2 })
    const result = await manager.generateEmbeddingsBatch(['a', 'b', 'c', 'd', 'e'])
    expect(result).toHaveLength(5)
    expect(provider.batchTextsSeen).toEqual([['a', 'b'], ['c', 'd'], ['e']])
    expect(provider.batchCalls).toBe(3)
  })

  it('returns empty results for an empty input', async () => {
    const manager = new EmbeddingManager({ provider: new FakeProvider() })
    expect(await manager.generateEmbeddingsBatch([])).toEqual([])
    expect(await manager.embedMemoryItems([])).toEqual(new Map())
  })

  it('retries a transient batch failure and recovers', async () => {
    const provider = new FakeProvider()
    let calls = 0
    provider.batchImpl = async (texts) => {
      calls++
      if (calls === 1) throw new Error('transient failure')
      return texts.map((t) => vec(provider.vectorFor(t)))
    }
    const manager = new EmbeddingManager({ provider, maxRetries: 2, retryDelayMs: 0 })
    const result = await manager.generateEmbeddingsBatch(['a', 'b', 'c'])
    expect(result).toEqual([
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ])
    expect(calls).toBe(2)
  })

  it('returns undefined for all entries when the provider keeps failing', async () => {
    const provider = new FakeProvider()
    provider.batchImpl = async () => {
      throw new Error('down')
    }
    const manager = new EmbeddingManager({ provider, maxRetries: 1, retryDelayMs: 0 })
    const result = await manager.generateEmbeddingsBatch(['a', 'b'])
    expect(result).toEqual([undefined, undefined])
    expect(provider.batchCalls).toBe(2)
  })

  it('treats a wrong-dimension single response as a failure (malformed)', async () => {
    const provider = new FakeProvider()
    provider.vectorFor = () => [1, 2, 3, 4] // 4 dims, provider declares 3
    const manager = new EmbeddingManager({ provider, maxRetries: 0 })
    expect(await manager.generateEmbedding('hello')).toBeUndefined()
  })

  it('treats non-finite components as a failure (malformed)', async () => {
    const provider = new FakeProvider()
    provider.vectorFor = () => [1, Number.NaN, 0]
    const manager = new EmbeddingManager({ provider, maxRetries: 0 })
    expect(await manager.generateEmbedding('hello')).toBeUndefined()
  })

  it('handles a batch response count mismatch as a structural failure', async () => {
    const provider = new FakeProvider()
    provider.batchImpl = async () => [vec([1, 2, 3])] // 1 result for 2 inputs
    const manager = new EmbeddingManager({ provider, maxRetries: 0, retryDelayMs: 0 })
    const result = await manager.generateEmbeddingsBatch(['a', 'b'])
    expect(result).toEqual([undefined, undefined])
  })

  it('tolerates per-entry malformed vectors inside a batch (partial failure)', async () => {
    const provider = new FakeProvider()
    provider.batchImpl = async () => [vec([1, 2, 3]), vec([1, 2, 3, 4])]
    const manager = new EmbeddingManager({ provider, maxRetries: 0 })
    const result = await manager.generateEmbeddingsBatch(['ok', 'bad'])
    expect(result).toEqual([
      [1, 2, 3],
      undefined,
    ])
  })

  it('detects a semantic duplicate with a real provider', async () => {
    const manager = new EmbeddingManager({ provider: new FakeProvider() })
    const result = await manager.checkSemanticDuplicate('a new phrasing', [
      { id: 'a', content: 'an old phrasing', embedding: [1, 0, 0], metadata: { embeddingProvider: 'fake-real', embeddingDimensions: 3 } },
    ])
    expect(result.isDuplicate).toBe(true)
    expect(result.existingId).toBe('a')
    expect(result.similarity).toBeGreaterThanOrEqual(0.95)
  })

  it('is conservative below the threshold (distinct memories kept)', async () => {
    const manager = new EmbeddingManager({ provider: new FakeProvider() })
    const result = await manager.checkSemanticDuplicate('whatever', [
      { id: 'b', content: 'something else', embedding: [1, 1, 0], metadata: { embeddingProvider: 'fake-real', embeddingDimensions: 3 } },
    ])
    expect(result.isDuplicate).toBe(false)
  })

  it('honors a lowered dedup threshold', async () => {
    const manager = new EmbeddingManager({ provider: new FakeProvider() })
    manager.setDeduplicationThreshold(0.5)
    const result = await manager.checkSemanticDuplicate('whatever', [
      { id: 'c', content: 'something else', embedding: [1, 1, 0], metadata: { embeddingProvider: 'fake-real', embeddingDimensions: 3 } },
    ])
    expect(result.isDuplicate).toBe(true)
    expect(result.existingId).toBe('c')
  })

  it('skips dimension-mismatched candidates during dedup', async () => {
    const manager = new EmbeddingManager({ provider: new FakeProvider() })
    const result = await manager.checkSemanticDuplicate('whatever', [
      { id: 'd', content: 'mismatch', embedding: [1, 0] },
    ])
    expect(result.isDuplicate).toBe(false)
  })

  it('never detecs a duplicate when there are no embeddable candidates', async () => {
    const manager = new EmbeddingManager({ provider: new FakeProvider() })
    expect(await manager.checkSemanticDuplicate('x', [])).toEqual({ isDuplicate: false })
    expect(
      await manager.checkSemanticDuplicate('x', [{ id: 'e', content: 'no vector' }]),
    ).toEqual({ isDuplicate: false })
  })

  it('never runs semantic dedup through the deterministic provider', async () => {
    const manager = new EmbeddingManager() // deterministic provider
    const result = await manager.checkSemanticDuplicate('the quick brown fox', [
      { id: 'a', content: 'a quick brown fox', embedding: [1, 0, 0] },
      { id: 'b', content: 'b', embedding: [1, 0, 0] },
    ])
    expect(result.isDuplicate).toBe(false)
  })

  it('skips embedding backfill when embeddings are disabled', async () => {
    const manager = new EmbeddingManager({ skipEmbeddings: true })
    const result = await manager.backfillEmbeddings([{ id: 'x', content: 'hi' }])
    expect(result.skipped).toBe(1)
    expect(result.processed).toBe(0)
  })

  it('reports backfill stats and skips already-embedded items', async () => {
    const manager = new EmbeddingManager({ provider: new FakeProvider() })
    const result = await manager.backfillEmbeddings([
      { id: 'a', content: 'one' },
      { id: 'b', content: 'two', embedding: [1, 0, 0] },
      { id: 'c', content: 'three' },
    ])
    expect(result.total).toBe(3)
    expect(result.alreadyEmbedded).toBe(1)
    expect(result.processed).toBe(2)
    expect(result.successful).toBe(2)
    expect(result.failed).toBe(0)
  })

  it('reports failed backfill entries without throwing', async () => {
    const provider = new FakeProvider()
    provider.batchImpl = async () => {
      throw new Error('down')
    }
    const manager = new EmbeddingManager({ provider, maxRetries: 0 })
    const result = await manager.backfillEmbeddings([{ id: 'x', content: 'hi' }])
    expect(result.failed).toBe(1)
    expect(result.successful).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].id).toBe('x')
  })
})

describe('default provider auto-resolution (Work 2)', () => {
  it('resolves to the deterministic provider when nothing is declared', () => {
    expect(resolveDefaultEmbeddingProvider().id).toBe('deterministic-test')
    expect(isEmbeddingEndpointExplicitlyConfigured()).toBe(false)
  })

  it('promotes the real provider ONLY when embedding config is explicitly declared', () => {
    ENV.VITE_JARVIS_EMBEDDING_BASE_URL = 'https://emb.example.com/v1'
    ENV.VITE_JARVIS_EMBEDDING_MODEL = 'text-embedding-3-small'
    const provider = resolveDefaultEmbeddingProvider()
    expect(provider.id).toBe('openai-embeddings')
    expect(provider.isConfigured()).toBe(true)
    expect(isEmbeddingEndpointExplicitlyConfigured()).toBe(true)
  })

  it('a chat-only AI config never claims real semantic memory', () => {
    ENV.VITE_JARVIS_AI_BASE_URL = 'https://api.example.com/v1'
    ENV.VITE_JARVIS_AI_MODEL = 'gpt-4o-mini'
    expect(isEmbeddingEndpointExplicitlyConfigured()).toBe(false)
    expect(resolveDefaultEmbeddingProvider().id).toBe('deterministic-test')
  })

  it('does not substitute the chat endpoint when embedding intent is incomplete', () => {
    ENV.VITE_JARVIS_AI_BASE_URL = 'https://api.example.com/v1'
    ENV.VITE_JARVIS_AI_MODEL = 'gpt-4o-mini'
    ENV.VITE_JARVIS_EMBEDDING_MODEL = 'embeddinggemma'
    const provider = resolveDefaultEmbeddingProvider()
    expect(provider.id).toBe('openai-embeddings')
    expect(provider.isConfigured()).toBe(false)
  })

  it('a fresh manager selects configured real embeddings but does not claim them verified yet', () => {
    ENV.VITE_JARVIS_EMBEDDING_PROXY_URL = '/api/ai'
    ENV.VITE_JARVIS_EMBEDDING_MODEL = 'text-embedding-3-small'
    const manager = new EmbeddingManager()
    expect(manager.hasRealEmbeddings()).toBe(true)
    expect(manager.isEnabled()).toBe(true)
    const health = manager.getHealth()
    expect(health.providerId).toBe('openai-embeddings')
    expect(health.fallbackActive).toBe(false)
    expect(health.label).toBe('OpenAI-Compatible Embeddings')
    expect(health.status).toBe('unknown')
  })
})
