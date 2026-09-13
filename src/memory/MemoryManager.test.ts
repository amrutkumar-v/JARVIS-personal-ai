import { describe, expect, it, beforeEach } from 'vitest'
import { MemoryManager } from '../memory/MemoryManager'
import { EmbeddingManager } from './embeddingManager'
import { LocalStorageVectorStore } from './vectorStore'
import type { EmbeddingProvider, EmbeddingVector, ProviderHealth } from './embeddings'

/**
 * In-memory window/localStorage so MemoryManager can persist in node.
 */
function stubBrowserStorage(): void {
  const backing = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  ;(globalThis as Record<string, unknown>).window = {
    localStorage,
    setTimeout: (_fn: () => void) => 0,
  }
}

/** Deterministic, content-dependent 3-dim vector for a fake real provider. */
function contentVector(content: string): number[] {
  let h = 5381
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h) ^ content.charCodeAt(i)
  }
  const x = h >>> 0
  return [(x % 200) / 100, ((x >> 8) % 200) / 100, ((x >> 16) % 200) / 100]
}

/** Configurable fake of a real embedding provider (never calls the network). */
class FakeProvider implements EmbeddingProvider {
  readonly id = 'fake-real'
  readonly label = 'Fake Real Embeddings'
  readonly dimensions = 3
  state = { configured: true, fail: false }
  vectorFor = (text: string): number[] => contentVector(text)

  async embed(text: string): Promise<EmbeddingVector> {
    if (this.state.fail) throw new Error('embed failed')
    return { values: this.vectorFor(text), dimensions: this.dimensions }
  }

  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    if (this.state.fail) throw new Error('embed failed')
    return texts.map((t) => ({ values: this.vectorFor(t), dimensions: this.dimensions }))
  }

  isConfigured(): boolean {
    return this.state.configured
  }

  async isReachable(): Promise<boolean> {
    return this.state.configured
  }

  getHealth(): ProviderHealth {
    return {
      configured: this.state.configured,
      status: this.state.configured ? 'healthy' : 'unhealthy',
      providerId: this.id,
      label: this.label,
      model: 'fake-model',
      dimensions: this.dimensions,
      fallbackActive: false,
      lastError: this.state.fail ? 'embed failed' : undefined,
    }
  }
}

/**
 * Fake provider with crude semantic buckets so two differently-worded texts
 * (e.g. 'I love coffee' and 'a morning java') share a vector — the seam that
 * lets cross-instance semantic search work deterministically in tests.
 */
function bucketProvider(): FakeProvider {
  const provider = new FakeProvider()
  provider.vectorFor = (text) => {
    if (/coffee|java/.test(text)) return [1, 0, 0]
    if (/cat/.test(text)) return [0, 1, 0]
    return [0, 0, 1]
  }
  return provider
}

/** Wait for fire-and-forget background embedding to settle. */
async function settle(ms = 5): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** Write a raw persisted record into the stubbed localStorage. */
function seedStorage(record: unknown): void {
  const win = globalThis as {
    window: { localStorage: { setItem: (k: string, v: string) => void } }
  }
  win.window.localStorage.setItem('jarvis.memory', JSON.stringify(record))
}

describe('MemoryManager (structured persistent memory)', () => {
  beforeEach(() => stubBrowserStorage())

  it('starts empty and reports a zero count', () => {
    const memory = new MemoryManager()
    expect(memory.items()).toEqual([])
    expect(memory.count).toBe(0)
  })

  it('stores a typed item with an id and default importance', () => {
    const memory = new MemoryManager()
    const item = memory.remember('I work at Acme', {
      type: 'FACT',
      importance: 0.9,
      source: 'user',
    })
    expect(item.id).toBeTruthy()
    expect(item.content).toBe('I work at Acme')
    expect(item.importance).toBe(0.9)
    expect(memory.items()).toHaveLength(1)
    expect(memory.count).toBe(1)
  })

  it('dedupes repeated remembers by exact content', () => {
    const memory = new MemoryManager()
    memory.remember('My name is Jordan', { type: 'PROFILE' })
    memory.remember('My name is Jordan', { type: 'PROFILE' })
    expect(memory.items()).toHaveLength(1)
    expect(memory.items()[0].type).toBe('PROFILE')
  })

  it('searches with deterministic relevance and ranks a direct hit highest', async () => {
    const memory = new MemoryManager()
    memory.remember('My favorite color is teal', { type: 'PREFERENCE', importance: 0.8 })
    memory.remember('I use a mechanical keyboard', { type: 'FACT', importance: 0.5 })
    const hits = await memory.search('favorite color', { limit: 2 })
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0].score).toBeGreaterThan(0)
    expect(hits[0].item.content).toContain('favorite color')
  })

  it('returns nothing for an irrelevant query', async () => {
    const memory = new MemoryManager()
    memory.remember('My favorite color is teal')
    expect(await memory.search('quantum physics')).toEqual([])
  })

  it('gets, updates and removes a single item by id', () => {
    const memory = new MemoryManager()
    const item = memory.remember('I live in Berlin', { type: 'FACT' })
    expect(memory.get(item.id)?.content).toBe('I live in Berlin')

    const updated = memory.update(item.id, { importance: 0.95 })
    expect(updated?.importance).toBe(0.95)

    expect(memory.remove(item.id)).toBe(true)
    expect(memory.get(item.id)).toBeNull()
    expect(memory.count).toBe(0)
  })

  it('removes everything with removeMatching (substring terms)', () => {
    const memory = new MemoryManager()
    memory.remember('I use Linux daily')
    memory.remember('My name is Rex')
    expect(memory.removeMatching('linux')).toBe(1)
    expect(memory.items()).toHaveLength(1)
  })

  it('clears all items', () => {
    const memory = new MemoryManager()
    memory.remember('My name is Rex')
    memory.clear()
    expect(memory.count).toBe(0)
  })

  it('persists items so a new instance sees them (local storage reload)', () => {
    const a = new MemoryManager()
    a.remember('My name is Rex', { type: 'PROFILE', importance: 0.8 })

    const b = new MemoryManager()
    expect(b.items()).toHaveLength(1)
    expect(b.items()[0].content).toBe('My name is Rex')
    expect(b.items()[0].type).toBe('PROFILE')
  })

  it('exposes legacy note projections of all stored items', () => {
    const memory = new MemoryManager()
    memory.remember('My name is Rex', { type: 'PROFILE' })
    memory.addNote('The sky is blue')
    const notes = memory.notes()
    expect(notes).toHaveLength(2)
    expect(notes.some((n) => n.text.includes('Rex'))).toBe(true)
    expect(notes.some((n) => n.text.includes('sky'))).toBe(true)
  })

  it('updates profile and preferences and keeps them in the snapshot', () => {
    const memory = new MemoryManager()
    memory.updateProfile({ name: 'Samantha' })
    memory.updatePreferences({ voiceEnabled: false, volume: 0.4 })
    const snap = memory.snapshot()
    expect(snap.profile.name).toBe('Samantha')
    expect(snap.preferences.voiceEnabled).toBe(false)
    expect(snap.preferences.volume).toBe(0.4)
  })

  it('generates unique ids for distinct items', () => {
    const memory = new MemoryManager()
    const a = memory.remember('first fact')
    const b = memory.remember('second fact')
    expect(a.id).not.toBe(b.id)
    expect(a.id).toMatch(/^mem-/)
  })

  /* ------------------------------ embeddings (Phase 0.6C) ------------------------------ */

  it('embeds new memories when a real provider is configured', async () => {
    const memory = new MemoryManager(new EmbeddingManager({ provider: new FakeProvider() }))
    memory.remember('My name is Ada', { type: 'PROFILE' })
    await settle()
    const item = memory.items()[0]
    expect(item.embedding).toBeDefined()
    expect(item.embedding!.length).toBe(3)
  })

  it('skips embedding when skipEmbedding is requested', async () => {
    const memory = new MemoryManager(new EmbeddingManager({ provider: new FakeProvider() }))
    memory.remember('My name is Ada', { type: 'PROFILE', skipEmbedding: true })
    await settle()
    expect(memory.items()[0].embedding).toBeUndefined()
  })

  it('does not interrupt search when embedding generation fails', async () => {
    const provider = new FakeProvider()
    provider.state.fail = true
    const memory = new MemoryManager(new EmbeddingManager({ provider }))
    memory.remember('My favorite language is Python', { type: 'PREFERENCE', importance: 0.8 })
    await settle()
    expect(memory.items()[0].embedding).toBeUndefined()
    const hits = await memory.search('favorite language')
    expect(hits.length).toBeGreaterThanOrEqual(1)
  })

  it('update() drops the stale embedding on content change (no silent stale vector)', async () => {
    const memory = new MemoryManager(new EmbeddingManager({ provider: new FakeProvider() }))
    const item = memory.remember('My name is Alan', { type: 'PROFILE' })
    await settle()
    const before = memory.get(item.id)!
    expect(before.embedding).toBeDefined()

    const updated = memory.update(item.id, { content: 'My name is Grace' })
    expect(updated!.embedding).toBeUndefined()
    await settle()
    const after = memory.get(item.id)!
    expect(after.embedding).toBeDefined()
    expect(after.embedding).not.toEqual(before.embedding)
  })

  it('never keeps a stale embedding when regeneration fails', async () => {
    const provider = new FakeProvider()
    const memory = new MemoryManager(new EmbeddingManager({ provider }))
    const item = memory.remember('first content')
    await settle()
    expect(memory.get(item.id)!.embedding).toBeDefined()

    provider.state.fail = true
    memory.update(item.id, { content: 'totally different content' })
    expect(memory.get(item.id)!.embedding).toBeUndefined()
    await settle()
    expect(memory.get(item.id)!.embedding).toBeUndefined()
  })

  it('backfills embeddings for stored memories that lack one (resumable)', async () => {
    const provider = new FakeProvider()
    const memory = new MemoryManager(new EmbeddingManager({ provider }))
    memory.remember('kept secret: I code at night', { skipEmbedding: true })
    memory.remember('favorite OS is Linux', { skipEmbedding: true })
    memory.remember('I own a cat')
    await settle()

    const first = await memory.backfillEmbeddings()
    expect(first.total).toBe(3)
    expect(first.alreadyEmbedded).toBe(1)
    expect(first.successful).toBe(2)
    expect(first.failed).toBe(0)
    expect(memory.items().filter((i) => i.embedding)).toHaveLength(3)

    const second = await memory.backfillEmbeddings()
    expect(second.alreadyEmbedded).toBe(3)
    expect(second.processed).toBe(0)
    expect(second.successful).toBe(0)
  })

  it('replaces malformed persisted embeddings during backfill', async () => {
    const record = {
      version: 3,
      profile: { name: 'Operator', createdAt: new Date(0).toISOString(), version: '0.3.0' },
      preferences: {
        voiceEnabled: true,
        volume: 0.9,
        animationIntensity: 'high',
        reducedMotion: false,
        providerId: 'mock',
      },
      items: [
        {
          id: 'mem-malformed',
          type: 'FACT',
          content: 'I bike to work',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
          importance: 0.5,
          source: 'user',
          metadata: {},
          embedding: [],
        },
      ],
    }
    seedStorage(record)
    const memory = new MemoryManager(new EmbeddingManager({ provider: new FakeProvider() }))
    const result = await memory.backfillEmbeddings()
    expect(result.alreadyEmbedded).toBe(0)
    expect(result.successful).toBe(1)
    expect(memory.items()[0].embedding!.length).toBe(3)
  })

  it('backfill survives partial provider failures and reports them', async () => {
    const provider = new FakeProvider()
    const memory = new MemoryManager(
      new EmbeddingManager({ provider, maxRetries: 0, retryDelayMs: 0 }),
    )
    memory.remember('alpha memory', { skipEmbedding: true })
    memory.remember('beta memory', { skipEmbedding: true })
    memory.remember('gamma memory', { skipEmbedding: true })

    provider.state.fail = true
    const failed = await memory.backfillEmbeddings()
    expect(failed.total).toBe(3)
    expect(failed.failed).toBe(3)
    expect(failed.successful).toBe(0)
    expect(failed.errors).toHaveLength(3)
    expect(memory.items().filter((i) => i.embedding)).toHaveLength(0)

    provider.state.fail = false
    const retried = await memory.backfillEmbeddings()
    expect(retried.successful).toBe(3)
    expect(memory.items().filter((i) => i.embedding)).toHaveLength(3)
  })

  it('backfill reports everything skipped when embeddings are disabled', async () => {
    const provider = new FakeProvider()
    provider.state.configured = false
    const memory = new MemoryManager(new EmbeddingManager({ provider }))
    memory.remember('an unembedded fact')
    await settle()
    const result = await memory.backfillEmbeddings()
    expect(result.skipped).toBe(1)
    expect(result.successful).toBe(0)
    expect(memory.items()[0].embedding).toBeUndefined()
  })

  it('rememberSemantic merges near-duplicates instead of duplicating (real provider)', async () => {
    const provider = new FakeProvider()
    provider.vectorFor = (t) => (t.includes('coffee') ? [1, 0, 0] : [0, 1, 0])
    const memory = new MemoryManager(new EmbeddingManager({ provider }))

    const first = await memory.rememberSemantic('I love drinking coffee in the morning')
    expect(first.created).toBe(true)
    await settle()

    const dup = await memory.rememberSemantic('I love drinking coffee every morning')
    expect(dup.created).toBe(false)
    expect(dup.deduplicated).toBeDefined()
    expect(dup.item.id).toBe(first.item.id)
    expect(memory.count).toBe(1)

    const distinct = await memory.rememberSemantic('I prefer tea in the afternoon')
    expect(distinct.created).toBe(true)
    expect(memory.count).toBe(2)
  })

  it('semantic dedup is never applied through the deterministic provider', async () => {
    const memory = new MemoryManager() // default deterministic embedding manager
    const a = await memory.rememberSemantic('the quick brown fox jumps over the lazy dog')
    expect(a.created).toBe(true)
    const b = await memory.rememberSemantic('a quick brown fox jumps over a lazy dog')
    expect(b.created).toBe(true)
    expect(memory.count).toBe(2)
  })

  it('reports embedding health accurately (real vs deterministic fallback)', () => {
    const real = new MemoryManager(new EmbeddingManager({ provider: new FakeProvider() }))
    const h = real.getEmbeddingHealth()
    expect(h.enabled).toBe(true)
    expect(h.realEmbeddingsAvailable).toBe(true)
    expect(h.fallbackActive).toBe(false)
    expect(h.status).toBe('healthy')
    expect(h.providerId).toBe('fake-real')

    const det = new MemoryManager()
    const d = det.getEmbeddingHealth()
    expect(d.enabled).toBe(true)
    expect(d.realEmbeddingsAvailable).toBe(false)
    expect(d.fallbackActive).toBe(true)
    expect(d.providerId).toBe('deterministic-test')
  })

  it('loads legacy persisted blobs and backfills without losing data', async () => {
    const legacy = {
      version: 3,
      profile: { name: 'Operator', createdAt: new Date(0).toISOString(), version: '0.3.0' },
      preferences: {
        voiceEnabled: true,
        volume: 0.9,
        animationIntensity: 'high',
        reducedMotion: false,
        providerId: 'mock',
      },
      items: [
        {
          id: 'mem-legacy-1',
          type: 'FACT',
          content: 'I bike to work',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
          importance: 0.5,
          source: 'user',
          metadata: {},
        },
      ],
      notes: [{ id: 'note-legacy-1', text: 'The sky is blue', createdAt: '2020-01-01T00:00:00.000Z' }],
    }
    seedStorage(legacy)
    const memory = new MemoryManager(new EmbeddingManager({ provider: new FakeProvider() }))
    expect(memory.count).toBe(2)
    const result = await memory.backfillEmbeddings()
    expect(result.successful).toBe(2)
    expect(memory.items().filter((i) => i.embedding)).toHaveLength(2)
  })

  it('keeps embeddings intact across persistence reload', async () => {
    const provider = new FakeProvider()
    const memory = new MemoryManager(new EmbeddingManager({ provider }))
    memory.remember('a persistent fact')
    await settle()
    expect(memory.items()[0].embedding).toBeDefined()

    const reloaded = new MemoryManager(new EmbeddingManager({ provider }))
    expect(reloaded.count).toBe(1)
    expect(reloaded.items()[0].embedding).toBeDefined()
  })

  it('removing a memory also removes its embedding from persistence', async () => {
    const memory = new MemoryManager(new EmbeddingManager({ provider: new FakeProvider() }))
    memory.remember('to be forgotten')
    memory.remember('to be kept')
    await settle()
    const doomed = memory.items().find((i) => i.content === 'to be forgotten')!
    expect(memory.remove(doomed.id)).toBe(true)

    const reloaded = new MemoryManager(new EmbeddingManager({ provider: new FakeProvider() }))
    expect(reloaded.count).toBe(1)
    expect(reloaded.items()[0].content).toBe('to be kept')
    expect(reloaded.items()[0].embedding).toBeDefined()
  })

  /* ------------------------------ vector store (Phase 0.6D) ------------------------------ */

  it('records provider identity and dimensions with each embedded item', async () => {
    const store = new LocalStorageVectorStore('vt.provenance')
    const memory = new MemoryManager(
      new EmbeddingManager({ provider: new FakeProvider() }),
      store,
    )
    const item = memory.remember('I love coffee in the morning')
    await settle()
    expect(memory.get(item.id)!.metadata['embeddingProvider']).toBe('fake-real')
    expect(memory.get(item.id)!.metadata['embeddingDimensions']).toBe(3)
    const entry = store.get(item.id)!
    expect(entry.providerId).toBe('fake-real')
    expect(entry.dimensions).toBe(3)
    expect(entry.content).toBe('I love coffee in the morning')
  })

  it('keeps both embeddings when two remembers run back-to-back (async load race)', async () => {
    const store = new LocalStorageVectorStore('vt.race')
    const memory = new MemoryManager(new EmbeddingManager({ provider: bucketProvider() }), store)
    const first = memory.remember('I love coffee in the morning')
    const second = memory.remember('I own a cat')
    await settle()
    expect(memory.get(first.id)!.embedding).toEqual([1, 0, 0])
    expect(memory.get(second.id)!.embedding).toEqual([0, 1, 0])
    expect(store.entries().map((e) => e.id).sort()).toEqual(
      [first.id, second.id].sort(),
    )
  })

  it('embeds into the shared vector index so a second instance retrieves semantically', async () => {
    const provider = bucketProvider()

    // Instance A stores a memory and its vector lands in the shared index.
    const a = new MemoryManager(new EmbeddingManager({ provider }))
    a.remember('I love coffee in the morning')
    await settle()
    expect(a.vectorStoreDiagnostics().totalEntries).toBe(1)

    // Instance B has no lexical overlap ('java beans') but resolves the same
    // concept through the persisted vector store and finds A's memory.
    const b = new MemoryManager(new EmbeddingManager({ provider: bucketProvider() }))
    const hits = await b.search('morning java', { limit: 3 })
    expect(hits.length).toBe(1)
    expect(hits[0].item.content).toContain('coffee')
    expect(hits[0].score).toBeGreaterThan(0.5)
    expect(b.vectorStoreDiagnostics().totalEntries).toBe(1)
  })

  it('hydrates the vector index from the record on load (no process-local-only vectors)', async () => {
    const provider = bucketProvider()
    const a = new MemoryManager(new EmbeddingManager({ provider }))
    a.remember('I love coffee in the morning')
    await settle()

    const b = new MemoryManager(new EmbeddingManager({ provider: bucketProvider() }))
    const diagnostics = b.vectorStoreDiagnostics()
    expect(diagnostics.totalEntries).toBe(1)
    expect(diagnostics.validEntries).toBe(1)
    expect(diagnostics.providerIds).toContain('fake-real')
    expect(diagnostics.primaryDimensions).toBe(3)
    expect(diagnostics.missing).toBe(false)
  })

  it('removing a memory also removes its vector entry across instances', async () => {
    const a = new MemoryManager(new EmbeddingManager({ provider: bucketProvider() }))
    const coffee = a.remember('I love coffee in the morning')
    a.remember('I own a cat')
    await settle()
    expect(a.vectorStoreDiagnostics().totalEntries).toBe(2)

    expect(a.remove(coffee.id)).toBe(true)
    await settle()

    const b = new MemoryManager(new EmbeddingManager({ provider: bucketProvider() }))
    expect(b.vectorStoreDiagnostics().totalEntries).toBe(1)
    const bHits = await b.search('morning java')
    expect(bHits.some((h) => h.item.content.includes('coffee'))).toBe(false)
  })

  it('update() replaces the stale vector in the shared index', async () => {
    const store = new LocalStorageVectorStore('vt.update')
    const memory = new MemoryManager(new EmbeddingManager({ provider: bucketProvider() }), store)
    const item = memory.remember('I love coffee in the morning')
    await settle()
    expect(store.get(item.id)!.content).toBe('I love coffee in the morning')

    memory.update(item.id, { content: 'I own a cat' })
    await settle()
    const entry = store.get(item.id)!
    expect(entry.content).toBe('I own a cat')
    expect(entry.embedding).toEqual([0, 1, 0])
  })

  it('backfills replace missing vectors and feed the shared index', async () => {
    const provider = bucketProvider()
    const memory = new MemoryManager(new EmbeddingManager({ provider }))
    memory.remember('I love coffee in the morning', { skipEmbedding: true })
    await settle()
    expect(memory.vectorStoreDiagnostics().totalEntries).toBe(0)

    await memory.backfillEmbeddings()
    expect(memory.vectorStoreDiagnostics().totalEntries).toBe(1)
    expect(memory.items()[0].metadata['embeddingProvider']).toBe('fake-real')
  })

  it('survives a corrupted vector blob and self-heals it on search', async () => {
    const win = globalThis as {
      window: { localStorage: { setItem: (k: string, v: string) => void } }
    }
    win.window.localStorage.setItem('jarvis.memory.vectors', '!!corrupt!!{{')

    const memory = new MemoryManager(new EmbeddingManager({ provider: bucketProvider() }))
    expect(memory.vectorStoreDiagnostics().totalEntries).toBe(0)
    memory.remember('I love coffee in the morning')
    await settle()

    const hits = await memory.search('morning java')
    expect(hits.length).toBe(1)

    const reloaded = new MemoryManager(new EmbeddingManager({ provider: bucketProvider() }))
    expect(reloaded.vectorStoreDiagnostics().totalEntries).toBe(1)
    expect(reloaded.vectorStoreDiagnostics().missing).toBe(false)
  })

  it('keeps lexical-only search working and the index empty when embeddings are off', async () => {
    const provider = new FakeProvider()
    provider.state.configured = false
    const memory = new MemoryManager(new EmbeddingManager({ provider }))
    memory.remember('I love coffee in the morning')
    await settle()

    expect(memory.getEmbeddingHealth().enabled).toBe(false)
    expect(memory.vectorStoreDiagnostics().totalEntries).toBe(0)
    const hits = await memory.search('coffee')
    expect(hits.length).toBe(1)
    expect(hits[0].item.content).toContain('coffee')
  })

  it('never ranks a dimension-mismatched stored embedding as semantically relevant', async () => {
    seedStorage({
      version: 3,
      profile: { name: 'Operator', createdAt: new Date(0).toISOString(), version: '0.3.0' },
      preferences: {
        voiceEnabled: true,
        volume: 0.9,
        animationIntensity: 'high',
        reducedMotion: false,
        providerId: 'mock',
      },
      items: [
        {
          id: 'mem-5dim',
          type: 'FACT',
          content: 'five dimensional memory',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
          importance: 0.5,
          source: 'user',
          metadata: { embeddingProvider: 'old-model', embeddingDimensions: 5 },
          embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
        },
      ],
    })
    const memory = new MemoryManager(new EmbeddingManager({ provider: bucketProvider() }))
    // Query 'morning java' has no lexical overlap, and a bungled 3-vs-5
    // dimension cosine would give ~0.5 — a stale vector must NOT rank as
    // relevant, so the item stays out of the results entirely.
    expect(await memory.search('morning java')).toEqual([])
    // And its vector entry is excluded from index searches by dimension.
    const diagnostics = memory.vectorStoreDiagnostics()
    expect(diagnostics.totalEntries).toBe(1)
    expect(diagnostics.primaryDimensions).toBe(5)
  })
})

describe('MemoryManager secret boundary (FINAL CONVERGENCE)', () => {
  beforeEach(() => stubBrowserStorage())

  it('refuses high-confidence credentials at the write boundary — no caller can bypass', () => {
    const memory = new MemoryManager()
    expect(() => memory.remember('my password is hunter2')).toThrow(/credential/)
    expect(() => memory.remember('the api key is sk-abcdefghijklmnopqrstuvwxyz1234567890')).toThrow(/credential/)
    expect(() => memory.remember("client secret 'g9zXk2' for the OAuth app")).toThrow(/credential/)
    expect(memory.count).toBe(0)
  })

  it('covers update() content changes too', () => {
    const memory = new MemoryManager()
    const item = memory.remember('my favorite color is teal', { skipEmbedding: true })
    expect(() => memory.update(item.id, { content: 'my password is hunter2' })).toThrow(/credential/)
    expect(memory.get(item.id)!.content).toBe('my favorite color is teal')
  })

  it('refuses in async rememberSemantic (the memory tool path)', async () => {
    const memory = new MemoryManager()
    await expect(memory.rememberSemantic('my access token is sk-a1b2c3d4e5f6g7h8i9j0')).rejects.toThrow(/credential/)
    expect(memory.count).toBe(0)
  })

  it('prose that merely contains credential-adjacent words stays storable', () => {
    const memory = new MemoryManager()
    expect(() => memory.remember('kept secret: I code at night', { skipEmbedding: true })).not.toThrow()
    expect(() => memory.remember('I gave a talk about token-ring networks', { skipEmbedding: true })).not.toThrow()
    expect(memory.count).toBe(2)
  })

  it('nothing credential-like ever reaches persistent storage', () => {
    stubBrowserStorage()
    const memory = new MemoryManager()
    expect(() => memory.remember('my password is hunter2')).toThrow(/credential/)
    const raw = window.localStorage.getItem('jarvis.memory')
    // No write happened at all — the credential never hit the boundary.
    expect(raw).toBeNull()
  })
})