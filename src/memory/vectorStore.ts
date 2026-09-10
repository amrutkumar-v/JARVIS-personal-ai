/**
 * Vector Store — Phase 0.6D
 *
 * A persistent, dimension-aware companion index for semantic memory retrieval.
 *
 * Rationale
 * --------
 * The authoritative memory record (`MemoryManager` → `jarvis.memory`) stores
 * the embedding inline on each item. The vector store is a SEPARATE, also
 * persistent index keyed by memory id that lets any MemoryManager instance on
 * the same origin (separate tabs, hot reloads, fresh instances during a
 * session) resolve semantic similarity without re-scanning the record blob.
 *
 * Consistency contract
 * --------------------
 * - The memory RECORD remains the single source of truth.
 * - `reconcile()` hydrates the vector store from the authoritative record and
 *   drops entries that no longer correspond to an item (delete consistency).
 * - Every write path in MemoryManager syncs the index via `reconcile`, so a
 *   stale vector can never survive a content change or deletion.
 * - The store is dimension-aware: entries declare the provider id and the
 *   embedding dimensions used to create them, and search skips any entry whose
 *   vector length does not match the query — no cross-dimension cosine.
 *
 * Failure safety
 * --------------
 * - Missing storage (first run, SSR/node without localStorage) → empty store.
 * - Corrupt JSON, non-record shapes, malformed/degenerate entries → the bad
 *   bits are discarded (never thrown); the next persist self-heals the blob.
 * - The store never returns NaN and never participates in semantic-dedup
 *   decisions; it only rank orders candidates the caller already has.
 */

import { cosineSimilarity, normalizeSimilarity } from './vectorSimilarity'

/** A single persisted vector entry, keyed by a memory item id. */
export interface VectorEntry {
  /** Memory item id this vector belongs to. Never empty. */
  id: string
  /** Content snapshot that produced the embedding (diagnostics only). */
  content?: string
  /** The embedding vector (non-empty, all finite numbers). */
  embedding: number[]
  /** Provider id that generated the embedding. */
  providerId: string
  /** Expected embedding dimensions for this entry. */
  dimensions: number
  /** ISO timestamp of the last (re)write of this entry. */
  updatedAt: string
}

/** On-disk shape of the vector store (versioned, single storage key). */
export interface VectorStoreRecord {
  version: number
  entries: VectorEntry[]
  /** ISO timestamp of the last successful persist. */
  savedAt: string
}

/** A vector entry plus its similarity to a query. */
export interface RankedVector {
  entry: VectorEntry
  /** Raw cosine similarity in [-1, 1]. */
  similarity: number
  /** Similarity normalized to [0, 1] (same mapping as `normalizeSimilarity`). */
  score: number
}

export interface VectorSearchOptions {
  /** Cap the number of matches (default: all). */
  limit?: number
  /** Only return entries with normalized score >= this threshold (0..1). */
  minScore?: number
  /** Only scan entries written by this provider id. */
  providerId?: string
  /** Only scan entries with exactly this many dimensions. */
  dimensions?: number
}

export interface VectorSearchResult {
  /** Matches, ranked best-first. */
  matches: RankedVector[]
  /** Total entries in the store. */
  total: number
  /** Entries compatible with the query (valid, same dimensions). */
  scanned: number
  /** Entries skipped (invalid, provider/dimension mismatch, below minScore). */
  skipped: number
}

export interface VectorDiagnostics {
  /** Total stored entries. */
  totalEntries: number
  /** Entries that carry a usable (non-empty, finite) vector. */
  validEntries: number
  /** Provider ids present in the store. */
  providerIds: string[]
  /** Most common entry dimension (0 when empty). */
  primaryDimensions: number
  /** Storage key in use. */
  storageKey: string
  /** ISO timestamp of the last successful persist (null when never written). */
  lastSavedAt: string | null
  /** True when no persisted blob existed on the most recent load. */
  missing: boolean
}

/** A memory item-shaped input for `reconcile()` (subset of MemoryItem). */
export interface VectorStoreSourceItem {
  id: string
  content: string
  embedding?: number[]
  metadata?: Record<string, unknown>
  updatedAt?: string
}

/**
 * Storage-agnostic vector-index contract. The default implementation
 * (`LocalStorageVectorStore`) persists to one localStorage key; callers may
 * supply an alternative backing store behind the same interface.
 */
export interface VectorStore {
  /** Storage key (namespace) this store persists under. */
  readonly storageKey: string
  /** Hydrate from persistence. Fail-safe (never throws). Call once per store. */
  load(): void
  /** All entries (copies). */
  entries(): VectorEntry[]
  /** Fetch a single entry by id (or null). */
  get(id: string): VectorEntry | null
  /** Insert or replace the entry with this id. Persists. */
  upsert(entry: VectorEntry): VectorEntry
  /** Remove the entry with this id. Persists. Returns true when removed. */
  remove(id: string): boolean
  /** Remove all entries. Persists. */
  clear(): void
  /**
   * Make the store match the authoritative record. Adds/changes entries for
   * items that carry a valid embedding, removes entries whose id is gone or
   * whose embedding was dropped. Persists only when something changed.
   * Returns the number of changes made.
   */
  reconcile(items: VectorStoreSourceItem[]): number
  /** Rank the store's entries against a query embedding, best first. */
  search(query: readonly number[], options?: VectorSearchOptions): VectorSearchResult
  /** Status/debug summary for UI panels. */
  diagnostics(): VectorDiagnostics
}

export const VECTOR_STORE_VERSION = 1
export const DEFAULT_VECTOR_STORAGE_KEY = 'jarvis.memory.vectors'

/**
 * Resolve the vector storage key. `VITE_JARVIS_MEMORY_VECTOR_KEY` (follows the
 * existing `VITE_JARVIS_*` convention) overrides the default so several
 * namespaces can coexist; otherwise uses the built-in default key.
 */
export function defaultVectorStorageKey(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env
  const key = env?.['VITE_JARVIS_MEMORY_VECTOR_KEY']?.trim()
  return key || DEFAULT_VECTOR_STORAGE_KEY
}

/* ------------------------------------------------ helpers */

function isFiniteVector(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length === 0) return false
  for (const v of value) {
    if (!Number.isFinite(v)) return false
  }
  return true
}

function sameVector(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function copyEntry(entry: VectorEntry): VectorEntry {
  return { ...entry, embedding: [...entry.embedding] }
}

function getLocalStorage(): Storage | null {
  const win = (globalThis as { window?: { localStorage?: Storage } }).window
  return win?.localStorage ?? null
}

function emptyRecord(): VectorStoreRecord {
  return { version: VECTOR_STORE_VERSION, entries: [], savedAt: '' }
}

function sanitizeEntry(raw: unknown): VectorEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Partial<VectorEntry>
  if (typeof e.id !== 'string' || !e.id) return null
  if (!isFiniteVector(e.embedding)) return null
  const dimensions = Number(e.dimensions)
  return {
    id: e.id,
    content: typeof e.content === 'string' ? e.content : undefined,
    embedding: [...e.embedding],
    providerId: typeof e.providerId === 'string' && e.providerId ? e.providerId : 'unknown',
    dimensions: Number.isFinite(dimensions) && dimensions > 0 ? dimensions : e.embedding.length,
    updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date(0).toISOString(),
  }
}

/* ------------------------------------------------ implementation */

/** localStorage-backed vector index (one JSON blob per key). */
export class LocalStorageVectorStore implements VectorStore {
  readonly storageKey: string

  private record: VectorStoreRecord = emptyRecord()
  private missing = true

  constructor(storageKey: string = defaultVectorStorageKey()) {
    this.storageKey = storageKey
    this.load()
  }

  load(): void {
    const storage = getLocalStorage()
    if (!storage) {
      this.missing = true
      this.record = emptyRecord()
      return
    }
    let raw: string | null
    try {
      raw = storage.getItem(this.storageKey)
    } catch {
      raw = null
    }
    if (raw === null || raw === '') {
      this.missing = true
      this.record = emptyRecord()
      return
    }
    this.missing = false
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Corrupt blob — treat as empty; the next persist overwrites/self-heals.
      this.record = emptyRecord()
      return
    }
    const record = parsed as Partial<VectorStoreRecord>
    const entries: VectorEntry[] = []
    const rawEntries = Array.isArray(record.entries) ? record.entries : []
    for (const rawEntry of rawEntries) {
      const entry = sanitizeEntry(rawEntry)
      if (entry) entries.push(entry)
    }
    this.record = {
      version: VECTOR_STORE_VERSION,
      entries,
      savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
    }
  }

  entries(): VectorEntry[] {
    return this.record.entries.map(copyEntry)
  }

  get(id: string): VectorEntry | null {
    const entry = this.record.entries.find((e) => e.id === id)
    return entry ? copyEntry(entry) : null
  }

  upsert(entry: VectorEntry): VectorEntry {
    const clean = sanitizeEntry(entry)
    if (!clean) {
      throw new TypeError(
        `[vector-store] cannot store an invalid vector for id "${entry?.id ?? '?'}"`,
      )
    }
    const existingIndex = this.record.entries.findIndex((e) => e.id === clean.id)
    if (existingIndex >= 0) {
      this.record.entries[existingIndex] = clean
    } else {
      this.record.entries.push(clean)
    }
    this.persist()
    return copyEntry(clean)
  }

  remove(id: string): boolean {
    const before = this.record.entries.length
    this.record.entries = this.record.entries.filter((e) => e.id !== id)
    if (this.record.entries.length !== before) {
      this.persist()
      return true
    }
    return false
  }

  clear(): void {
    if (this.record.entries.length === 0) return
    this.record.entries = []
    this.persist()
  }

  reconcile(items: VectorStoreSourceItem[]): number {
    const keptIds = new Set<string>()
    let changes = 0
    const next: VectorEntry[] = []

    for (const item of items) {
      if (!isFiniteVector(item.embedding)) continue
      keptIds.add(item.id)
      const existing = this.record.entries.find((e) => e.id === item.id) ?? null
      const metadataDimensions = Number(item.metadata?.['embeddingDimensions'])
      const dimensions =
        Number.isFinite(metadataDimensions) && metadataDimensions > 0
          ? metadataDimensions
          : item.embedding.length
      const providerId =
        typeof item.metadata?.['embeddingProvider'] === 'string' &&
        item.metadata['embeddingProvider'] !== ''
          ? (item.metadata['embeddingProvider'] as string)
          : existing?.providerId ?? 'unknown'
      const content = typeof item.content === 'string' ? item.content : existing?.content
      const updatedAt =
        existing && sameVector(existing.embedding, item.embedding)
          ? existing.updatedAt
          : (item.updatedAt ?? new Date().toISOString())
      const entry: VectorEntry = {
        id: item.id,
        content,
        embedding: [...item.embedding],
        providerId,
        dimensions,
        updatedAt,
      }
      next.push(entry)
      if (
        !existing ||
        existing.providerId !== providerId ||
        existing.dimensions !== dimensions ||
        existing.updatedAt !== updatedAt ||
        !sameVector(existing.embedding, entry.embedding)
      ) {
        changes++
      }
    }

    for (const existing of this.record.entries) {
      if (!keptIds.has(existing.id)) changes++
    }

    this.record.entries = next
    if (changes > 0) this.persist()
    return changes
  }

  search(query: readonly number[], options: VectorSearchOptions = {}): VectorSearchResult {
    const { limit, minScore, providerId, dimensions } = options
    if (!isFiniteVector(query)) {
      return {
        matches: [],
        total: this.record.entries.length,
        scanned: 0,
        skipped: this.record.entries.length,
      }
    }

    const matches: RankedVector[] = []
    let scanned = 0
    let skipped = 0

    for (const entry of this.record.entries) {
      if (!isFiniteVector(entry.embedding)) {
        skipped++
        continue
      }
      if (entry.embedding.length !== query.length) {
        skipped++
        continue
      }
      if (providerId !== undefined && entry.providerId !== providerId) {
        skipped++
        continue
      }
      if (dimensions !== undefined && entry.dimensions !== dimensions) {
        skipped++
        continue
      }
      scanned++
      const similarity = cosineSimilarity(query, entry.embedding)
      const score = normalizeSimilarity(similarity)
      if (minScore !== undefined && score < minScore) {
        skipped++
        continue
      }
      matches.push({ entry: copyEntry(entry), similarity, score })
    }

    matches.sort((a, b) => b.similarity - a.similarity)
    const selected = limit !== undefined && limit >= 0 ? matches.slice(0, limit) : matches

    return { matches: selected, total: this.record.entries.length, scanned, skipped }
  }

  diagnostics(): VectorDiagnostics {
    const entries = this.record.entries
    const validEntries = entries.filter((e) => isFiniteVector(e.embedding)).length
    const providerIds = [...new Set(entries.map((e) => e.providerId))]
    const dimCounts = new Map<number, number>()
    let primaryDimensions = 0
    let bestCount = 0
    for (const e of entries) {
      const count = (dimCounts.get(e.dimensions) ?? 0) + 1
      dimCounts.set(e.dimensions, count)
      if (count > bestCount) {
        bestCount = count
        primaryDimensions = e.dimensions
      }
    }
    return {
      totalEntries: entries.length,
      validEntries,
      providerIds,
      primaryDimensions,
      storageKey: this.storageKey,
      lastSavedAt: this.record.savedAt || null,
      missing: this.missing,
    }
  }

  persist(): boolean {
    const storage = getLocalStorage()
    if (!storage) return false
    try {
      const savedAt = new Date().toISOString()
      storage.setItem(this.storageKey, JSON.stringify({ ...this.record, savedAt } satisfies VectorStoreRecord))
      this.record = { ...this.record, savedAt }
      return true
    } catch (error) {
      console.warn('[vector-store] persist failed', error)
      return false
    }
  }
}