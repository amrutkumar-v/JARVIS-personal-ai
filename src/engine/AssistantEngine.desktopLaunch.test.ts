import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import type { EngineOutMessage } from './contracts'
import { FakeApplicationProvider } from '../applications/testing'
import type { AppSeed } from '../applications/testing'
import { FakeDesktopInteractionProvider } from '../desktop/testing'
import { isFileOrFolderTarget, toAppId } from './orchestrator/planner'
import { useConversationStore } from '../state/conversation.store'

// The engine is constructed with the default bootstrap, which reads the native
// env. Stub it so this suite is deterministically driven by the provider we
// inject (the dev server keeps a real URL in `.env.local`).
vi.mock('../native/nativeAgentEnv', () => ({
  readNativeAgentEnv: () => undefined,
}))

/**
 * PHASE 1 — REAL WINDOWS DESKTOP CONTROL: the four launch actions.
 *
 * Notepad, Calculator, Chrome and File Explorer already launch through the
 * existing native path (`app.launch` -> `open_application` -> native registry).
 * These tests pin the CONTRACT around them at the only layer unit tests can
 * own honestly: the real orchestration, permission and verification logic, with
 * the OS boundary (the application provider) mocked.
 *
 * Real process execution is covered separately by the Windows runtime smoke
 * test; `native/src/appBackend.test.ts` owns pre-spawn validation.
 *
 * The four rules that must never regress:
 *   - only registered ids launch; paths and shell strings never do
 *   - a launch is only "verified" when the provider OBSERVED the process
 *   - launch-ok-but-unverified stays unverified (never reported as success)
 *   - a denial executes nothing at all
 */

/* ---------------------------------------------------------------- fixtures */

const PHASE1_APPS: AppSeed[] = [
  { applicationId: 'notepad', name: 'Notepad' },
  { applicationId: 'calculator', name: 'Calculator' },
  { applicationId: 'chrome', name: 'Chrome' },
  { applicationId: 'file-explorer', name: 'File Explorer' },
]

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

function collectReplies(engine: AssistantEngine): string[] {
  const replies: string[] = []
  engine.on((m: EngineOutMessage) => {
    if (m.type === 'transcript' && m.speaker === 'assistant') replies.push(m.text)
  })
  return replies
}

/* ------------------------------------------------------------------ tests */

describe('Phase 1 — planner target classification', () => {
  it('treats "File Explorer" as the application it is, not a folder noun', () => {
    // Regression: the file/folder guard contains the word "file", so it used to
    // swallow "file explorer" and refuse the launch as a folder target.
    expect(isFileOrFolderTarget('file explorer')).toBe(false)
    expect(isFileOrFolderTarget('file-explorer')).toBe(false)
    expect(isFileOrFolderTarget('explorer')).toBe(false)
  })

  it('still refuses genuine file/folder nouns', () => {
    for (const phrase of ['my downloads', 'that folder', 'documents', 'this file', 'my pictures']) {
      expect(isFileOrFolderTarget(phrase)).toBe(true)
    }
  })

  it('slugs every Phase 1 name into a wire-safe registry id', () => {
    expect(toAppId('notepad')).toBe('notepad')
    expect(toAppId('calculator')).toBe('calculator')
    expect(toAppId('chrome')).toBe('chrome')
    // The native wire id pattern forbids spaces, so this must be hyphenated.
    expect(toAppId('file explorer')).toBe('file-explorer')
  })
})

describe('Phase 1 — Windows desktop control: the four launch actions', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  /* -- 1-4: each of the four requested launches actually executes ---------- */

  const launches: ReadonlyArray<readonly [string, string, string]> = [
    ['Notepad', 'notepad', 'Open Notepad.'],
    ['Calculator', 'calculator', 'Open Calculator.'],
    ['Chrome', 'chrome', 'Open Chrome.'],
    ['File Explorer', 'file-explorer', 'Open File Explorer.'],
  ]

  for (const [label, id, request] of launches) {
    it(`1-4. "${request}" launches ${label} and reports a verified result`, async () => {
      const apps = new FakeApplicationProvider(PHASE1_APPS)
      const engine = new AssistantEngine({ applications: apps })
      const replies = collectReplies(engine)

      await engine.process(request)

      expect(apps.launchCount(id)).toBe(1)
      const reply = replies.at(-1) ?? ''
      expect(reply).not.toMatch(/local-dev mode with a development provider/)
      expect(reply).toContain('Done.')
      expect(reply).toMatch(/all 1 step completed and verified/)
    })
  }

  it('normalizes a multi-word application name to its registry id', async () => {
    // "File Explorer" must reach the native registry as "file-explorer": the
    // wire id pattern forbids spaces, so the planner slugifies the phrase.
    const apps = new FakeApplicationProvider(PHASE1_APPS)
    const engine = new AssistantEngine({ applications: apps })

    await engine.process('Open File Explorer.')

    expect(apps.launchCount('file-explorer')).toBe(1)
    // A space-separated id must never reach the provider at all.
    expect(apps.launchCount('file explorer')).toBe(0)
  })

  /* -- 5-7: nothing outside the registry may ever be launched -------------- */

  it('5. rejects an unknown application id without side effects', async () => {
    const apps = new FakeApplicationProvider(PHASE1_APPS)
    const engine = new AssistantEngine({ applications: apps })
    const replies = collectReplies(engine)

    await engine.process('Open totally-unknown-app-xyz.')

    const launched = PHASE1_APPS.map((a) => apps.launchCount(a.applicationId))
    expect(launched.every((n) => n === 0)).toBe(true)
    expect(replies.at(-1) ?? '').not.toContain('Done.')
  })

  const injections: ReadonlyArray<readonly [string, string]> = [
    ['6. an arbitrary executable path', 'Open C:\\Windows\\System32\\cmd.exe.'],
    ['6. an arbitrary executable filename', 'Open cmd.exe.'],
    ['7. a chained shell command', 'Open calc && echo hacked.'],
  ]

  for (const [label, request] of injections) {
    it(`${label} is refused, and nothing is launched`, async () => {
      const apps = new FakeApplicationProvider(PHASE1_APPS)
      const engine = new AssistantEngine({ applications: apps })
      const replies = collectReplies(engine)

      await engine.process(request)

      const launched = PHASE1_APPS.map((a) => apps.launchCount(a.applicationId))
      expect(launched.every((n) => n === 0)).toBe(true)
      expect(replies.at(-1) ?? '').not.toContain('Done.')
    })
  }

  it('7. an injected shell operator never becomes a shell command', async () => {
    // "open notepad; shutdown /s" reads as a sentence boundary, so opening
    // Notepad is legitimate. What must never happen is the second clause being
    // executed as a command: no extra application is launched and no such
    // target is ever produced.
    const apps = new FakeApplicationProvider(PHASE1_APPS)
    const engine = new AssistantEngine({ applications: apps })

    await engine.process('Open notepad; shutdown /s.')

    // Notepad is the only thing that may have been opened.
    expect(apps.launchCount('notepad')).toBe(1)
    expect(apps.launchCount('calculator')).toBe(0)
    expect(apps.launchCount('chrome')).toBe(0)
    expect(apps.launchCount('file-explorer')).toBe(0)
  })

  /* -- 8-10: verification must be honest ----------------------------------- */

  it('8. a launch the provider OBSERVED running is reported verified', async () => {
    const apps = new FakeApplicationProvider([
      { applicationId: 'notepad', name: 'Notepad', launchOutcome: 'verified' },
    ])
    const engine = new AssistantEngine({ applications: apps })
    const replies = collectReplies(engine)

    await engine.process('Open Notepad.')

    expect(apps.launchCount('notepad')).toBe(1)
    expect(replies.at(-1) ?? '').toMatch(/all 1 step completed and verified/)
  })

  it(
    '9. launch succeeds but the process was NOT observed -> unverified, never success',
    async () => {
      const apps = new FakeApplicationProvider([
        { applicationId: 'chrome', name: 'Chrome', launchOutcome: 'unverified' },
      ])
      const engine = new AssistantEngine({ applications: apps })
      const replies = collectReplies(engine)

      await engine.process('Open Chrome.')

      // The launch DID happen...
      expect(apps.launchCount('chrome')).toBe(1)
      const reply = replies.at(-1) ?? ''
      // ...but the run must not be painted as fully verified.
      expect(reply).not.toMatch(/all 1 step completed and verified/)
      expect(reply).toMatch(/Partially done|could not be confirmed|unverified|could not verify|not verified/i)
    },
    30000,
  )

  it('10. a launch fault is reported as failed with the real reason', async () => {
    const apps = new FakeApplicationProvider([
      {
        applicationId: 'notepad',
        name: 'Notepad',
        fail: { op: 'launch', code: 'io', message: 'The target could not be started.' },
      },
    ])
    const engine = new AssistantEngine({ applications: apps })
    const replies = collectReplies(engine)

    await engine.process('Open Notepad.')

    expect(apps.launchCount('notepad')).toBe(0)
    const reply = replies.at(-1) ?? ''
    expect(reply).toContain('The target could not be started.')
    expect(reply).not.toContain('Done.')
  })

  /* -- 11: a denial must execute nothing ---------------------------------- */

  it('11. a denied (disabled) application is never executed', async () => {
    const apps = new FakeApplicationProvider([
      { applicationId: 'notepad', name: 'Notepad', enabled: false },
    ])
    const engine = new AssistantEngine({ applications: apps })
    const replies = collectReplies(engine)

    await engine.process('Open Notepad.')

    expect(apps.launchCount('notepad')).toBe(0)
    expect(replies.at(-1) ?? '').not.toContain('Done.')
  })

  it('11. a non-launchable application is never executed', async () => {
    const apps = new FakeApplicationProvider([
      { applicationId: 'calculator', name: 'Calculator', launchable: false },
    ])
    const engine = new AssistantEngine({ applications: apps })

    await engine.process('Open Calculator.')

    expect(apps.launchCount('calculator')).toBe(0)
  })

  /* -- truthfulness of the compound planner fallback ---------------------- */

  it(
    'never falls back to launching Notepad when the target app is unknown',
    async () => {
      // A compound "open + type" request whose app cannot be identified must NOT
      // silently open some other application.
      const apps = new FakeApplicationProvider(PHASE1_APPS)
      const desktop = new FakeDesktopInteractionProvider([
        { windowId: '1', title: 'Notepad', focusable: true },
      ])
      const engine = new AssistantEngine({ applications: apps, desktop })
      const replies = collectReplies(engine)

      await engine.process('Write "hello" into my editor and then copy it.')

      expect(apps.launchCount('notepad')).toBe(0)
      expect(replies.at(-1) ?? '').not.toMatch(/all 1 step completed and verified/)
    },
    30000,
  )
})