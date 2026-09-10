import { describe, expect, it, beforeEach } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import { resetProviders } from './providers'
import { useJarvisStore } from '../state/jarvis.store'
import { useConversationStore } from '../state/conversation.store'
import type { EngineOutMessage } from './contracts'

/**
 * Minimal in-memory window/localStorage so the mock's MemoryManager can
 * persist notes in the node vitest environment (no jsdom dependency).
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

function collect(engine: AssistantEngine): string[] {
  const out: string[] = []
  engine.on((m: EngineOutMessage) => {
    if (m.type === 'transcript') out.push(`[${m.speaker}] ${m.text}`)
    if (m.type === 'activity') out.push(`[activity:${m.activity.status}] ${m.activity.step}`)
    if (m.type === 'tool') out.push(`[tool:${m.toolId}] ${m.status}`)
    if (m.type === 'status') out.push(`[status] ${m.status}`)
    if (m.type === 'error') out.push(`[error] ${m.message}`)
  })
  return out
}

describe('AssistantEngine (real tool-calling loop via mock provider)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    resetProviders()
    useConversationStore.getState().clearConversation()
  })

  it('runs a two-phase tool round for arithmetic', async () => {
    const engine = new AssistantEngine()
    const log = collect(engine)
    await engine.process('what is 3 * 7')

    expect(log.join('\n')).toContain('[status] understanding')
    expect(log.join('\n')).toContain('[status] planning')
    expect(log.join('\n')).toContain('[status] executing')
    expect(log.join('\n')).toContain('[tool:calculator] success')
    expect(log.join('\n')).toContain('[status] success')
    const last = useJarvisStore.getState().lastAssistantText
    expect(last).toMatch(/21/)
  })

  it('routes the clock query to the clock tool', async () => {
    const engine = new AssistantEngine()
    const log = collect(engine)
    await engine.process('what time is it')

    expect(log.join('\n')).toContain('[tool:clock] success')
    expect(useJarvisStore.getState().lastAssistantText).toMatch(/local time/i)
  })

  it('stores and recalls a note across turns', async () => {
    const engine = new AssistantEngine()
    collect(engine)
    await engine.process('remember my name is Jordan')
    await engine.process('what is my name')

    expect(useJarvisStore.getState().lastAssistantText).toMatch(/Jordan/i)
  })

  it('reports tool errors through the notice channel without crashing', async () => {
    stubBrowserStorage()
    const engine = new AssistantEngine()
    const log = collect(engine)
    // Drive a tool-level failure (division by zero) through the calculator.
    await engine.process('what is 10 / 0')

    expect(log.join('\n')).toContain('[tool:calculator] error')
    // The engine still settles to a terminal state.
    expect(['success', 'error', 'failed'].some((s) => log.includes(`[status] ${s}`))).toBe(true)
  })

  it('reports active provider info ', async () => {
    const engine = new AssistantEngine()
    expect(engine.activeProvider().id).toBe('mock')
    expect(typeof engine.aiInfo().model).toBe('string')
  })

  it('guards capabilities truth at startup', async () => {
    const engine = new AssistantEngine()
    collect(engine)
    await engine.start()
    const caps = useJarvisStore.getState().capabilities
    expect(caps.toolsEnabled).toBe(true)
    expect(caps.memoryEnabled).toBe(true)
    expect(caps.callingEnabled).toBe(false)
  })
})

describe('AssistantEngine (Phase 0.3 — memory & conversation)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    resetProviders()
    useConversationStore.getState().clearConversation()
  })

  async function waitForType(events: EngineOutMessage[], type: EngineOutMessage['type']): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (events.some((m) => m.type === type)) return
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error(`Timed out waiting for ${type}`)
  }

  it('emits a memory "saved" event when remembering', async () => {
    const engine = new AssistantEngine()
    const memoryEvents: EngineOutMessage[] = []
    engine.on((m) => {
      if (m.type === 'memory') memoryEvents.push(m)
    })
    await engine.process('remember my name is Jordan')
    expect(memoryEvents.some((e) => e.type === 'memory' && e.action === 'saved')).toBe(true)
  })

  it('persists the conversation across a turn', async () => {
    const engine = new AssistantEngine()
    await engine.process('what is 2 + 2')
    const messages = useConversationStore.getState().conversation.messages
    expect(messages.some((m) => m.actor === 'user' && m.text.includes('2 + 2'))).toBe(true)
    expect(messages.some((m) => m.actor === 'assistant')).toBe(true)
  })

  it('gates a tool-driven clear-all and cancels without deleting', async () => {
    const engine = new AssistantEngine()
    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))
    await engine.process('remember my name is Jordan')

    const pending = engine.process('forget everything')
    await waitForType(events, 'memory-confirm')
    expect(engine.hasPendingConfirmation).toBe(true)

    engine.cancelPending()
    await pending

    expect(engine.memoryItems()).toHaveLength(1)
    expect(useJarvisStore.getState().lastAssistantText).toMatch(/cancelled/i)
  })

  it('clears all memory only after explicit confirmation', async () => {
    const engine = new AssistantEngine()
    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))
    await engine.process('remember my name is Jordan')

    const pending = engine.process('forget everything')
    await waitForType(events, 'memory-confirm')

    await engine.confirmPending()
    await pending

    expect(engine.memoryItems()).toHaveLength(0)
    expect(engine.getMemoryCount()).toBe(0)
  })

  it('deletes a single memory item through the memory API', async () => {
    const engine = new AssistantEngine()
    await engine.process('remember my name is Jordan')
    const item = engine.memoryItems()[0]
    expect(engine.deleteMemoryItem(item.id)).toBe(true)
    expect(engine.memoryItems()).toHaveLength(0)
  })
})

describe('AssistantEngine (Phase 0.7 — memory lifecycle & context)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    resetProviders()
    useConversationStore.getState().clearConversation()
  })

  it('auto-captures a durable fact (source inferred) when autoMemorize is on', async () => {
    const engine = new AssistantEngine()
    engine.savePreferences({ autoMemorize: true })
    expect(useJarvisStore.getState().preferences.autoMemorize).toBe(true)

    await engine.process('I am a Taurus and I love hiking')

    const captured = engine.memoryItems().find((i) => i.content.includes('Taurus'))
    expect(captured).toBeTruthy()
    expect(captured?.source).toBe('inferred')
    expect(captured?.metadata.episodeId).toBeTruthy()
  })

  it('never auto-captures a question even with autoMemorize on', async () => {
    const engine = new AssistantEngine()
    engine.savePreferences({ autoMemorize: true })
    await engine.process('do you like coffee')
    expect(engine.memoryItems()).toHaveLength(0)
  })

  it('leaves explicit memory commands to the tool (no double capture)', async () => {
    const engine = new AssistantEngine()
    engine.savePreferences({ autoMemorize: true })
    await engine.process('remember my name is Jordan')
    expect(engine.memoryItems()).toHaveLength(1)
    expect(engine.memoryItems()[0].source).toBe('user')
  })

  it('reconciles preferences through the memory record and mirrors them to the store', async () => {
    const engine = new AssistantEngine()
    engine.savePreferences({ voiceEnabled: false, volume: 0.3 })
    expect(useJarvisStore.getState().preferences.voiceEnabled).toBe(false)
    expect(useJarvisStore.getState().preferences.volume).toBe(0.3)
    // A fresh engine loads the same record: memory is the source of truth.
    const reloaded = new AssistantEngine()
    expect(reloaded.memoryState.snapshot().preferences.voiceEnabled).toBe(false)
  })

  it('consolidates stale memory on demand and reports it', () => {
    const now = Date.now()
    const day = 86_400_000
    const oldItem = {
      id: 'mem-old',
      type: 'NOTE',
      content: 'forgot me',
      createdAt: new Date(now - 400 * day).toISOString(),
      updatedAt: new Date(now - 400 * day).toISOString(),
      importance: 0.2,
      source: 'user',
      metadata: {},
    }
    const win = globalThis as {
      window: { localStorage: { setItem: (k: string, v: string) => void } }
    }
    win.window.localStorage.setItem(
      'jarvis.memory',
      JSON.stringify({
        version: 4,
        profile: { name: 'Operator', createdAt: new Date(0).toISOString(), version: '0.4.0' },
        preferences: { voiceEnabled: true, volume: 0.9, animationIntensity: 'high', reducedMotion: false, providerId: 'mock', autoMemorize: false },
        items: [oldItem],
        archive: [],
        episodes: {},
        lifecycle: {},
      }),
    )

    const engine = new AssistantEngine()
    expect(engine.memoryItems()).toHaveLength(1)

    const report = engine.consolidateMemory()
    expect(report.archivedCount).toBe(1)
    expect(engine.memoryItems()).toHaveLength(0)
    expect(engine.archivedMemories()).toHaveLength(1)

    expect(engine.restoreMemoryItem(report.archived[0].id)).toBe(true)
    expect(engine.memoryItems()).toHaveLength(1)
  })

  it('purges the archive permanently via the expunge API', () => {
    const now = Date.now()
    const win = globalThis as {
      window: { localStorage: { setItem: (k: string, v: string) => void } }
    }
    win.window.localStorage.setItem(
      'jarvis.memory',
      JSON.stringify({
        version: 4,
        profile: { name: 'Operator', createdAt: new Date(0).toISOString(), version: '0.4.0' },
        preferences: { voiceEnabled: true, volume: 0.9, animationIntensity: 'high', reducedMotion: false, providerId: 'mock', autoMemorize: false },
        items: [],
        archive: [
          { id: 'arch-1', type: 'FACT', content: 'junk', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), importance: 0.2, source: 'user', metadata: {}, archivedAt: new Date(now).toISOString(), archivedReason: 'stale' },
        ],
        episodes: {},
        lifecycle: {},
      }),
    )
    const engine = new AssistantEngine()
    expect(engine.archivedMemories()).toHaveLength(1)
    expect(engine.expungeArchived()).toBe(1)
    expect(engine.archivedMemories()).toHaveLength(0)
  })
})

describe('AssistantEngine (Phase 0.8 — episode-aware recall)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    resetProviders()
    useConversationStore.getState().clearConversation()
  })

  it('registers the conversation as a session episode and exposes recall APIs', async () => {
    const engine = new AssistantEngine()
    await engine.process('remember my favorite planet is Europa')

    // The episode is closed when the turn ends.
    expect(engine.activeEpisode()).toBeNull()

    const episodes = engine.episodes()
    expect(episodes.length).toBeGreaterThanOrEqual(1)
    const ep = episodes[0]
    expect(ep.itemCount).toBeGreaterThanOrEqual(1)

    const inEp = engine.episodeMemories(ep.id)
    expect(inEp.some((m) => m.content.includes('Europa'))).toBe(true)

    // The recalled memory survives a fresh engine (persistence).
    const reloaded = new AssistantEngine()
    expect(reloaded.episodeMemories(ep.id).some((m) => m.content.includes('Europa'))).toBe(true)
  })

  it('keeps episodes distinct per conversation session', async () => {
    const engine = new AssistantEngine()
    await engine.process('remember my name is Dinah')
    await engine.process('remember my favorite drink is coffee')
    // The conversation id follows the store — force a fresh session next:
    useConversationStore.getState().clearConversation()
    await engine.process('remember my second name is Ruth')

    expect(engine.episodes().length).toBeGreaterThanOrEqual(2)
    const allItems = engine.episodes().flatMap((e) => engine.episodeMemories(e.id))
    expect(allItems.some((m) => m.content.includes('Dinah'))).toBe(true)
    expect(allItems.some((m) => m.content.includes('Ruth'))).toBe(true)
  })
})