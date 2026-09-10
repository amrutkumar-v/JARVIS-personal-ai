import { describe, expect, it, beforeEach } from 'vitest'
import { MemoryManager } from '../memory/MemoryManager'
import { MemoryContextManager, estimateTokens, selectMemoryWithinBudget, renderMemoryLine } from '../memory/contextManager'
import { episodeIdOf } from '../memory/episodes'
import type { MemoryItem, RankedMemory } from '../memory/MemoryManager'

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

function ranked(item: Partial<MemoryItem> & { content: string }, score: number): RankedMemory {
  return {
    item: {
      id: item.id ?? `mem-${item.content}`,
      type: item.type ?? 'FACT',
      content: item.content,
      createdAt: item.createdAt ?? new Date().toISOString(),
      updatedAt: item.updatedAt ?? new Date().toISOString(),
      importance: item.importance ?? 0.5,
      source: item.source ?? 'user',
      metadata: item.metadata ?? {},
    },
    score,
  }
}

describe('estimateTokens', () => {
  it('estimates ~4 chars per token, never 0', () => {
    expect(estimateTokens('')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('this is a longer sentence with many words in it')).toBe(
      Math.max(1, Math.ceil('this is a longer sentence with many words in it'.length / 4)),
    )
  })
})

describe('selectMemoryWithinBudget', () => {
  it('returns everything when everything fits the budget', () => {
    const ranks = [ranked({ content: 'a' }, 0.9), ranked({ content: 'b' }, 0.7)]
    const out = selectMemoryWithinBudget(ranks, 800, 6)
    expect(out).toHaveLength(2)
  })

  it('drops items that overrun the token budget and keeps later cheaper ones', () => {
    const ranks = [
      ranked({ content: 'x'.repeat(4) }, 0.9), // 1 token line
      ranked({ content: 'y'.repeat(4000) }, 0.8), // 1000 tokens — must be skipped
      ranked({ content: 'z'.repeat(4) }, 0.7), // 1 token — must be kept
    ]
    const out = selectMemoryWithinBudget(ranks, 10, 6)
    const bodies = out.map((r) => r.item.content[0])
    expect(bodies).toEqual(['x', 'z'])
  })

  it('respects the max item count regardless of budget', () => {
    const ranks = Array.from({ length: 10 }, (_, i) => ranked({ content: `item-${i}` }, 1 - i / 20))
    const out = selectMemoryWithinBudget(ranks, 800, 3)
    expect(out.length).toBeLessThanOrEqual(3)
  })

  it('prefers the intended episode when the budget is tight', () => {
    const ranks = [
      ranked({ content: 'ep B ' + 'n'.repeat(20), metadata: { episodeId: 'B' } }, 0.9),
      ranked({ content: 'ep A ' + 'n'.repeat(20), metadata: { episodeId: 'A' } }, 0.8),
    ]
    // Budget fits exactly one of the two equal-length lines.
    const out = selectMemoryWithinBudget(ranks, 12, 6, 'A')
    expect(out).toHaveLength(1)
    expect(episodeIdOf(out[0].item)).toBe('A')
  })

  it('returns in original rank order after selection', () => {
    const ranks = [ranked({ content: 'a' }, 0.9), ranked({ content: 'b' }, 0.7)]
    const out = selectMemoryWithinBudget(ranks, 800, 6)
    expect(out.map((r) => r.item.content)).toEqual(['a', 'b'])
  })
})

describe('MemoryContextManager.build', () => {
  let memory: MemoryManager

  beforeEach(() => {
    stubBrowserStorage()
    memory = new MemoryManager()
  })

  it('assembles a token-bounded context from the injected search', async () => {
    memory.remember('my favorite color is teal', { type: 'PREFERENCE' })
    memory.remember('I use a mechanical keyboard', { type: 'FACT' })

    const manager = new MemoryContextManager({ limit: 6, maxTokens: 800 })
    const ctx = await manager.build(
      (q, o) => memory.search(q, o),
      () => memory.items(),
      'favorite color',
    )
    expect(ctx.empty).toBe(false)
    expect(ctx.text).toContain('[preference]')
    expect(ctx.text).toContain('teal')
    expect(ctx.text).not.toContain('keyboard')
    const tokens = estimateTokens(ctx.text)
    expect(tokens).toBeLessThanOrEqual(800)
  })

  it('honors a tiny budget and still returns the best-fitting item', async () => {
    memory.remember('one small fact', { type: 'FACT' })
    memory.remember('two modest fact', { type: 'FACT' })

    const manager = new MemoryContextManager({ limit: 2, maxTokens: 7 })
    const ctx = await manager.build(
      (q, o) => memory.search(q, o),
      () => memory.items(),
      'fact',
    )
    expect(ctx.empty).toBe(false)
    expect(ctx.memories.length).toBeLessThanOrEqual(1)
    expect(estimateTokens(ctx.text)).toBeLessThanOrEqual(7)
  })

  it('reports empty when no memory is stored', async () => {
    const manager = new MemoryContextManager({ limit: 6, maxTokens: 800 })
    const ctx = await manager.build(
      (q, o) => memory.search(q, o),
      () => memory.items(),
      'anything',
    )
    expect(ctx.empty).toBe(true)
    expect(ctx.memories).toEqual([])
  })

  it('prefers the configured episode through the manager config', async () => {
    memory.beginEpisode('ep-a')
    memory.remember('paw print', { type: 'FACT' })
    memory.endEpisode()
    memory.beginEpisode('ep-b')
    memory.remember('paw print', { type: 'FACT' })
    memory.endEpisode()

    const manager = new MemoryContextManager({ limit: 6, maxTokens: 9, preferEpisodeId: 'ep-a' })
    const ctx = await manager.build(
      (q, o) => memory.search(q, o),
      () => memory.items(),
      'paw',
    )
    expect(ctx.empty).toBe(false)
    expect(episodeIdOf(ctx.memories[0].item)).toBe('ep-a')
    expect(estimateTokens(ctx.text)).toBeLessThanOrEqual(9)
  })
})

describe('renderMemoryLine', () => {
  it('renders a tagged line per memory type', () => {
    expect(renderMemoryLine(ranked({ content: 'p', type: 'PROFILE' }, 1).item)).toBe('- [profile] p')
    expect(renderMemoryLine(ranked({ content: 'q', type: 'PREFERENCE' }, 1).item)).toBe('- [preference] q')
    expect(renderMemoryLine(ranked({ content: 'r', type: 'NOTE' }, 1).item)).toBe('- [note] r')
    expect(renderMemoryLine(ranked({ content: 's', type: 'FACT' }, 1).item)).toBe('- [fact] s')
  })
})