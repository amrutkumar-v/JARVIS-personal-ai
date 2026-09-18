import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import type { EngineOutMessage } from './contracts'
import { FakeApplicationProvider } from '../applications/testing'
import { FakeDesktopInteractionProvider } from '../desktop/testing'
import { useConversationStore } from '../state/conversation.store'
import type { ClipboardProvider, ClipboardReadResult, ClipboardWriteResult } from '../clipboard'

/**
 * Regression — real-windows execution audit (typing verification).
 *
 * The old pipeline planned desktop.type → clipboard.read but NOTHING ever sent
 * select-all + copy, so the clipboard read could only see stale content: honest
 * typing was refuted or stale content was laundered into "verified". Now the
 * observation plan carries pre-observe actions (real registered tools, executed
 * through the regular rails) and the empty clipboard can never verify.
 *
 * Also pins the reply wording: a failed typing verification is reported
 * cause-neutrally with the verifier's REAL message — never a speculative
 * cause (e.g. UIPI) the verification layer did not actually observe.
 */

vi.mock('../native/nativeAgentEnv', () => ({
  readAgentEnv: () => undefined,
  readNativeAgentEnv: () => undefined,
}))

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

const NOTEPAD_SEED = { applicationId: 'notepad', name: 'Notepad', displayName: 'Notepad', launchOutcome: 'verified' as const }

/** Scripted clipboard: the read result is set by the TEST at the right moment. */
class ScriptedClipboardProvider implements ClipboardProvider {
  readonly id = 'scripted-clipboard'
  private nextRead: ClipboardReadResult = { success: true, text: '', byteLength: 0, verified: true }
  reads = 0

  setRead(result: ClipboardReadResult): void {
    this.nextRead = result
  }

  capabilities() {
    return { available: true, ops: { read: true, write: true } }
  }

  async read(): Promise<ClipboardReadResult> {
    this.reads += 1
    return this.nextRead
  }

  async write(text: string): Promise<ClipboardWriteResult> {
    return { success: true, byteLength: text.length, verified: true }
  }
}

function collectReplies(engine: AssistantEngine): { replies: string[] } {
  const replies: string[] = []
  engine.on((m: EngineOutMessage) => {
    if (m.type === 'transcript' && m.speaker === 'assistant') replies.push(m.text)
  })
  return { replies }
}

const GOAL = 'Open Notepad and type hello'

describe('typing verification — pre-observe actions and honest wording', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    vi.restoreAllMocks()
  })

  it('A — verified path: type → select-all → copy → clipboard read runs IN ORDER and the text is confirmed', async () => {
    const clipboard = new ScriptedClipboardProvider()
    const desktop = new FakeDesktopInteractionProvider([{ windowId: '31', title: 'Untitled - Notepad', focusable: true }])
    const engine = new AssistantEngine({
      providers: [],
      applications: new FakeApplicationProvider([NOTEPAD_SEED]),
      desktop,
      clipboard,
    })
    engine.on(() => undefined)
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    // The copy (pre-observe) puts the typed text on the clipboard.
    clipboard.setRead({ success: true, text: 'hello', byteLength: 5, verified: true })

    const request = await engine.orchestrate(GOAL)
    const planned = engine.planOrchestrated(request)
    const result = await engine.executeOrchestrated(request)

    // Plan shape: launch → type, and the type step is post-action verified.
    expect(planned.steps.map((s) => s.capability)).toEqual(['open_application', 'type_text'])
    expect(result.verifiedSteps).toBe(2)

    // Execution order on the REAL desktop provider: type first, then the two
    // pre-observe hotkeys, i.e. the clipboard evidence is produced AFTER typing.
    const ops = desktop.interactionLog.map((e) => e.name)
    expect(ops.indexOf('type')).toBeGreaterThanOrEqual(0)
    const typeIdx = ops.indexOf('type')
    const hotkeyIdx = ops.indexOf('hotkey')
    expect(hotkeyIdx).toBeGreaterThan(typeIdx)
    expect(desktop.calls.hotkey).toBe(2)
    expect(clipboard.reads).toBe(1)
  })

  it('B — pre-observe hotkey failure keeps the step UNVERIFIED (observation honestly fails, never fabricated)', async () => {
    const clipboard = new ScriptedClipboardProvider()
    // A clipboard that still holds OLD content — the copy failed, so the read
    // must NOT confirm typing even though the text happens to be absent.
    clipboard.setRead({ success: true, text: 'stale-content', byteLength: 13, verified: true })
    const desktop = new FakeDesktopInteractionProvider([{ windowId: '31', title: 'Untitled - Notepad', focusable: true }])
    // The hotkey bridge is DEAD for the whole run: select-all and copy can
    // never succeed, so no clipboard evidence can ever be produced.
    vi.spyOn(desktop, 'hotkey').mockRejectedValue(new Error('injected hotkey fault'))
    const engine = new AssistantEngine({
      providers: [],
      applications: new FakeApplicationProvider([NOTEPAD_SEED]),
      desktop,
      clipboard,
    })
    engine.on(() => undefined)

    const result = await engine.executeOrchestrated(await engine.orchestrate(GOAL))

    // Typing itself ran, but the broken pre-observe means NO clipboard evidence:
    // the step must stay executed-unverified (never upgraded). The engine's
    // bounded retry may recover individual hotkey faults, so the decisive
    // assertion is the ABSENCE of evidence: zero clipboard reads.
    expect(desktop.calls.type).toBe(1)
    expect(clipboard.reads).toBe(0) // observation aborted — no evidence read
    const typeStep = result.steps.find((s) => s.capability === 'type_text')
    expect(typeStep?.status).toBe('success')
    expect(typeStep?.verified).toBe(false)
    expect(result.verifiedSteps).toBe(1) // only the launch is verified
  })

  it('C — empty clipboard never verifies typing (select-all found nothing to copy)', async () => {
    const clipboard = new ScriptedClipboardProvider()
    clipboard.setRead({ success: true, text: '', byteLength: 0, verified: true })
    const desktop = new FakeDesktopInteractionProvider([{ windowId: '31', title: 'Untitled - Notepad', focusable: true }])
    const engine = new AssistantEngine({
      providers: [],
      applications: new FakeApplicationProvider([NOTEPAD_SEED]),
      desktop,
      clipboard,
    })
    engine.on(() => undefined)

    const result = await engine.executeOrchestrated(await engine.orchestrate(GOAL))

    const typeStep = result.steps.find((s) => s.capability === 'type_text')
    expect(typeStep?.status).toBe('success')
    expect(typeStep?.verified).toBe(false)
    // The failure note reflects the REAL verifier message (cause-neutral).
    expect(typeStep?.observation?.summary).toMatch(/empty clipboard/i)
  })

  it('D — reply wording is cause-neutral: reports the real verifier message, never a speculative UIPI cause', async () => {
    const clipboard = new ScriptedClipboardProvider()
    clipboard.setRead({ success: true, text: '', byteLength: 0, verified: true })
    const desktop = new FakeDesktopInteractionProvider([{ windowId: '31', title: 'Untitled - Notepad', focusable: true }])
    const engine = new AssistantEngine({
      providers: [],
      applications: new FakeApplicationProvider([NOTEPAD_SEED]),
      desktop,
      clipboard,
    })
    const { replies } = collectReplies(engine)

    await engine.process(GOAL)

    const reply = replies.at(-1) ?? ''
    expect(reply).toContain('verified')
    expect(reply).not.toMatch(/UIPI/i)
    expect(reply).toMatch(/empty clipboard/i)
  })

  it('E — verified typing path through process(): launch and type both verified, reply reports full verification', async () => {
    const clipboard = new ScriptedClipboardProvider()
    clipboard.setRead({ success: true, text: 'hello', byteLength: 5, verified: true })
    const desktop = new FakeDesktopInteractionProvider([{ windowId: '31', title: 'Untitled - Notepad', focusable: true }])
    const engine = new AssistantEngine({
      providers: [],
      applications: new FakeApplicationProvider([NOTEPAD_SEED]),
      desktop,
      clipboard,
    })
    const { replies } = collectReplies(engine)

    await engine.process(GOAL)

    const reply = replies.at(-1) ?? ''
    expect(reply).toMatch(/all 2 steps completed and verified/)
    // And the machinery really ran: one type, two pre-observe hotkeys, one read.
    expect(desktop.calls.type).toBe(1)
    expect(desktop.calls.hotkey).toBe(2)
    expect(clipboard.reads).toBe(1)
  })
})
