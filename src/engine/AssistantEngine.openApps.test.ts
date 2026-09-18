import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import type { EngineOutMessage } from './contracts'
import { FakeObservationProvider } from '../observation/testing'
import type { ObservationSeed } from '../observation/testing'
import { useConversationStore } from '../state/conversation.store'

vi.mock('../native/nativeAgentEnv', () => ({
  readAgentEnv: () => undefined,
  readNativeAgentEnv: () => undefined,
}))

/**
 * "What applications are open?" must reach the REAL desktop read and answer
 * with the real inventory.
 *
 * The live regression this pins: the question was hijacked by the UI-control
 * surface (the word "open" read as a command for the Applications PANEL), so
 * JARVIS replied "Opened the Applications panel." to an information request
 * instead of listing the windows that actually exist.
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

describe('"what applications are open?" — real desktop read', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('runs window.list and never opens the Applications panel', async () => {
    const observation = new FakeObservationProvider(DESKTOP)
    const engine = new AssistantEngine({ observation })
    const { replies } = collectReplies(engine)

    await engine.process('Tell me what applications are open')

    const reply = replies.at(-1) ?? ''
    expect(reply).not.toContain('panel')
    // The read really ran against the injected desktop...
    expect(observation.listCalls).toBe(1)
    // ...and the run is honest about what was read.
    expect(reply).toMatch(/answered from a live reading|Done\./)
    // The user-facing reply DETERMINISTICALLY names the real observed
    // inventory (the splice renders the on-record reading; it never invents).
    expect(reply).toContain('chrome')
    expect(reply).toContain('notepad')
    expect(engine.taskResult().status).toBe('completed')
  })

  it('exposes the real inventory on the run trace (the model sees it)', async () => {
    const observation = new FakeObservationProvider(DESKTOP)
    const engine = new AssistantEngine({ observation })

    await engine.process('what applications are open?')

    const trace = engine.lastRunTrace()
    const summary = trace.steps.map((s) => s.observation?.summary ?? '').join('\n')
    expect(summary).toContain('chrome')
    expect(summary).toContain('notepad')
    // Windows shell chrome and hidden windows are not advertised as apps.
    expect(summary).not.toContain('Program Manager')
    expect(summary).not.toContain('Background Helper')
    expect(trace.steps[0]?.toolId).toBe('window.list')
  })

  it('is honest when the desktop cannot be observed at all', async () => {
    const observation = new FakeObservationProvider(DESKTOP)
    observation.setAvailable(false, 'Native agent currently offline.')
    const engine = new AssistantEngine({ observation })
    const { replies } = collectReplies(engine)

    await engine.process('what applications are open?')

    const reply = replies.at(-1) ?? ''
    expect(reply).not.toContain('panel')
    // The failure is reported, and no application list is invented.
    expect(reply).toMatch(/not available|failed/i)
    expect(reply).not.toContain('chrome')
  })
})
