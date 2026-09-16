/**
 * Memory architecture — JARVIS persistent long-term memory.
 *
 * Phase 0.3 introduces a structured memory model (PROFILE / PREFERENCE / FACT
 * / NOTE) behind the same `Store` abstraction. The backing store is
 * localStorage for now — explicitly LOCAL persistent memory — but the
 * abstraction is ready to be swapped for SQLite / IndexedDB / Supabase /
 * a vector database / a cloud memory service later without touching the
 * assistant, tools or engine.
 *
 * All persistence flows through `MemoryManager`; UI and tools never touch raw
 * storage directly.
 */

import { tokenize } from '../utils/text'
import { looksLikeHighRiskCredential } from './detect'
import {
  hybridScoreFromSimilarity,
  semanticScore,
  DEFAULT_HYBRID_CONFIG,
  type HybridRankingConfig,
} from './hybridRanking'
import type { ProviderHealthStatus } from './embeddings'
import {
  EmbeddingManager,
  getDefaultEmbeddingManager,
  type BackfillResult,
} from './embeddingManager'
import {
  LocalStorageVectorStore,
  type VectorStore,
  type VectorDiagnostics,
} from './vectorStore'
import {
  defaultLifecycleConfig,
  archiveCandidates,
  isLifecycleDue,
  type ArchivedMemory,
  type LifecycleConfig,
  type LifecycleReport,
} from './lifecycle'
import {
  episodeIdOf,
  tagWithEpisode,
  validateEpisode,
  withIncrementedCount,
  type Episode,
} from './episodes'

export interface Store<K extends string, T> {
  read(key: K): T | null
  write(key: K, value: T): boolean
  remove(key: K): boolean
}

export interface Profile {
  name: string
  createdAt: string
  version: string
}

export interface UserPreferences {
  voiceEnabled: boolean
  volume: number
  animationIntensity: 'low' | 'medium' | 'high'
  reducedMotion: boolean
  /**
   * AI provider pin for the server-side router. 'mock' (default) means "server
   * decides" (primary + fallback). One of the router's provider ids
   * (gemini/openai/anthropic/openrouter/local) pins the chat/vision provider
   * strictly via the `x-jarvis-provider` header — never a key.
   */
  providerId: string
  /**
   * Phase 0.7 — opt-in automatic capture. When enabled, the engine runs a
   * conservative deterministic pass over user input and durably stores
   * obvious personal facts (source 'inferred'). Defaults to OFF.
   */
  autoMemorize: boolean
  /**
   * Phase 1.6 — opt-in wake-word listening. When enabled the dock wake button
   * is available; arming always requires a user gesture. Defaults to OFF.
   */
  wakeWordEnabled: boolean
}

export type MemoryType = 'PROFILE' | 'PREFERENCE' | 'FACT' | 'NOTE'

/**
 * A single durable memory item.
 *
 * - `type`    groups memories (who the user is / what they like / durable
 *             facts / free-form notes) for targeted retrieval.
 * - `importance` 0..1 weight used by relevance scoring (default 0.5).
 * - `metadata`   small free-form bag for future semantic/vector backends
 *             (embedding, tags, source…) without changing the API.
 * - `embedding`  optional vector embedding for semantic retrieval
 */
export interface MemoryItem {
  id: string
  type: MemoryType
  content: string
  createdAt: string
  updatedAt: string
  importance: number
  source: 'user' | 'inferred' | 'system'
  metadata: Record<string, unknown>
  embedding?: number[]
}

export type MemorySource = MemoryItem['source']

/** Transient shape returned by relevance ranking (item + matched score). */
export interface RankedMemory {
  item: MemoryItem
  score: number
}

export interface MemorySearchOptions {
  /** Include all types; defaults to true. To restrict, pass an array. */
  types?: MemoryType[]
  /** Return only items above this relevance score (0..1). */
  minScore?: number
  /** Keep context small — cap how many items are returned. */
  limit?: number
}

export interface MemorySnapshot {
  profile: Profile
  preferences: UserPreferences
  lastUpdated: string
}

/** Result of an async semantic-aware remember. */
export interface RememberResult {
  item: MemoryItem
  /** True when a brand-new item was created. */
  created: boolean
  /** Set when an existing memory matched semantically and content was merged. */
  deduplicated?: { existingId: string; similarity: number }
}

/** Lightweight embedding health summary for UI/debug panels. */
export interface EmbeddingHealthSummary {
  enabled: boolean
  realEmbeddingsAvailable: boolean
  fallbackActive: boolean
  status: ProviderHealthStatus
  providerId: string
  providerLabel: string
  model: string
  dimensions: number
  lastError?: string
}

/**
 * Back-compat projection of a memory item to the legacy note shape, so
 * existing consumers (and tests) keep working after the model upgrade.
 */
export interface Note {
  id: string
  text: string
  createdAt: string
}

export const DEFAULT_PROFILE: Profile = {
  name: 'Operator',
  createdAt: new Date(0).toISOString(),
  version: '0.3.0',
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  voiceEnabled: true,
  volume: 0.9,
  animationIntensity: 'high',
  reducedMotion: false,
  providerId: 'mock',
  autoMemorize: false,
  wakeWordEnabled: false,
}

/** Versioned on-disk record so older blobs can be migrated forward. */
interface MemoryRecord {
  version: number
  profile: Profile
  preferences: UserPreferences
  items: MemoryItem[]
  /** Legacy notes promoted to NOTE items (kept only during migration). */
  notes?: Note[]
  /** Recoverable memories moved out of the active set by Phase 0.7 lifecycle. */
  archive?: ArchivedMemory[]
  /** Past conversation sessions that wrote memories (Phase 0.7). */
  episodes?: Record<string, Episode>
  /** Lifecycle bookkeeping (when consolidation last ran). */
  lifecycle?: { lastRunAt?: string }
}

const STORAGE_KEY = 'jarvis.memory'
const RECORD_VERSION = 4

/** localStorage-backed store. Persists into `jarvis.memory` as one blob. */
export class LocalStorageStore implements Store<'memory', MemoryRecord> {
  read(_key: 'memory'): MemoryRecord | null {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return null
      const data = JSON.parse(raw) as Partial<MemoryRecord>
      if (!data.profile || !data.preferences) return null
      return data as MemoryRecord
    } catch {
      return null
    }
  }

  write(_key: 'memory', value: MemoryRecord): boolean {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
      return true
    } catch (error) {
      console.warn('[memory] write failed', error)
      return false
    }
  }

  remove(_key: 'memory'): boolean {
    try {
      window.localStorage.removeItem(STORAGE_KEY)
      return true
    } catch {
      return false
    }
  }
}

/** Coordinates short-term context and long-term persistence. */
export class MemoryManager {
  private store = new LocalStorageStore()
  private memo: MemoryRecord = {
    version: RECORD_VERSION,
    profile: { ...DEFAULT_PROFILE },
    preferences: { ...DEFAULT_PREFERENCES },
    items: [],
    archive: [],
    episodes: {},
    lifecycle: {},
  }
  private loading = false
  private embeddingManager: EmbeddingManager
  /** Persistent companion semantic index shared across manager instances. */
  private vectorStore: VectorStore
  /** Active episode (this conversation session); transient per instance. */
  private activeEpisodeId: string | null = null

  constructor(embeddingManager?: EmbeddingManager, vectorStore?: VectorStore) {
    this.embeddingManager = embeddingManager ?? getDefaultEmbeddingManager()
    this.vectorStore = vectorStore ?? new LocalStorageVectorStore()
    this.load()
  }

  private load(): void {
    if (this.loading) return
    this.loading = true
    const record = this.store.read('memory')
    if (record) {
      const migrated = this.migrate(record)
      this.memo = migrated
      if (migrated.version !== record.version) this.persist()
    }
    // Hydrate/repair the companion semantic index from the authoritative record
    // so vectors stay consistent across instances (load, refresh, hot reload).
    this.syncVectorStore()
    this.loading = false
  }

  /** Promote legacy blobs (phase <=0.2) into the structured item model. */
  private migrate(record: MemoryRecord): MemoryRecord {
    const profile = { ...DEFAULT_PROFILE, ...record.profile }
    const preferences = { ...DEFAULT_PREFERENCES, ...record.preferences }
    const items = Array.isArray(record.items)
      ? record.items.map(validateItem).filter(Boolean) as MemoryItem[]
      : []
    if (Array.isArray(record.notes)) {
      record.notes.forEach((n) => {
        items.push({
          id: n.id,
          type: 'NOTE',
          content: n.text,
          createdAt: n.createdAt,
          updatedAt: n.createdAt,
          importance: 0.5,
          source: 'user',
          metadata: {},
        })
      })
    }

    const archive = Array.isArray(record.archive)
      ? record.archive.map(validateArchivedItem).filter(Boolean) as ArchivedMemory[]
      : []
    const episodes: Record<string, Episode> = {}
    if (record.episodes && typeof record.episodes === 'object') {
      for (const [id, raw] of Object.entries(record.episodes)) {
        const ep = validateEpisode(raw)
        if (ep) episodes[id] = ep
      }
    }
    const lifecycle =
      record.lifecycle && typeof record.lifecycle === 'object'
        ? { lastRunAt: typeof record.lifecycle.lastRunAt === 'string' ? record.lifecycle.lastRunAt : undefined }
        : {}

    return { version: RECORD_VERSION, profile, preferences, items, archive, episodes, lifecycle }
  }

  /* ------------------------------------------------ profile / prefs */

  snapshot(): MemorySnapshot {
    this.ensureLoaded()
    return {
      profile: { ...this.memo.profile },
      preferences: { ...this.memo.preferences },
      lastUpdated: new Date().toISOString(),
    }
  }

  updatePreferences(patch: Partial<UserPreferences>): UserPreferences {
    this.ensureLoaded()
    this.memo = {
      ...this.memo,
      preferences: { ...this.memo.preferences, ...patch },
    }
    this.persist()
    return { ...this.memo.preferences }
  }

  updateProfile(patch: Partial<Profile>): Profile {
    this.ensureLoaded()
    this.memo = {
      ...this.memo,
      profile: { ...this.memo.profile, ...patch },
    }
    this.persist()
    return { ...this.memo.profile }
  }

  /* ------------------------------------------------ items */

  /**
   * Store a durable memory item. When content already exists it is updated in
   * place (dedupes repeated "remember X") and `updatedAt` moves forward.
   * Returns the stored item.
   */
  remember(
    content: string,
    opts: {
      type?: MemoryType
      importance?: number
      source?: MemorySource
      metadata?: Record<string, unknown>
      /** Skip embedding generation for this specific call */
      skipEmbedding?: boolean
    } = {},
  ): MemoryItem {
    this.ensureLoaded()
    const clean = (content ?? '').trim()
    if (!clean) throw new Error('Cannot store an empty memory')
    this.rejectCredentialContent(clean)
    const now = new Date().toISOString()
    const exact = this.findExact(clean)
    if (exact) {
      exact.content = clean
      exact.type = opts.type ?? exact.type
      exact.importance = clampImportance(opts.importance ?? exact.importance)
      exact.source = opts.source ?? exact.source
      exact.metadata = { ...exact.metadata, ...(opts.metadata ?? {}) }
      exact.updatedAt = now
      // Exact re-remember leaves content unchanged, so a valid embedding stays
      // untouched. Only lazily heal legacy items that lack a usable embedding.
      if (
        !opts.skipEmbedding &&
        this.embeddingManager.isEnabled() &&
        !isValidEmbedding(exact.embedding)
      ) {
        this.generateEmbeddingForItem(exact).catch((e) =>
          console.warn('[memory] embedding failed:', e),
        )
      }
      this.persist()
      return { ...exact }
    }
    const item: MemoryItem = {
      id: nextItemId(this.memo.items.length),
      type: opts.type ?? 'FACT',
      content: clean,
      createdAt: now,
      updatedAt: now,
      importance: clampImportance(opts.importance ?? 0.5),
      source: opts.source ?? 'user',
      metadata: this.tagForActiveEpisode({ ...(opts.metadata ?? {}) }, now),
    }
    this.memo.items = [item, ...this.memo.items]
    this.persist()
    // Generate embedding for new item
    if (!opts.skipEmbedding && this.embeddingManager.isEnabled()) {
      this.generateEmbeddingForItem(item).catch((e) => console.warn('[memory] embedding failed:', e))
    }
    return { ...item }
  }

  /**
   * Async remember that additionally guards against semantic duplicates.
   *
   * Exact (lexical) duplicates still update in place. When a REAL embedding
   * provider is active, near-identical new content (similarity at/above the
   * conservative threshold) is merged into the existing memory instead of
   * creating a duplicate record. The deterministic test provider never
   * participates in this decision, so it can never be mistaken for real
   * semantic meaning. Returns the stored item plus dedup metadata.
   */
  async rememberSemantic(
    content: string,
    opts: {
      type?: MemoryType
      importance?: number
      source?: MemorySource
      metadata?: Record<string, unknown>
      skipEmbedding?: boolean
    } = {},
  ): Promise<RememberResult> {
    this.ensureLoaded()
    const clean = (content ?? '').trim()
    if (!clean) throw new Error('Cannot store an empty memory')
    this.rejectCredentialContent(clean)
    const now = new Date().toISOString()

    // 1) Exact duplicate — update in place (preserves lexical dedup behavior).
    const exact = this.findExact(clean)
    if (exact) {
      exact.type = opts.type ?? exact.type
      exact.importance = clampImportance(opts.importance ?? exact.importance)
      exact.source = opts.source ?? exact.source
      exact.metadata = { ...exact.metadata, ...(opts.metadata ?? {}) }
      exact.updatedAt = now
      if (
        !opts.skipEmbedding &&
        this.embeddingManager.isEnabled() &&
        !isValidEmbedding(exact.embedding)
      ) {
        this.generateEmbeddingForItem(exact).catch((e) =>
          console.warn('[memory] embedding failed:', e),
        )
      }
      this.persist()
      return { item: copyItem(exact), created: false }
    }

    // 2) Semantic duplicate — only consulted with a real provider.
    const match = await this.embeddingManager.checkSemanticDuplicate(clean, this.memo.items)
    if (match.isDuplicate && match.existingId) {
      const target = this.memo.items.find((m) => m.id === match.existingId)
      if (target) {
        target.type = opts.type ?? target.type
        target.importance = clampImportance(opts.importance ?? target.importance)
        target.source = opts.source ?? target.source
        target.metadata = { ...target.metadata, ...(opts.metadata ?? {}) }
        // Content is semantically identical; keep the original text and just
        // refresh the timestamp. The embedding stays valid (content unchanged).
        target.updatedAt = now
        this.persist()
        return {
          item: copyItem(target),
          created: false,
          deduplicated: { existingId: target.id, similarity: match.similarity ?? 1 },
        }
      }
    }

    // 3) Brand-new memory.
    const item: MemoryItem = {
      id: nextItemId(this.memo.items.length),
      type: opts.type ?? 'FACT',
      content: clean,
      createdAt: now,
      updatedAt: now,
      importance: clampImportance(opts.importance ?? 0.5),
      source: opts.source ?? 'user',
      metadata: this.tagForActiveEpisode({ ...(opts.metadata ?? {}) }, now),
    }
    this.memo.items = [item, ...this.memo.items]
    this.persist()
    if (!opts.skipEmbedding && this.embeddingManager.isEnabled()) {
      this.generateEmbeddingForItem(item).catch((e) =>
        console.warn('[memory] embedding failed:', e),
      )
    }
    return { item: copyItem(item), created: true }
  }

  /**
   * Generate and store embedding for a memory item.
   * Runs asynchronously and doesn't block the main operation.
   */
  private async generateEmbeddingForItem(item: MemoryItem): Promise<void> {
    if (!this.embeddingManager.isEnabled()) return
    try {
      const embedding = await this.embeddingManager.generateEmbedding(item.content)
      if (!isValidEmbedding(embedding)) return
      // Locate the LIVE item by id: a concurrent load() may have re-read the
      // persisted record and swapped `this.memo`, orphaning the object passed
      // into this call. Writing to the found (current) object guarantees the
      // embedding is never lost, and skipping a missing id means an item
      // deleted while embedding was in flight is never resurrected with one.
      const live = this.memo.items.find((m) => m.id === item.id)
      if (!live) return
      live.embedding = embedding
      // Persist the provider identity + dimensions that produced this vector
      // so later instances can detect stale/dimension-mismatched embeddings.
      live.metadata = {
        ...live.metadata,
        embeddingProvider: this.embeddingManager.getProviderId(),
        embeddingDimensions: this.embeddingManager.getDimensions(),
      }
      live.updatedAt = new Date().toISOString()
      this.persist()
    } catch (error) {
      console.warn('[memory] Failed to generate embedding for item:', error)
    }
  }

  /** All stored items (copy), newest first. */
  items(): MemoryItem[] {
    this.ensureLoaded()
    return this.memo.items.map(copyItem)
  }

  /** Alias of `items()` kept for API clarity. */
  all(): MemoryItem[] {
    return this.items()
  }

  /** Fetch a single item by id. */
  get(id: string): MemoryItem | null {
    this.ensureLoaded()
    const item = this.memo.items.find((m) => m.id === id)
    return item ? copyItem(item) : null
  }

  /** Update fields of an existing item. Returns the updated copy or null. */
  update(
    id: string,
    patch: Partial<Pick<MemoryItem, 'content' | 'type' | 'importance' | 'source'>>,
    opts: { skipEmbedding?: boolean } = {},
  ): MemoryItem | null {
    this.ensureLoaded()
    const item = this.memo.items.find((m) => m.id === id)
    if (!item) return null
    const contentChanged = patch.content !== undefined && patch.content !== item.content
    if (patch.content !== undefined) {
      const next = String(patch.content).trim()
      this.rejectCredentialContent(next)
      item.content = next
    }
    if (patch.type !== undefined) item.type = patch.type
    if (patch.importance !== undefined) item.importance = clampImportance(patch.importance)
    if (patch.source !== undefined) item.source = patch.source
    if (item.content) item.updatedAt = new Date().toISOString()
    // Embeddings encode content. When content changes, drop the now-stale
    // vector immediately (before persisting) so a failed or skipped
    // regeneration can never leave a stale embedding silently attached to
    // the new content.
    if (contentChanged) item.embedding = undefined
    this.persist()
    // Generate embedding if content changed
    if (contentChanged && !opts.skipEmbedding && this.embeddingManager.isEnabled()) {
      this.generateEmbeddingForItem(item).catch((e) => console.warn('[memory] embedding failed:', e))
    }
    return copyItem(item)
  }

  /** Remove a single memory by id (or first exact-content match). */
  remove(id: string | MemoryItem | { content: string }): boolean {
    this.ensureLoaded()
    const targetId = typeof id === 'string' ? id : (id as MemoryItem).id
    const before = this.memo.items.length
    if (targetId) {
      this.memo.items = this.memo.items.filter((m) => m.id !== targetId)
    } else {
      const content = (id as { content: string }).content
      this.memo.items = this.memo.items.filter((m) => m.content !== content)
    }
    if (this.memo.items.length !== before) {
      this.persist()
      return true
    }
    return false
  }

  /** Remove every item matching the query content term (subword). */
  removeMatching(query: string): number {
    this.ensureLoaded()
    const q = (query ?? '').trim().toLowerCase()
    if (!q) return 0
    const before = this.memo.items.length
    this.memo.items = this.memo.items.filter((m) => !m.content.toLowerCase().includes(q))
    const removed = before - this.memo.items.length
    if (removed) this.persist()
    return removed
  }

  /** Remove ALL memories (user must confirm via the clear-flow). */
  clear(): void {
    this.ensureLoaded()
    this.memo.items = []
    this.persist()
  }

  get count(): number {
    this.ensureLoaded()
    return this.memo.items.length
  }

  /* ------------------------------------------------ lifecycle (0.7) */

  /**
   * Phase 0.7 consolidation: deterministically archive stale and/or
   * over-capacity memories (recoverable, never destroyed). Rules are driven by
   * time + importance only — embeddings never participate. Archived items keep
   * their vector out of the live index; `restoreMemory` moves them back.
   */
  runLifecycle(overrides?: Partial<LifecycleConfig>, nowMs?: number): LifecycleReport {
    this.ensureLoaded()
    const cfg = { ...defaultLifecycleConfig(), ...(overrides ?? {}) }
    const now = nowMs ?? Date.now()
    const ranAt = new Date(now).toISOString()

    const candidates = archiveCandidates(this.memo.items, now, cfg)
    const moved: ArchivedMemory[] = candidates.map((c) => ({
      ...copyItem(c.item),
      archivedAt: ranAt,
      archivedReason: c.reason,
    }))
    const archivedIds = new Set(moved.map((m) => m.id))
    if (moved.length) {
      this.memo.items = this.memo.items.filter((i) => !archivedIds.has(i.id))
      this.memo.archive = [...(this.memo.archive ?? []), ...moved]
    }
    this.memo.lifecycle = { ...this.memo.lifecycle, lastRunAt: ranAt }
    this.persist()

    return {
      archived: moved.map(copyArchiveItem),
      archivedCount: moved.length,
      kept: this.memo.items.length,
      total: this.memo.items.length + (this.memo.archive ?? []).length,
      lastRunAt: ranAt,
    }
  }

  /** True when the lifecycle is enabled and due for an automatic run. */
  isLifecycleDue(nowMs: number = Date.now(), overrides?: Partial<LifecycleConfig>): boolean {
    this.ensureLoaded()
    const cfg = { ...defaultLifecycleConfig(), ...(overrides ?? {}) }
    return isLifecycleDue(this.memo.lifecycle?.lastRunAt, nowMs, cfg)
  }

  /** Timestamp of the last lifecycle run (for status reporting). */
  lifecycleInfo(): { lastRunAt?: string } {
    this.ensureLoaded()
    return { ...(this.memo.lifecycle ?? {}) }
  }

  /** Recoverable archived memories, newest-first copies. */
  archivedItems(): ArchivedMemory[] {
    this.ensureLoaded()
    return (this.memo.archive ?? []).map(copyArchiveItem)
  }

  get archivedCount(): number {
    this.ensureLoaded()
    return (this.memo.archive ?? []).length
  }

  /** Move an archived memory back into the active set (vector restored too). */
  restoreMemory(id: string): boolean {
    this.ensureLoaded()
    const archive = this.memo.archive ?? []
    const index = archive.findIndex((a) => a.id === id)
    if (index < 0) return false
    const [entry] = archive.splice(index, 1)
    this.memo.archive = archive
    this.memo.items = [
      {
        id: entry.id,
        type: entry.type,
        content: entry.content,
        createdAt: entry.createdAt,
        updatedAt: new Date().toISOString(),
        importance: entry.importance,
        source: entry.source,
        metadata: { ...entry.metadata },
        embedding: entry.embedding ? [...entry.embedding] : undefined,
      },
      ...this.memo.items,
    ]
    this.persist()
    return true
  }

  /**
   * Permanently delete archived memories. Pass a cutoff ISO string to keep
   * everything archived at/after that time and purge only the older — omit it
   * to expunge the whole archive (caller intent is explicit).
   */
  expungeArchived(cutoffIso?: string): number {
    this.ensureLoaded()
    const archive = this.memo.archive ?? []
    const before = archive.length
    if (cutoffIso) {
      const cutoff = Date.parse(cutoffIso)
      if (Number.isFinite(cutoff)) {
        this.memo.archive = archive.filter((a) => Date.parse(a.archivedAt) >= cutoff)
      } else {
        this.memo.archive = archive
      }
    } else {
      this.memo.archive = []
    }
    const removed = before - (this.memo.archive ?? []).length
    if (removed) this.persist()
    return removed
  }

  /* ------------------------------------------------ episodes (0.7) */

  /**
   * Start (or resume tagging into) a session episode. Memories created while
   * an episode is active get `metadata.episodeId`. The active episode is
   * transient; the episode registry is persisted.
   */
  beginEpisode(id: string, title?: string): Episode {
    this.ensureLoaded()
    const existing = this.memo.episodes?.[id]
    const now = new Date().toISOString()
    this.memo.episodes = {
      ...(this.memo.episodes ?? {}),
      [id]: {
        id,
        title: title ?? existing?.title,
        startedAt: existing?.startedAt ?? now,
        endedAt: existing?.endedAt,
        itemCount: existing?.itemCount ?? 0,
      },
    }
    this.activeEpisodeId = id
    if (!existing) this.persist()
    const episode = this.memo.episodes[id]
    return { ...episode }
  }

  /** End the active episode (starts a new one on the next begin). */
  endEpisode(): Episode | null {
    this.ensureLoaded()
    const id = this.activeEpisodeId
    if (!id) return null
    this.activeEpisodeId = null
    const episode = this.memo.episodes?.[id]
    if (episode && !episode.endedAt) {
      this.memo.episodes = {
        ...(this.memo.episodes ?? {}),
        [id]: { ...episode, endedAt: new Date().toISOString() },
      }
      this.persist()
    }
    return episode ? { ...episode, endedAt: this.memo.episodes?.[id]?.endedAt ?? episode.endedAt } : null
  }

  /** The currently active episode (if any). */
  get activeEpisode(): Episode | null {
    this.ensureLoaded()
    const id = this.activeEpisodeId
    if (!id) return null
    const ep = this.memo.episodes?.[id]
    return ep ? { ...ep } : null
  }

  /** Past episodes, newest first, with live item counts. */
  episodes(): Episode[] {
    this.ensureLoaded()
    const counts = new Map<string, number>()
    for (const item of this.memo.items) {
      const ep = episodeIdOf(item)
      if (ep) counts.set(ep, (counts.get(ep) ?? 0) + 1)
    }
    return Object.values(this.memo.episodes ?? {})
      .map((ep) => ({ ...ep, itemCount: counts.get(ep.id) ?? ep.itemCount }))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  }

  /** Active memories captured in a specific episode. */
  episodeMemories(episodeId: string): MemoryItem[] {
    this.ensureLoaded()
    return this.memo.items.filter((i) => episodeIdOf(i) === episodeId).map(copyItem)
  }

  /* ------------------------------------------------ search */

  /**
   * Hybrid semantic + lexical search.
   * Combines embedding similarity (when REAL embeddings are available) with
   * lexical token overlap, boosted by importance and recency. Gracefully
   * falls back to lexical-only when no real embeddings exist (including the
   * deterministic/test provider).
   */
  async search(
    query: string,
    options: MemorySearchOptions & { embeddingConfig?: HybridRankingConfig } = {},
  ): Promise<RankedMemory[]> {
    this.ensureLoaded()
    const { types, minScore, limit = 5, embeddingConfig = DEFAULT_HYBRID_CONFIG } = options
    const q = (query ?? '').trim().toLowerCase()
    if (!q) return []
    const tokens = tokenize(q)
    if (!tokens.length) return []
    const needle = new Set(tokens)

    const now = Date.now()
    const ranked: RankedMemory[] = []

    // Semantic retrieval only participates when REAL embeddings are available.
    // The deterministic/test provider must never be mistaken for meaning, so
    // its presence keeps scoring lexical-only (importance + recency), exactly
    // the documented fallback.
    const semanticEnabled = this.embeddingManager.hasRealEmbeddings()

    // Generate query embedding if real semantic retrieval is available
    let queryEmbedding: number[] | undefined
    if (semanticEnabled) {
      try {
        queryEmbedding = await this.embeddingManager.generateEmbedding(query)
      } catch (error) {
        console.warn('[memory] Failed to generate query embedding:', error)
      }
    }

    // Semantic scores come from the persistent companion vector index when it
    // can answer; otherwise fall back to the item's inline embedding. This
    // keeps lexical-only retrieval (no real embeddings) working unchanged.
    let semanticByItem: Map<string, number> | null = null
    if (queryEmbedding) {
      try {
        const vectorResult = this.vectorStore.search(queryEmbedding, {
          dimensions: queryEmbedding.length,
        })
        semanticByItem = new Map(
          vectorResult.matches.map((m) => [m.entry.id, m.score]),
        )
      } catch (error) {
        console.warn('[memory] vector search failed, falling back to inline embeddings:', error)
      }
    }

    // Use config's minScore as default if not explicitly provided
    const effectiveMinScore = minScore ?? embeddingConfig.minScore

    for (const item of this.memo.items) {
      if (types && types.length && !types.includes(item.type)) continue
      // Semantic component: prefer the companion index; else the item's inline
      // embedding, but only when its dimensions match the query (a cross-
      // dimension cosine is meaningless and must never rank as "relevant").
      let semantic = 0
      const fromIndex = semanticByItem?.get(item.id)
      if (fromIndex !== undefined) {
        semantic = fromIndex
      } else if (
        queryEmbedding &&
        item.embedding &&
        item.embedding.length === queryEmbedding.length
      ) {
        semantic = semanticScore(item, queryEmbedding)
      }
      const score = hybridScoreFromSimilarity(item, semantic, tokens, needle, now, embeddingConfig)
      if (score <= 0 || score < effectiveMinScore) continue
      ranked.push({ item: copyItem(item), score })
    }
    ranked.sort((a, b) => b.score - a.score || recencyMs(a.item.updatedAt) - recencyMs(b.item.updatedAt))
    return ranked.slice(0, limit)
  }

  /** Convenience: search whose result contains the exact string (delete path). */
  findExact(content: string): MemoryItem | null {
    this.ensureLoaded()
    const target = (content ?? '').trim()
    if (!target) return null
    const item = this.memo.items.find((m) => m.content === target)
    return item ? copyItem(item) : null
  }

  /* ------------------------------------------------ embeddings */

  /**
   * Generate a valid embedding for every stored memory that lacks one.
   *
   * Resumable & rerunnable: items that already carry a valid embedding are
   * skipped, embeddings are never overwritten, and memories are never deleted.
   * Individual failures are recorded and never abort the whole operation.
   * Persists newly generated embeddings immediately.
   */
  async backfillEmbeddings(): Promise<BackfillResult> {
    this.ensureLoaded()
    const start = Date.now()
    const all = this.memo.items
    const result: BackfillResult = {
      total: all.length,
      alreadyEmbedded: 0,
      processed: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
      errors: [],
    }

    if (!this.embeddingManager.isEnabled()) {
      result.skipped = all.length
      result.durationMs = Date.now() - start
      return result
    }

    const pending = all.filter((m) => !isValidEmbedding(m.embedding))
    result.alreadyEmbedded = all.length - pending.length
    if (pending.length === 0) {
      result.durationMs = Date.now() - start
      return result
    }

    const embeddings = await this.embeddingManager.embedMemoryItems(
      pending.map((m) => ({ id: m.id, content: m.content })),
    )

    for (const m of pending) {
      const embedding = embeddings.get(m.id)
      if (isValidEmbedding(embedding)) {
        m.embedding = embedding
        // Record the provider identity + dimensions, same as remember() does,
        // so later instances can detect stale/dimension-mismatched vectors.
        m.metadata = {
          ...m.metadata,
          embeddingProvider: this.embeddingManager.getProviderId(),
          embeddingDimensions: this.embeddingManager.getDimensions(),
        }
        result.successful++
      } else {
        result.failed++
        result.errors.push({ id: m.id, error: 'Failed to generate a valid embedding' })
      }
      result.processed++
    }
    this.persist()
    result.durationMs = Date.now() - start
    return result
  }

  /** Lightweight embedding health summary for UI/debug panels. */
  getEmbeddingHealth(): EmbeddingHealthSummary {
    const manager = this.embeddingManager
    const health = manager.getHealth()
    return {
      enabled: manager.isEnabled(),
      realEmbeddingsAvailable: manager.hasRealEmbeddings(),
      fallbackActive: health.fallbackActive,
      status: health.status,
      providerId: health.providerId,
      providerLabel: health.label,
      model: health.model,
      dimensions: health.dimensions,
      lastError: health.lastError,
    }
  }

  /**
   * Diagnostics for the persistent companion vector index (counts, provider
   * ids, dimensions, storage key) — for status/debug panels.
   */
  vectorStoreDiagnostics(): VectorDiagnostics {
    this.ensureLoaded()
    return this.vectorStore.diagnostics()
  }

  /* ------------------------------------------------ legacy notes (back-compat) */

  /** Legacy note API — projections of NOTE items. Kept for existing callers. */
  addNote(text: string): Note {
    const item = this.remember(text, { type: 'NOTE' })
    return toNote(item)
  }

  notes(): Note[] {
    return this.items().map(toNote)
  }

  /** Legacy word-level find over NOTE items (used by older NotesTool callers). */
  findNotes(query: string): Note[] {
    const q = (query ?? '').trim().toLowerCase()
    const check = new Set(tokenize(q))
    return this.notes()
      .filter((n) => !q || [...check].some((w) => n.text.toLowerCase().includes(w)))
      .map((n) => ({ ...n }))
  }

  removeNote(id: string): boolean {
    this.ensureLoaded()
    const before = this.memo.items.length
    this.memo.items = this.memo.items.filter((m) => m.id !== id)
    if (this.memo.items.length !== before) {
      this.persist()
      return true
    }
    return false
  }

  clearNotes(): void {
    this.ensureLoaded()
    this.memo.items = this.memo.items.filter((m) => m.type !== 'NOTE')
    this.persist()
  }

  /* ------------------------------------------------ internals */

  /**
   * Tag item metadata with the active episode and keep the registry's item
   * count current. Pure bookkeeping around `episodes.ts` helpers.
   */
  private tagForActiveEpisode(metadata: Record<string, unknown>, nowIso: string): Record<string, unknown> {
    const id = this.activeEpisodeId
    if (!id) return metadata
    const existing = this.memo.episodes?.[id]
    this.memo.episodes = {
      ...(this.memo.episodes ?? {}),
      [id]: withIncrementedCount(existing ?? { id, startedAt: nowIso, itemCount: 0 }),
    }
    return tagWithEpisode(metadata, id)
  }

  private ensureLoaded(): void {
    if (this.loading) return
    this.load()
  }

  /**
   * THE memory write boundary for credential-like content. Every durable write
   * path (remember, rememberSemantic, update) funnels through here — no caller
   * can bypass it. High-confidence credential phrasing is refused outright;
   * broad prose (e.g. "kept secret", "token ring") stays storable.
   */
  private rejectCredentialContent(content: string): void {
    if (looksLikeHighRiskCredential(content)) {
      throw new Error('Refusing to store credential-like content in memory.')
    }
  }

  private persist(): void {
    this.store.write('memory', this.memo)
    this.syncVectorStore()
  }

  /**
   * Keep the companion vector index consistent with the authoritative record.
   * Reconciles add/remove/update-reflect every changed item and never throw —
   * a broken index must degrade to inline-embedding/lexical search, not crash
   * memory operations.
   */
  private syncVectorStore(): void {
    try {
      this.vectorStore.reconcile(this.memo.items)
    } catch (error) {
      console.warn('[memory] vector store sync failed:', error)
    }
  }
}

/* ------------------------------------------------ helpers */

function validateItem(item: MemoryItem): MemoryItem | null {
  if (!item || typeof item.id !== 'string' || typeof item.content !== 'string') return null
  return copyItem({
    id: item.id,
    type: isMemoryType(item.type) ? item.type : 'FACT',
    content: item.content,
    createdAt: item.createdAt || new Date(0).toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date(0).toISOString(),
    importance: clampImportance(item.importance),
    source: item.source || 'user',
    metadata: item.metadata && typeof item.metadata === 'object' ? { ...item.metadata } : {},
    embedding: Array.isArray(item.embedding) ? [...item.embedding] : undefined,
  })
}

function isMemoryType(t: unknown): t is MemoryType {
  return t === 'PROFILE' || t === 'PREFERENCE' || t === 'FACT' || t === 'NOTE'
}

function copyItem(item: MemoryItem): MemoryItem {
  return {
    ...item,
    metadata: { ...item.metadata },
    embedding: item.embedding ? [...item.embedding] : undefined,
  }
}

function validateArchivedItem(item: ArchivedMemory): ArchivedMemory | null {
  if (!item || typeof item.id !== 'string' || typeof item.content !== 'string') return null
  return copyArchiveItem({
    ...copyItem({
      id: item.id,
      type: isMemoryType(item.type) ? item.type : 'FACT',
      content: item.content,
      createdAt: item.createdAt || new Date(0).toISOString(),
      updatedAt: item.updatedAt || item.createdAt || new Date(0).toISOString(),
      importance: clampImportance(item.importance),
      source: item.source || 'user',
      metadata: item.metadata && typeof item.metadata === 'object' ? { ...item.metadata } : {},
      embedding: Array.isArray(item.embedding) ? [...item.embedding] : undefined,
    }),
    archivedAt: typeof item.archivedAt === 'string' ? item.archivedAt : new Date(0).toISOString(),
    archivedReason: item.archivedReason === 'overflow' || item.archivedReason === 'manual' ? item.archivedReason : 'stale',
  })
}

function copyArchiveItem(item: ArchivedMemory): ArchivedMemory {
  return {
    ...copyItem(item),
    archivedAt: item.archivedAt,
    archivedReason: item.archivedReason,
  }
}

function toNote(item: MemoryItem): Note {
  return { id: item.id, text: item.content, createdAt: item.updatedAt || item.createdAt }
}

function clampImportance(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0.5
  return Math.min(1, Math.max(0, n))
}

/**
 * A stored embedding is only usable when it is a non-empty array of finite
 * numbers. Anything else (missing, empty, dimension-mismatch, NaN/Infinity)
 * is treated as absent so backfill/regeneration can replace it.
 */
export function isValidEmbedding(
  embedding: number[] | undefined,
): embedding is number[] {
  if (!Array.isArray(embedding) || embedding.length === 0) return false
  for (const v of embedding) {
    if (!Number.isFinite(v)) return false
  }
  return true
}

function nextItemId(index: number): string {
  return `mem-${Date.now().toString(36)}-${index}`
}



/** Newest-first ordering helper. */
function recencyMs(iso: string): number {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}


