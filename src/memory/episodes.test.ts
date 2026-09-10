import { describe, expect, it, beforeEach } from 'vitest'
import { MemoryManager, DEFAULT_PROFILE, DEFAULT_PREFERENCES } from '../memory/MemoryManager'
import type { MemoryItem } from '../memory/MemoryManager'

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

function seedItems(items: MemoryItem[], episodes: Record<string, unknown> = {}): void {
  const win = globalThis as {
    window: { localStorage: { setItem: (k: string, v: string) => void } }
  }
  win.window.localStorage.setItem(
    'jarvis.memory',
    JSON.stringify({
      version: 4,
      profile: { ...DEFAULT_PROFILE },
      preferences: { ...DEFAULT_PREFERENCES },
      items,
      archive: [],
      episodes,
      lifecycle: {},
    }),
  )
}

describe('MemoryManager episodes (0.7)', () => {
  beforeEach(() => stubBrowserStorage())

  it('tags memories created inside an active episode', () => {
    const memory = new MemoryManager()
    memory.beginEpisode('conv-abc', 'Setup chat')
    const item = memory.remember('I work at Acme', { type: 'FACT' })
    expect(item.metadata.episodeId).toBe('conv-abc')
    expect(memory.activeEpisode?.id).toBe('conv-abc')
    expect(memory.activeEpisode?.title).toBe('Setup chat')

    // Items created outside an episode carry no tag.
    memory.endEpisode()
    const untagged = memory.remember('A random note', { type: 'NOTE' })
    expect(untagged.metadata.episodeId).toBeUndefined()
  })

  it('ends the session episode and records an endedAt', () => {
    const memory = new MemoryManager()
    memory.beginEpisode('conv-1')
    memory.remember('hello world', { type: 'NOTE' })
    const ended = memory.endEpisode()
    expect(ended?.endedAt).toBeTruthy()
    expect(memory.activeEpisode).toBeNull()
    expect(memory.endEpisode()).toBeNull()
  })

  it('reports episodes with live item counts', () => {
    seedItems([], {
      'conv-x': { id: 'conv-x', startedAt: new Date(0).toISOString(), itemCount: 0 },
    })
    const memory = new MemoryManager()
    memory.beginEpisode('conv-x')
    memory.remember('one', { type: 'NOTE' })
    memory.remember('two', { type: 'NOTE' })
    memory.endEpisode()

    const all = memory.episodes()
    expect(all).toHaveLength(1)
    expect(all[0].itemCount).toBe(2)
  })

  it('episodeMemories filters active items in an episode', () => {
    const memory = new MemoryManager()
    memory.beginEpisode('ep-a')
    memory.remember('inside episode', { type: 'FACT' })
    memory.endEpisode()
    memory.remember('outside episode', { type: 'FACT' })

    const inEp = memory.episodeMemories('ep-a')
    expect(inEp).toHaveLength(1)
    expect(inEp[0].content).toBe('inside episode')
  })

  it('survives a reload because the episode registry is persisted', () => {
    const memory = new MemoryManager()
    memory.beginEpisode('conv-persist')
    memory.remember('durable fact', { type: 'FACT' })
    memory.endEpisode()

    const reloaded = new MemoryManager()
    expect(reloaded.episodes()).toHaveLength(1)
    expect(reloaded.episodes()[0].itemCount).toBe(1)
    expect(reloaded.episodeMemories('conv-persist')).toHaveLength(1)
  })

  it('validates malformed persisted episodes on load', () => {
    seedItems([], {
      'bad-episode': { itemCount: 'nope' },
      'good-episode': { id: 'good-episode', startedAt: new Date().toISOString(), itemCount: 3 },
    })
    const memory = new MemoryManager()
    const all = memory.episodes()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('good-episode')
    expect(all[0].itemCount).toBe(3)
  })
})