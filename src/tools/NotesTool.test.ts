import { describe, expect, it, beforeEach } from 'vitest'
import { NotesTool } from '../tools/NotesTool'
import { MemoryManager } from '../memory/MemoryManager'
import type { ToolContext } from '../tools'

/**
 * Minimal in-memory window/localStorage so MemoryManager (which persists to
 * `window.localStorage`) runs in the node vitest environment without jsdom.
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

describe('NotesTool (memory-backed)', () => {
  let tool: NotesTool
  let memory: MemoryManager
  let ctx: ToolContext

  beforeEach(() => {
    stubBrowserStorage()
    memory = new MemoryManager()
    tool = new NotesTool()
    ctx = { requestId: 'notes-test', memory }
  })

  it('is a low_risk memory tool with a schema', () => {
    expect(tool.id).toBe('notes')
    expect(tool.category).toBe('memory')
    expect(tool.permission).toBe('low_risk')
    expect(tool.inputSchema.required).toEqual(['action'])
  })

  it('saves a note through memory', async () => {
    const res = await tool.execute(
      { query: 'remember my name is Samantha', params: { action: 'save', text: 'My name is Samantha' } },
      ctx,
    )
    expect(res.ok).toBe(true)
    expect(memory.notes()).toHaveLength(1)
    expect(memory.notes()[0].text).toContain('Samantha')
  })

  it('recalls a matching note', async () => {
    memory.addNote('my favorite coffee order is a flat white with oat milk')
    const res = await tool.execute(
      { query: 'what do you remember', params: { action: 'recall', query: 'coffee order' } },
      ctx,
    )
    expect(res.ok).toBe(true)
    expect(res.message).toContain('oat milk')
  })

  it('reports honestly when nothing matches', async () => {
    const res = await tool.execute(
      { query: 'recall the meeting', params: { action: 'recall', query: 'gibberish' } },
      ctx,
    )
    expect(res.ok).toBe(true)
    expect(res.message.toLowerCase()).toMatch(/nothing|remember/)
  })

  it('clears all notes', async () => {
    memory.addNote('one')
    memory.addNote('two')
    const res = await tool.execute(
      { query: 'forget everything', params: { action: 'clear' } },
      ctx,
    )
    expect(res.ok).toBe(true)
    expect(memory.notes()).toHaveLength(0)
  })

  it('rejects an empty save', async () => {
    const res = await tool.execute(
      { query: 'remember', params: { action: 'save', text: '' } },
      ctx,
    )
    expect(res.ok).toBe(false)
  })

  it('lists episodes that wrote memories and recalls one session', async () => {
    memory.beginEpisode('conv-x', 'Setup chat')
    memory.remember('name is Dinah', { type: 'PROFILE' })
    memory.endEpisode()
    memory.beginEpisode('conv-y')
    memory.remember('name is Ruth', { type: 'PROFILE' })
    memory.endEpisode()

    const episodes = await tool.execute({ query: 'what sessions do you remember', params: { action: 'episodes' } }, ctx)
    expect(episodes.ok).toBe(true)
    const list = (episodes.data as { episodes: Array<{ id: string; itemCount: number }> }).episodes
    expect(list).toHaveLength(2)
    expect(list.some((e) => e.id === 'conv-x' && e.itemCount === 1)).toBe(true)

    const recalled = await tool.execute(
      { query: 'what did I say in that session', params: { action: 'episode_memories', episode_id: 'conv-x' } },
      ctx,
    )
    expect(recalled.ok).toBe(true)
    const items = (recalled.data as { items: Array<{ content: string }> }).items
    expect(items.map((m) => m.content)).toContain('name is Dinah')
    expect(items.map((m) => m.content)).not.toContain('name is Ruth')
  })

  it('requires an episode_id for episode_memories', async () => {
    const res = await tool.execute({ query: 'episode memories', params: { action: 'episode_memories' } }, ctx)
    expect(res.ok).toBe(false)
  })

  it('lists archived memories, optionally per session, and restores one', async () => {
    memory.beginEpisode('sess-a')
    memory.remember('obsolete trivia alpha', { type: 'FACT', importance: 0.2 })
    memory.endEpisode()
    // Force-age the item so consolidation archives it.
    const item = memory.items()[0]
    memory.runLifecycle({ forgetAfterDays: 0 }, Date.now() + 366 * 86_400_000)

    const archived = await archiveFrom(tool, ctx)
    expect(archived.items).toHaveLength(1)

    const bySession = await archiveFrom(tool, ctx, 'sess-a')
    expect(bySession.items).toHaveLength(1)
    expect((await archiveFrom(tool, ctx, 'other')).items).toHaveLength(0)

    const restored = await tool.execute({ query: 'restore', params: { action: 'restore', id: item.id } }, ctx)
    expect(restored.ok).toBe(true)
    expect(memory.items()).toHaveLength(1)
    expect(memory.archivedItems()).toHaveLength(0)
  })
})

async function archiveFrom(tool: NotesTool, ctx: ToolContext, episodeId?: string): Promise<{ items: Array<{ content: string }> }> {
  const res = await tool.execute(
    { query: 'archive', params: episodeId ? { action: 'archive', episode_id: episodeId } : { action: 'archive' } },
    ctx,
  )
  expect(res.ok).toBe(true)
  return res.data as { items: Array<{ content: string }> }
}