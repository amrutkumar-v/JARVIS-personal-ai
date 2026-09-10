import { describe, expect, it, beforeEach } from 'vitest'
import { MemoryManager } from '../memory/MemoryManager'
import { buildMemoryContext, memoryContextSummary } from '../memory/context'
import { episodeIdOf } from '../memory/episodes'
import { normalizeFact } from '../memory/detect'

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

describe('buildMemoryContext (controlled memory context)', () => {
  let memory: MemoryManager

  beforeEach(() => {
    stubBrowserStorage()
    memory = new MemoryManager()
  })

  it('reports empty text when nothing is stored', async () => {
    const ctx = await buildMemoryContext(
      (q, o) => memory.search(q, o),
      () => memory.items(),
      'my name',
    )
    expect(ctx.empty).toBe(true)
    expect(ctx.memories).toEqual([])
    expect(ctx.text).toContain('No personal memory')
    expect(memoryContextSummary(ctx)).toContain('No relevant memory')
  })

  it('injects only relevant memories as a tiny tagged snippet', async () => {
    memory.remember(normalizeFact('remember my favorite color is teal'), { type: 'PREFERENCE' })
    memory.remember('I use a mechanical keyboard', { type: 'FACT' })

    const ctx = await buildMemoryContext(
      (q, o) => memory.search(q, o),
      () => memory.items(),
      'favorite color',
    )
    expect(ctx.empty).toBe(false)
    expect(ctx.memories.length).toBeGreaterThan(0)
    expect(ctx.text).toContain('[preference]')
    expect(ctx.text).toContain('teal')
    expect(ctx.text).not.toContain('keyboard')
  })

  it('respects the limit so context stays small', async () => {
    for (let i = 0; i < 10; i += 1) {
      memory.remember(`Shared token alpha-${i}`, { type: 'FACT' })
    }
    const ctx = await buildMemoryContext(
      (q, o) => memory.search(q, o),
      () => memory.items(),
      'shared token',
      3,
    )
    expect(ctx.memories.length).toBeLessThanOrEqual(3)
  })

  it('passes preferEpisodeId through to make the session salient', async () => {
    // Long equal-quality lines at the default 800-token budget: only the
    // preferred episode's line fits (plus cheap shared-token fillers), so the
    // current session must win and the equally-relevant other-session line is
    // excluded by the token budget (not by the rank). Seven relevant
    // candidates avoid the "everything fits" shortcut so selection runs.
    const pad = 'z'.repeat(1700)
    memory.beginEpisode('ep-a')
    memory.remember(`favorite scent is lavender ${pad}`, { type: 'PREFERENCE', importance: 0.9 })
    memory.endEpisode()
    memory.beginEpisode('ep-b')
    memory.remember(`favorite scent is pine ${pad}`, { type: 'PREFERENCE', importance: 0.8 })
    memory.endEpisode()
    for (let i = 0; i < 5; i += 1) {
      memory.remember(`favorite trinket ${i}`, { type: 'FACT' })
    }

    const ctx = await buildMemoryContext(
      (q, o) => memory.search(q, o),
      () => memory.items(),
      'favorite scent',
      6,
      undefined,
      'ep-a',
    )
    expect(ctx.empty).toBe(false)
    expect(ctx.memories.length).toBeGreaterThan(0)
    expect(ctx.memories.length).toBeLessThanOrEqual(6)
    expect(episodeIdOf(ctx.memories[0].item)).toBe('ep-a')
    expect(ctx.text).toContain('lavender')
    expect(ctx.text).not.toContain('pine')
  })
})