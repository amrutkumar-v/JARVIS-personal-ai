import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import type { EngineOutMessage } from './contracts'
import { FakeApplicationProvider } from '../applications/testing'
import { FakeDesktopInteractionProvider } from '../desktop/testing'
import type { WebProvider, WebSearchResponse, WebCapabilities } from '../web/provider'
import { useConversationStore } from '../state/conversation.store'

// `new AssistantEngine({})` engines use the default bootstrap. Mock the native
// env read so this suite's "live-UI shape" is deterministically WITHOUT native
// surfaces (the dev server keeps the real URL from `.env.local`).
vi.mock('../native/nativeAgentEnv', () => ({
  readNativeAgentEnv: () => undefined,
}))

/**
 * PHASE 5 — LIVE RUNTIME regression (process()-level, mirrors useAssistant).
 *
 * The REAL user-facing path is `process()`, not the per-method orchestrator
 * bridge. These tests drive the EXACT routing the browser UI uses: a mock
 * provider (no real AI configured) with the native surfaces optionally bound,
 * exactly like `.env.local` (with/without VITE_NATIVE_AGENT_URL) produces.
 *
 * Core acceptance: an executable request must NEVER leak into the mock
 * provider's canned "local-dev mode with a development provider" reply.
 */

/* ---------------------------------------------------------------- fixtures */

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

function collectReplies(engine: AssistantEngine): { replies: string[] } {
  const replies: string[] = []
  engine.on((m: EngineOutMessage) => {
    if (m.type === 'transcript' && m.speaker === 'assistant') replies.push(m.text)
  })
  return { replies }
}

function lastReply(replies: string[]): string {
  return replies.at(-1) ?? ''
}

function recordingWebProvider(): { provider: WebProvider; searchCalls: () => number } {
  let calls = 0
  const provider: WebProvider = {
    id: 'recording-web',
    capabilities(): WebCapabilities {
      return { available: true, search: true, fetch: true, download: true }
    },
    async search(query: string): Promise<WebSearchResponse> {
      calls += 1
      return {
        query,
        provider: 'recording',
        servedAt: Date.now(),
        results: [{ title: 'KLE Technological University', url: 'https://kleit.ac.in', snippet: 'KLE Tech official site.' }],
        freshness: { detectable: false, note: 'not detectable' },
      }
    },
    async fetchDocument(url: string) {
      throw new Error(`not used in this test: ${url}`)
    },
    async download(url: string) {
      throw new Error(`not used in this test: ${url}`)
    },
  }
  return { provider, searchCalls: () => calls }
}

const CANNED = 'local-dev mode with a development provider'

const NOTEPAD_SEED = { applicationId: 'notepad', name: 'Notepad', launchOutcome: 'verified' as const }

/* ---------------------------------------------------------------- tests */

describe('Phase 5 live runtime (process(), mock provider, no AI configured)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('F — live-UI shape WITHOUT native surfaces: blocked plan → honest refusal, NOT canned', async () => {
    const engine = new AssistantEngine({})
    const { replies } = collectReplies(engine)

    await engine.process('Open Notepad and introduce yourself in written format.')

    const reply = lastReply(replies)
    expect(reply).not.toContain(CANNED)
    expect(reply).toContain('I cannot')
    expect(reply).toContain('open_application is not available')
  })

  it('F2 — live-UI shape WITHOUT web: blocked search → honest refusal, NOT canned', async () => {
    const engine = new AssistantEngine({})
    const { replies } = collectReplies(engine)

    await engine.process('Search for KLE Technological University.')

    const reply = lastReply(replies)
    expect(reply).not.toContain(CANNED)
    expect(reply).toContain('I cannot')
    expect(reply).toContain('web_search is not available')
  })

  it('A — "Open Notepad." with native application surface: plan executes, verified, Done', async () => {
    const apps = new FakeApplicationProvider([NOTEPAD_SEED])
    const engine = new AssistantEngine({ applications: apps })
    const { replies } = collectReplies(engine)

    await engine.process('Open Notepad.')

    const reply = lastReply(replies)
    expect(reply).not.toContain(CANNED)
    expect(reply).toContain('Done.')
    expect(apps.launchCount('notepad')).toBe(1)
    expect(reply).toMatch(/all 1 step completed and verified/)
  })

  it('B — "Open Chrome." when unreachable/unregistered: honest failure, NOT canned, ZERO side effects', async () => {
    const apps = new FakeApplicationProvider([NOTEPAD_SEED])
    const engine = new AssistantEngine({ applications: apps })
    const { replies } = collectReplies(engine)

    await engine.process('Open Chrome.')

    const reply = lastReply(replies)
    expect(reply).not.toContain(CANNED)
    expect(apps.launchCount('chrome')).toBe(0)
    expect(reply).not.toContain('Done.')
  })

  it('read-only status question: answered from a live reading, NOT a FAILED partial', async () => {
    const apps = new FakeApplicationProvider([NOTEPAD_SEED])
    const engine = new AssistantEngine({ applications: apps })
    const { replies } = collectReplies(engine)

    await engine.process('Is Notepad running?')

    const reply = lastReply(replies)
    expect(reply).not.toContain(CANNED)
    // The read IS the deliverable: it answers, and the run is NOT painted
    // failed ("0 of 1 verified") just because a read cannot be re-verified.
    expect(reply).toContain('Done.')
    expect(reply).toContain('answered from a live reading')
    expect(reply).not.toContain('Partially done')
    expect(engine.taskResult().status).toBe('completed')
  })

  it('C — "Open Notepad and introduce yourself in written format.": open THEN type as separate steps', async () => {
    const apps = new FakeApplicationProvider([NOTEPAD_SEED])
    const desktop = new FakeDesktopInteractionProvider([{ windowId: '1', title: 'Notepad', focusable: true }])
    const engine = new AssistantEngine({ applications: apps, desktop })
    const { replies } = collectReplies(engine)

    await engine.process('Open Notepad and introduce yourself in written format.')

    const reply = lastReply(replies)
    expect(reply).not.toContain(CANNED)
    // Both supported parts ran, in the planned order: app first, then typing.
    expect(apps.launchCount('notepad')).toBe(1)
    expect(desktop.calls.type).toBe(1)
    expect(desktop.interactionLog.map((e) => e.name)).toContain('type')
    expect(reply).toMatch(/Done\.|Partially done\./)
    // The typed introduction was attempted (text never leaves the provider).
    expect(desktop.interactionLog.some((e) => e.name === 'type' && (e.textLength ?? 0) > 0)).toBe(true)
    expect(reply).not.toContain('I cannot')
  })

  it('D — "Search for KLE Technological University.": real web_search runs, NOT canned', async () => {
    const { provider, searchCalls } = recordingWebProvider()
    const engine = new AssistantEngine({ web: provider })
    const { replies } = collectReplies(engine)

    await engine.process('Search for KLE Technological University.')

    const reply = lastReply(replies)
    expect(reply).not.toContain(CANNED)
    expect(searchCalls()).toBe(1)
    expect(reply).not.toContain('I cannot')
  })

  it('E — local tools KEEP working through the provider loop (no regression)', async () => {
    const engine = new AssistantEngine({})
    const { replies } = collectReplies(engine)

    await engine.process('what time is it')

    const reply = lastReply(replies)
    expect(reply).not.toContain(CANNED)
    expect(reply).toMatch(/clock/i)
  })
})