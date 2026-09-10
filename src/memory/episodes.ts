import type { MemoryItem } from './MemoryManager'

/**
 * Phase 0.7 — session/episode grouping.
 *
 * An "episode" is one conversation session that wrote memories. Items created
 * while an episode is active are tagged with `metadata.episodeId`, so retrieval
 * can prefer the current session's memories and the user can inspect which
 * session produced what. Episodes are persisted in the record and survive
 * reloads; the *active* episode is transient per MemoryManager instance.
 */

export const EPISODE_META_KEY = 'episodeId'

export interface Episode {
  id: string
  title?: string
  startedAt: string
  endedAt?: string
  /** Number of items created within this episode (updated as items are added). */
  itemCount: number
}

/** The episode id a memory belongs to, if any. */
export function episodeIdOf(item: Pick<MemoryItem, 'metadata'>): string | undefined {
  const id = item.metadata?.[EPISODE_META_KEY]
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** Merge an episode tag into an item's metadata bag. */
export function tagWithEpisode(metadata: Record<string, unknown>, episodeId: string): Record<string, unknown> {
  return { ...metadata, [EPISODE_META_KEY]: episodeId }
}

/** Validate/repair a raw episode entry loaded from persistence. */
export function validateEpisode(raw: unknown): Episode | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id === '') return null
  const startedAt = typeof r.startedAt === 'string' ? r.startedAt : new Date(0).toISOString()
  return {
    id: r.id,
    title: typeof r.title === 'string' ? r.title : undefined,
    startedAt,
    endedAt: typeof r.endedAt === 'string' ? r.endedAt : undefined,
    itemCount: Number.isFinite(Number(r.itemCount)) ? Math.max(0, Number(r.itemCount)) : 0,
  }
}

/** Last-writer tracking: bump an episode's item count. */
export function withIncrementedCount(episode: Episode): Episode {
  return { ...episode, itemCount: episode.itemCount + 1 }
}