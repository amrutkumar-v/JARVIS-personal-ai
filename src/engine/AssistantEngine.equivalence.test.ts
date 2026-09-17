import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import type { EngineOutMessage } from './contracts'
import { FakeApplicationProvider } from '../applications/testing'
import type { AppSeed } from '../applications/testing'
import { FakeObservationProvider } from '../observation/testing'
import type { ObservationSeed } from '../observation/testing'
import { useConversationStore } from '../state/conversation.store'

// Deterministic "no native surfaces" bootstrap, mirroring the other
// process()-level suites.
vi.mock('../native/nativeAgentEnv', () => ({
  readAgentEnv: () => undefined,
  readNativeAgentEnv: () => undefined,
}))

/**
 * Spec item 1 — natural-language equivalent requests resolve consistently.
 *
 * The same real intent, expressed in different phrasings, must converge on the
 * SAME canonical plan: the same tools, the same targets, the same verdict. No
 * phrasing may leak into a different surface (e.g. the word "open" hijacking
 * the UI-control panel), and no phrasing may change what actually executes.
 *
 * These suites drive the REAL AssistantEngine (deterministic orchestration; no
 * AI is required for these intents) and assert the executed record per phrasing.
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

const NOTEPAD_SEED: AppSeed = { applicationId: 'notepad', name: 'Notepad', displayName: 'Notepad', launchOutcome: 'verified' }

const DESKTOP: ObservationSeed[] = [
  { windowId: '11', title: 'Program Manager', pid: 100, processName: 'explorer.exe', visible: true, minimized: false, maximized: false },
  { windowId: '12', title: 'New Tab - Google Chrome', pid: 200, processName: 'chrome.exe', visible: true, minimized: false, maximized: false },
  { windowId: '13', title: 'Untitled - Notepad', pid: 300, processName: 'notepad.exe', visible: true, minimized: false, maximized: false },
  { windowId: '14', title: 'Background Helper', pid: 400, processName: 'helper.exe', visible: false, minimized: true, maximized: false },
]

function collectReplies(engine: AssistantEngine): { replies: string[] } {
  const replies: string[] = []
  engine.on((m: EngineOutMessage) => {
    if (m.type === 'transcript' && m.speaker === 'assistant') replies.push(m.text)
  })
  return { replies }
}

function bootstrap(): void {
  stubBrowserStorage()
  useConversationStore.getState().clearConversation()
}

const LAUNCH_PHRASINGS = [
  'Open Notepad.',
  'Please open Notepad',
  'Can you open Notepad?',
  'Launch Notepad',
  'Could you please open Notepad?',
]

describe('NL-equivalent requests — launch family ("open Notepad")', () => {
  beforeEach(bootstrap)

  it('every phrasing produces the SAME one-step verified app.launch plan (never a UI-control hijack)', async () => {
    for (const phrasing of LAUNCH_PHRASINGS) {
      const apps = new FakeApplicationProvider([NOTEPAD_SEED])
      const engine = new AssistantEngine({ applications: apps })
      const { replies } = collectReplies(engine)

      await engine.process(phrasing)

      const reply = replies.at(-1) ?? ''
      expect(reply, phrasing).not.toContain('panel')
      expect(reply, phrasing).toMatch(/Done\./)
      // Exactly ONE launch of EXACTLY the canonical app, independently verified.
      expect(apps.launchCount('notepad'), phrasing).toBe(1)
      expect(engine.taskResult().status, phrasing).toBe('completed')
      const trace = engine.lastRunTrace()
      expect(trace.finalState, phrasing).toBe('completed')
      expect(trace.steps, phrasing).toHaveLength(1)
      expect(trace.steps[0]?.toolId, phrasing).toBe('app.launch')
    }
  })

  it('repeated requests keep converging on the same canonical plan (no drift across phrashings)', async () => {
    // A single engine, many phrasings in sequence: each turn still executes the
    // SAME one-step notepad launch (exactly +1 per request) and the answer is
    // always composed by the engine's deterministic formatter.
    const apps = new FakeApplicationProvider([NOTEPAD_SEED])
    const engine = new AssistantEngine({ applications: apps })
    const { replies } = collectReplies(engine)

    for (const phrasing of LAUNCH_PHRASINGS) {
      const before = apps.launchCount('notepad')
      await engine.process(phrasing)
      expect(apps.launchCount('notepad'), phrasing).toBe(before + 1)
      expect(replies.at(-1), phrasing).toMatch(/Done\./)
      expect(engine.taskResult().status, phrasing).toBe('completed')
    }
  })
})

const READ_PHRASINGS = [
  'Tell me what applications are open',
  'What applications are open?',
  'Which apps are running?',
  'List the programs that are currently open',
  'Show me which windows are open right now',
]

describe('NL-equivalent requests — running-apps read family ("what apps are open")', () => {
  beforeEach(bootstrap)

  it('every phrasing runs ONE real desktop read and never opens a UI panel', async () => {
    for (const phrasing of READ_PHRASINGS) {
      const observation = new FakeObservationProvider(DESKTOP)
      const engine = new AssistantEngine({ observation })
      const { replies } = collectReplies(engine)

      await engine.process(phrasing)

      const reply = replies.at(-1) ?? ''
      expect(reply, phrasing).not.toContain('panel')
      expect(observation.listCalls, phrasing).toBe(1)
      expect(engine.taskResult().status, phrasing).toBe('completed')
      const trace = engine.lastRunTrace()
      expect(trace.finalState, phrasing).toBe('completed')
      expect(trace.steps, phrasing).toHaveLength(1)
      expect(trace.steps[0]?.toolId, phrasing).toBe('window.list')
    }
  })

  it('the observable inventory the model sees is identical regardless of phrasing', async () => {
    const inventories: string[] = []
    for (const phrasing of READ_PHRASINGS) {
      const observation = new FakeObservationProvider(DESKTOP)
      const engine = new AssistantEngine({ observation })
      await engine.process(phrasing)
      inventories.push(engine.lastRunTrace().steps.map((s) => s.observation?.summary ?? '').join('\n'))
    }
    for (const other of inventories.slice(1)) {
      expect(other).toBe(inventories[0])
    }
    expect(inventories[0]).toContain('chrome')
    expect(inventories[0]).toContain('notepad')
    expect(inventories[0]).not.toContain('Program Manager')
    expect(inventories[0]).not.toContain('Background Helper')
  })
})