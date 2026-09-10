import { describe, expect, it, beforeEach } from 'vitest'
import {
  LocalStorageVectorStore,
  defaultVectorStorageKey,
  VECTOR_STORE_VERSION,
} from '../memory/vectorStore'
import { hybridScore, hybridScoreFromSimilarity, semanticScore } from '../memory/hybridRanking'
import { tokenize } from '../utils/text'
import type { MemoryItem } from '../memory/MemoryManager'

/**
 * In-memory window/localStorage so the store can persist in node.
 */
function stubBrowserStorage(): void {
  const backing = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  ;(globalThis as Record<string, unknown>).window = { localStorage }
}

function readRaw(key: string): string | null {
  const win = globalThis as { window: { localStorage: { getItem: (k: string) => string | null } } }
  return win.window.localStorage.getItem(key)
}

function seedRaw(key: string, raw: string): void {
  const win = globalThis as { window: { localStorage: { setItem: (k: string, v: string) => void } } }
  win.window.localStorage.setItem(key, raw)
}

const entry = (
  id: string,
  embedding: number[],
  overrides: Partial<Parameters<LocalStorageVectorStore['upsert']>[0]> = {},
) => ({ id, content: `content of ${id}`, embedding, providerId: 'fake-real', dimensions: 3, updatedAt: '2020-01-01T00:00:00.000Z', ...overrides })

const rankedIds = (result: ReturnType<LocalStorageVectorStore['search']>) =>
  result.matches.map((m) => m.entry.id)

describe('VectorStore (Phase 0.6D)', () => {
  beforeEach(() => stubBrowserStorage())

  it('starts empty and reports missing when no blob exists (first run)', () => {
    const store = new LocalStorageVectorStore('test.v1')
    expect(store.entries()).toEqual([])
    const d = store.diagnostics()
    expect(d.missing).toBe(true)
    expect(d.totalEntries).toBe(0)
    expect(d.validEntries).toBe(0)
  })

  it('uses the default storage key from the VITE env convention', () => {
    expect(defaultVectorStorageKey()).toBe('jarvis.memory.vectors')
  })

  it('upserts and reads entries back', () => {
    const store = new LocalStorageVectorStore('test.v1')
    store.upsert(entry('a', [1, 0, 0]))
    expect(store.get('a')?.embedding).toEqual([1, 0, 0])
    expect(store.entries()).toHaveLength(1)
  })

  it('upserts the same id without duplicating (upsert = insert or replace)', () => {
    const store = new LocalStorageVectorStore('test.v1')
    store.upsert(entry('a', [1, 0, 0]))
    const updated = entry('a', [0, 1, 0], { content: 'better content' })
    store.upsert(updated)
    expect(store.entries()).toHaveLength(1)
    expect(store.get('a')?.embedding).toEqual([0, 1, 0])
    expect(store.get('a')?.content).toBe('better content')
  })

  it('rejects an invalid vector on upsert', () => {
    const store = new LocalStorageVectorStore('test.v1')
    expect(() => store.upsert(entry('a', []))).toThrow(TypeError)
    expect(() => store.upsert(entry('a', [1, Number.NaN, 0]))).toThrow(TypeError)
    expect(store.entries()).toHaveLength(0)
  })

  it('removes a single entry and clears all', () => {
    const store = new LocalStorageVectorStore('test.v1')
    store.upsert(entry('a', [1, 0, 0]))
    store.upsert(entry('b', [0, 1, 0]))
    expect(store.remove('a')).toBe(true)
    expect(store.remove('missing')).toBe(false)
    expect(store.entries().map((e) => e.id)).toEqual(['b'])
    store.clear()
    expect(store.entries()).toHaveLength(0)
  })

  it('persists across store instances sharing the same key (cross-instance)', () => {
    const a = new LocalStorageVectorStore('test.shared')
    a.upsert(entry('a', [1, 0, 0]))

    const b = new LocalStorageVectorStore('test.shared')
    expect(b.get('a')?.embedding).toEqual([1, 0, 0])
    expect(b.diagnostics().missing).toBe(false)
  })

  it('isolates different storage keys', () => {
    const a = new LocalStorageVectorStore('test.ns-a')
    a.upsert(entry('a', [1, 0, 0]))
    const b = new LocalStorageVectorStore('test.ns-b')
    expect(b.entries()).toEqual([])
  })

  it('treats a corrupt blob as empty without throwing (self-healing)', () => {
    seedRaw('test.corrupt', 'not-json{{{')
    const store = new LocalStorageVectorStore('test.corrupt')
    expect(store.entries()).toEqual([])
    expect(store.diagnostics().missing).toBe(false)

    store.upsert(entry('a', [1, 0, 0]))
    const reloaded = new LocalStorageVectorStore('test.corrupt')
    expect(reloaded.get('a')?.embedding).toEqual([1, 0, 0])
  })

  it('drops malformed entries when loading a structured-but-bad blob', () => {
    seedRaw(
      'test.malformed',
      JSON.stringify({
        version: 1,
        entries: [
          entry('ok', [1, 0, 0]),
          { id: 'no-vector' },
          { id: 'empty', embedding: [] },
          { id: 'nan', embedding: [1, Number.NaN, 0] },
          { id: 42, embedding: [1, 2, 3] },
          'garbage',
        ],
        savedAt: '2020-01-01T00:00:00.000Z',
      }),
    )
    const store = new LocalStorageVectorStore('test.malformed')
    expect(store.entries().map((e) => e.id)).toEqual(['ok'])
  })

  it('treats a non-record JSON shape as empty', () => {
    seedRaw('test.badshape', JSON.stringify([1, 2, 3]))
    const store = new LocalStorageVectorStore('test.badshape')
    expect(store.entries()).toEqual([])
  })

  it('ranks compatible entries and skips dimension-mismatched ones', () => {
    const store = new LocalStorageVectorStore('test.v1')
    store.upsert(entry('same', [1, 1, 1]))
    store.upsert(entry('opposite', [-1, -1, -1]))
    store.upsert(entry('short', [1, 1]))
    store.upsert(entry('long', [1, 1, 1, 1]))

    const result = store.search([1, 1, 1])
    expect(rankedIds(result)).toEqual(['same', 'opposite'])
    expect(result.scanned).toBe(2)
    expect(result.skipped).toBe(2)
    expect(result.total).toBe(4)
    expect(result.matches[0].similarity).toBeCloseTo(1, 5)
    expect(result.matches[0].score).toBeCloseTo(1, 5)
    expect(result.matches[1].score).toBeCloseTo(0, 5)
  })

  it('applies limit and minScore on normalized scores', () => {
    const store = new LocalStorageVectorStore('test.v1')
    store.upsert(entry('same', [1, 1, 1]))
    store.upsert(entry('orth', [1, -1, 1]))

    expect(rankedIds(store.search([1, 1, 1], { limit: 1 }))).toEqual(['same'])
    expect(rankedIds(store.search([1, 1, 1], { minScore: 0.9 }))).toEqual(['same'])
    expect(rankedIds(store.search([1, 1, 1], { minScore: 0.9, limit: 1 }))).toEqual(['same'])
    expect(rankedIds(store.search([1, 1, 1], { minScore: 0.95, limit: 3 }))).toEqual(['same'])
  })

  it('accepts providerId and dimensions filters', () => {
    const store = new LocalStorageVectorStore('test.v1')
    store.upsert(entry('fake-a', [1, 0, 0], { providerId: 'fake-real' }))
    store.upsert(entry('fake-b', [1, 0, 0], { providerId: 'other-llm' }))
    expect(rankedIds(store.search([1, 0, 0], { providerId: 'fake-real' }))).toEqual(['fake-a'])
    expect(rankedIds(store.search([1, 0, 0], { dimensions: 3 }))).toEqual(['fake-a', 'fake-b'])
    expect(rankedIds(store.search([1, 0, 0], { dimensions: 5 }))).toEqual([])
  })

  it('returns an empty result for an invalid query vector', () => {
    const store = new LocalStorageVectorStore('test.v1')
    store.upsert(entry('a', [1, 0, 0]))
    expect(store.search([Number.NaN, 0, 0]).matches).toEqual([])
    expect(store.search([]).matches).toEqual([])
    expect(store.search([0, 0, 0], { providerId: 'x' }).skipped).toBe(1)
  })

  it('reconcile hydrates, updates and drops to match the authoritative record', () => {
    const store = new LocalStorageVectorStore('test.v1')
    store.upsert(entry('stale', [1, 0, 0]))

    const changes = store.reconcile([
      { id: 'new', content: 'brand new', embedding: [0, 1, 0], metadata: { embeddingProvider: 'fake-real', embeddingDimensions: 3 } },
      { id: 'changed', content: 'changed content', embedding: [0, 0, 1], metadata: { embeddingProvider: 'fake-real', embeddingDimensions: 3 } },
    ])
    expect(changes).toBeGreaterThan(0)
    expect(store.entries().map((e) => e.id).sort()).toEqual(['changed', 'new'])
    expect(store.get('stale')).toBeNull()

    // Second reconcile with identical input is a no-op (0 changes).
    const again = store.reconcile([
      { id: 'new', content: 'brand new', embedding: [0, 1, 0], metadata: { embeddingProvider: 'fake-real', embeddingDimensions: 3 } },
      { id: 'changed', content: 'changed content', embedding: [0, 0, 1], metadata: { embeddingProvider: 'fake-real', embeddingDimensions: 3 } },
    ])
    expect(again).toBe(0)
  })

  it('reconcile removes entries whose embedding was dropped (delete/update consistency)', () => {
    const store = new LocalStorageVectorStore('test.v1')
    store.upsert(entry('keep', [1, 0, 0]))
    store.upsert(entry('gone', [0, 1, 0]))
    store.reconcile([{ id: 'keep', content: 'kept', embedding: [1, 0, 0] }])
    expect(store.entries().map((e) => e.id)).toEqual(['keep'])
  })

  it('reconcile records provider/dimension provenance and keeps timestamps stable', () => {
    const store = new LocalStorageVectorStore('test.v1')
    store.reconcile([
      { id: 'a', content: 'x', embedding: [1, 0, 0], metadata: { embeddingProvider: 'openai-embeddings', embeddingDimensions: 3 }, updatedAt: '2020-01-02T00:00:00.000Z' },
    ])
    const got = store.get('a')!
    expect(got.providerId).toBe('openai-embeddings')
    expect(got.dimensions).toBe(3)
    expect(got.updatedAt).toBe('2020-01-02T00:00:00.000Z')
  })

  it('reconcile survives items missing provenance metadata (unknown provider, dims from vector)', () => {
    const store = new LocalStorageVectorStore('test.v1')
    store.reconcile([{ id: 'legacy', content: 'old', embedding: [1, 0, 0] }])
    const got = store.get('legacy')!
    expect(got.providerId).toBe('unknown')
    expect(got.dimensions).toBe(3)
  })

  it('reports diagnostics for the current entries', () => {
    const store = new LocalStorageVectorStore('test.v1')
    store.upsert(entry('a', [1, 0, 0], { providerId: 'fake-real' }))
    store.upsert(entry('b', [0, 1, 0, 0], { providerId: 'other-llm', dimensions: 4 }))
    const d = store.diagnostics()
    expect(d.totalEntries).toBe(2)
    expect(d.validEntries).toBe(2)
    expect(d.providerIds).toEqual(expect.arrayContaining(['fake-real', 'other-llm']))
    expect(d.primaryDimensions).toBe(3)
    expect(d.storageKey).toBe('test.v1')
    expect(d.lastSavedAt).not.toBeNull()
  })

  it('reports zero primary dimensions for an empty store', () => {
    const store = new LocalStorageVectorStore('test.empty')
    expect(store.diagnostics().primaryDimensions).toBe(0)
    expect(store.diagnostics().lastSavedAt).toBeNull()
  })

  it('writes a versioned, parseable blob to storage', () => {
    const store = new LocalStorageVectorStore('test.v1')
    store.upsert(entry('a', [1, 0, 0]))
    const raw = JSON.parse(readRaw('test.v1')!) as { version: number; entries: unknown[] }
    expect(raw.version).toBe(VECTOR_STORE_VERSION)
    expect(raw.entries).toHaveLength(1)
  })

  it('hybridScoreFromSimilarity reproduces hybridScore for inline semanticScore', () => {
    const item: MemoryItem = {
      id: 'm1',
      type: 'FACT',
      content: 'I love coffee in the morning',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      importance: 0.7,
      source: 'user',
      metadata: {},
      embedding: [1, 0, 0],
    }
    const query = [1, 0, 0]
    const tokens = tokenize('morning java')
    const needle = new Set(tokens)
    const now = Date.now()
    const viaInline = hybridScore(item, query, tokens, needle, now)
    const viaSimilarity = hybridScoreFromSimilarity(item, semanticScore(item, query), tokens, needle, now)
    expect(viaSimilarity).toBeCloseTo(viaInline, 10)
    expect(viaSimilarity).toBeGreaterThanOrEqual(0)
    expect(viaSimilarity).toBeLessThanOrEqual(1)
  })

  it('hybridScoreFromSimilarity clamps out-of-range similarity values', () => {
    const item: MemoryItem = {
      id: 'm2',
      type: 'FACT',
      content: 'unrelated forever',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      importance: 0.2,
      source: 'user',
      metadata: {},
    }
    const tokens = tokenize('x y z')
    const needle = new Set(tokens)
    const now = Date.now()
    // Similarity is clamped to its allowed [0, 1] range, so out-of-range
    // inputs contribute identical (not overflowing) scores and never escape
    // the final [0, 1] result.
    expect(hybridScoreFromSimilarity(item, 5, tokens, needle, now)).toBe(
      hybridScoreFromSimilarity(item, 1, tokens, needle, now),
    )
    expect(hybridScoreFromSimilarity(item, -3, tokens, needle, now)).toBe(
      hybridScoreFromSimilarity(item, 0, tokens, needle, now),
    )
    expect(hybridScoreFromSimilarity(item, Number.NaN, tokens, needle, now)).toBe(
      hybridScoreFromSimilarity(item, 0, tokens, needle, now),
    )
    for (const input of [5, -3, Number.NaN]) {
      const score = hybridScoreFromSimilarity(item, input, tokens, needle, now)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })
})