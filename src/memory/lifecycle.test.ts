import { describe, expect, it, beforeEach } from 'vitest'
import { MemoryManager, DEFAULT_PROFILE, DEFAULT_PREFERENCES } from '../memory/MemoryManager'
import type { MemoryItem } from '../memory/MemoryManager'
import { EmbeddingManager } from './embeddingManager'
import type { EmbeddingProvider, EmbeddingVector, ProviderHealth } from './embeddings'
import {
  itemAgeDays,
  isStaleCandidate,
  overflowCandidates,
  archiveCandidates,
  isLifecycleDue,
  defaultLifecycleConfig,
  DEFAULT_LIFECYCLE_CONFIG,
  type LifecycleConfig,
} from './lifecycle'

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

function seedStorage(record: unknown): void {
  const win = globalThis as {
    window: { localStorage: { setItem: (k: string, v: string) => void } }
  }
  win.window.localStorage.setItem('jarvis.memory', JSON.stringify(record))
}

const DAY = 86_400_000
const NOW = Date.parse('2026-01-01T00:00:00Z')

function makeItem(overrides: Partial<MemoryItem> & { content: string }): MemoryItem {
  return {
    id: overrides.id ?? `mem-${overrides.content}`,
    type: overrides.type ?? 'FACT',
    content: overrides.content,
    createdAt: overrides.createdAt ?? new Date(NOW).toISOString(),
    updatedAt: overrides.updatedAt ?? new Date(NOW).toISOString(),
    importance: overrides.importance ?? 0.5,
    source: overrides.source ?? 'user',
    metadata: overrides.metadata ?? {},
    embedding: overrides.embedding,
  }
}

function seedItems(items: MemoryItem[]): void {
  seedStorage({
    version: 4,
    profile: { ...DEFAULT_PROFILE },
    preferences: { ...DEFAULT_PREFERENCES },
    items,
    archive: [],
    episodes: {},
    lifecycle: {},
  })
}

describe('memory lifecycle (pure helpers)', () => {
  it('computes age in whole days from updatedAt', () => {
    const old = makeItem({ content: 'old thing', updatedAt: new Date(NOW - 400 * DAY).toISOString() })
    expect(itemAgeDays(old, NOW)).toBeCloseTo(400, 5)
  })

  it('treats malformed timestamps as fresh (age 0)', () => {
    const bad = makeItem({ content: 'no date', updatedAt: 'garbage' })
    expect(itemAgeDays(bad, NOW)).toBe(0)
  })

  it('flags stale candidates only when old, low-importance and enabled', () => {
    const cfg: LifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, forgetAfterDays: 365 }
    const old = makeItem({ content: 'old fact', importance: 0.4, updatedAt: new Date(NOW - 400 * DAY).toISOString() })
    const fresh = makeItem({ content: 'fresh fact', importance: 0.2 })
    const protectedItem = makeItem({ content: 'important', importance: 0.9, updatedAt: new Date(NOW - 400 * DAY).toISOString() })
    const mid = makeItem({ content: 'mid', importance: 0.6, updatedAt: new Date(NOW - 400 * DAY).toISOString() })

    expect(isStaleCandidate(old, NOW, cfg)).toBe(true)
    expect(isStaleCandidate(fresh, NOW, cfg)).toBe(false)
    expect(isStaleCandidate(protectedItem, NOW, cfg)).toBe(false)
    expect(isStaleCandidate(mid, NOW, cfg)).toBe(false)
    expect(isStaleCandidate(old, NOW, { ...cfg, enabled: false })).toBe(false)
  })

  it('archives overflow by lowest importance first', () => {
    const cfg: LifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, maxItems: 1 }
    const a = makeItem({ content: 'a', importance: 0.1 })
    const b = makeItem({ content: 'b', importance: 0.9 })
    const c = makeItem({ content: 'c', importance: 0.5 })
    const excess = overflowCandidates([a, b, c], NOW, cfg)
    expect(excess.map((i) => i.content)).toEqual(['a', 'c'])
  })

  it('never archives a protected item if an unprotected excess exists', () => {
    const cfg: LifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, maxItems: 1 }
    const p = makeItem({ content: 'protected', importance: 0.9 })
    const u = makeItem({ content: 'unprotected', importance: 0.1 })
    const excess = overflowCandidates([p, u], NOW, cfg)
    expect(excess.map((i) => i.content)).toEqual(['unprotected'])
  })

  it('uses protected items only when everything is protected', () => {
    const cfg: LifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, maxItems: 1 }
    const p1 = makeItem({ content: 'p1', importance: 0.9 })
    const p2 = makeItem({ content: 'p2', importance: 0.85 })
    const excess = overflowCandidates([p1, p2], NOW, cfg)
    expect(excess).toHaveLength(1)
  })

  it('archiveCandidates is a stable stale-then-overflow union', () => {
    const cfg: LifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, forgetAfterDays: 365, maxItems: 1 }
    const stale = makeItem({ content: 'stale', importance: 0.1, updatedAt: new Date(NOW - 400 * DAY).toISOString() })
    const meh = makeItem({ content: 'meh', importance: 0.1 })
    const hero = makeItem({ content: 'hero', importance: 0.9 })
    const candidates = archiveCandidates([stale, meh, hero], NOW, cfg)
    expect(candidates.map((c) => c.item.content)).toEqual(['stale', 'meh'])
    expect(candidates[0].reason).toBe('stale')
    expect(candidates[1].reason).toBe('overflow')
  })

  it('archiveCandidates returns nothing when disabled', () => {
    expect(archiveCandidates([makeItem({ content: 'x', importance: 0.1 })], NOW, { ...DEFAULT_LIFECYCLE_CONFIG, enabled: false })).toEqual([])
  })

  it('isLifecycleDue respects the interval and a null last run', () => {
    expect(isLifecycleDue(undefined, NOW, DEFAULT_LIFECYCLE_CONFIG)).toBe(true)
    expect(isLifecycleDue(new Date(NOW - 1).toISOString(), NOW, DEFAULT_LIFECYCLE_CONFIG)).toBe(false)
    expect(isLifecycleDue(new Date(NOW - 8 * DAY).toISOString(), NOW, DEFAULT_LIFECYCLE_CONFIG)).toBe(true)
    const last = new Date(NOW - 8 * DAY).toISOString()
    expect(isLifecycleDue(last, NOW, { ...DEFAULT_LIFECYCLE_CONFIG, enabled: false })).toBe(false)
  })

  it('defaultLifecycleConfig reads env overrides and falls back to defaults', () => {
  const cfg = defaultLifecycleConfig({
    VITE_JARVIS_MEMORY_LIFECYCLE_ENABLED: 'false',
    VITE_JARVIS_MEMORY_FORGET_AFTER_DAYS: '120',
  })
  expect(cfg.enabled).toBe(false)
  expect(cfg.forgetAfterDays).toBe(120)
  expect(cfg.importanceFloor).toBe(DEFAULT_LIFECYCLE_CONFIG.importanceFloor)

  const empty = defaultLifecycleConfig({})
  expect(empty.enabled).toBe(DEFAULT_LIFECYCLE_CONFIG.enabled)
  expect(empty.forgetAfterDays).toBe(DEFAULT_LIFECYCLE_CONFIG.forgetAfterDays)
})
})

describe('MemoryManager lifecycle (0.7)', () => {
  beforeEach(() => stubBrowserStorage())

  it('archives stale low-importance items and keeps protected ones', () => {
    seedItems([
      makeItem({ content: 'stale note', importance: 0.4, updatedAt: new Date(NOW - 400 * DAY).toISOString() }),
      makeItem({ content: 'protected profile', importance: 0.9, updatedAt: new Date(NOW - 400 * DAY).toISOString() }),
    ])
    const memory = new MemoryManager()
    const report = memory.runLifecycle(undefined, NOW)

    expect(report.archivedCount).toBe(1)
    expect(report.archived[0].content).toBe('stale note')
    expect(report.archived[0].archivedReason).toBe('stale')
    expect(memory.items()).toHaveLength(1)
    expect(memory.items()[0].content).toBe('protected profile')
    expect(memory.archivedItems()).toHaveLength(1)
  })

  it('reports nothing when the lifecycle is disabled', () => {
    seedItems([makeItem({ content: 'old', importance: 0.1, updatedAt: new Date(NOW - 400 * DAY).toISOString() })])
    const memory = new MemoryManager()
    const report = memory.runLifecycle({ enabled: false }, NOW)
    expect(report.archivedCount).toBe(0)
    expect(memory.items()).toHaveLength(1)
  })

  it('archives overflow beyond maxItems', () => {
    seedItems([
      makeItem({ content: 'a', importance: 0.1 }),
      makeItem({ content: 'b', importance: 0.5 }),
      makeItem({ content: 'c', importance: 0.9 }),
    ])
    const memory = new MemoryManager()
    const report = memory.runLifecycle({ maxItems: 1 }, NOW)
    expect(report.archivedCount).toBe(2)
    expect(report.kept).toBe(1)
  })

  it('restores an archived memory back into the active set', () => {
    seedItems([makeItem({ content: 'stored thing', importance: 0.2, updatedAt: new Date(NOW - 400 * DAY).toISOString() })])
    const memory = new MemoryManager()
    memory.runLifecycle(undefined, NOW)
    const archived = memory.archivedItems()
    expect(archived).toHaveLength(1)

    memory.restoreMemory(archived[0].id)
    expect(memory.archivedItems()).toHaveLength(0)
    expect(memory.items()).toHaveLength(1)
    expect(memory.items()[0].content).toBe('stored thing')
  })

  it('restoreMemory is a no-op for unknown ids', () => {
    const memory = new MemoryManager()
    expect(memory.restoreMemory('nope')).toBe(false)
  })

  it('expungeArchived purges everything without a cutoff, or only older than one', () => {
    const nowIso = new Date(NOW).toISOString()
    const oldIso = new Date(NOW - 360 * DAY).toISOString()
    seedStorage({
      version: 4,
      profile: { ...DEFAULT_PROFILE },
      preferences: { ...DEFAULT_PREFERENCES },
      items: [],
      archive: [
        { id: 'recent', type: 'FACT', content: 'recent', createdAt: nowIso, updatedAt: nowIso, importance: 0.1, source: 'user', metadata: {}, archivedAt: nowIso, archivedReason: 'stale' },
        { id: 'older', type: 'FACT', content: 'older', createdAt: oldIso, updatedAt: oldIso, importance: 0.1, source: 'user', metadata: {}, archivedAt: oldIso, archivedReason: 'stale' },
      ],
      episodes: {},
      lifecycle: {},
    })
    const memory = new MemoryManager()
    expect(memory.archivedItems()).toHaveLength(2)

    // Keep everything archived at/after the cutoff; purge only the older.
    expect(memory.expungeArchived(new Date(NOW - 350 * DAY).toISOString())).toBe(1)
    expect(memory.archivedItems()).toHaveLength(1)
    expect(memory.archivedItems()[0].content).toBe('recent')

    expect(memory.expungeArchived()).toBe(1)
    expect(memory.archivedItems()).toHaveLength(0)
  })

  it('persists lifecycle bookkeeping so consolidation is not re-run immediately', () => {
    const memory = new MemoryManager()
    expect(memory.isLifecycleDue()).toBe(true)
    memory.runLifecycle(undefined, NOW)
    expect(memory.isLifecycleDue(NOW + 1)).toBe(false)
    expect(memory.isLifecycleDue(NOW + DEFAULT_LIFECYCLE_CONFIG.intervalMs)).toBe(true)

    // A reloaded manager reads the same record and stays "not due".
    const reloaded = new MemoryManager()
    expect(reloaded.isLifecycleDue(NOW + 1)).toBe(false)
  })

  it('keeps the vector store consistent when an item is archived and restored', async () => {
    const memory = new MemoryManager(new EmbeddingManager({ provider: bucketProvider() }))
    memory.rememberSemantic('I love coffee', { importance: 0.4 })
    await settle()

    const before = await memory.search('morning java')
    expect(before).toHaveLength(1)

    memory.runLifecycle({ forgetAfterDays: 0 }, NOW)
    const afterArchive = await memory.search('morning java')
    expect(afterArchive).toHaveLength(0)

    const archived = memory.archivedItems()
    expect(archived).toHaveLength(1)
    memory.restoreMemory(archived[0].id)
    const afterRestore = await memory.search('morning java')
    expect(afterRestore).toHaveLength(1)
  })
})

/** Deterministic, content-dependent 3-dim vector (never touches the network). */
function contentVector(content: string): number[] {
  let h = 5381
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h) ^ content.charCodeAt(i)
  }
  const x = h >>> 0
  return [(x % 200) / 100, ((x >> 8) % 200) / 100, ((x >> 16) % 200) / 100]
}

class FakeProvider implements EmbeddingProvider {
  readonly id = 'fake-lc'
  readonly label = 'Fake Lifecycle Embeddings'
  readonly dimensions = 3
  state = { configured: true, fail: false }
  vectorFor = (text: string): number[] => {
    if (/coffee|java/.test(text)) return [1, 0, 0]
    if (/cat/.test(text)) return [0, 1, 0]
    return contentVector(text)
  }

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
      lastError: undefined,
    }
  }
}

async function settle(ms = 5): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

function bucketProvider(): FakeProvider {
  return new FakeProvider()
}