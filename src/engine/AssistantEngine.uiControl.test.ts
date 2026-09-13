import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import type { EngineOutMessage } from './contracts'
import { useConversationStore } from '../state/conversation.store'
import { usePanelLayoutStore } from '../panel/panelStore'
import { useJarvisStore } from '../state/jarvis.store'

// `new AssistantEngine({})` engines use the default bootstrap. Mock the native
// env read so this suite's shape is deterministically WITHOUT native surfaces.
vi.mock('../native/nativeAgentEnv', () => ({
  readNativeAgentEnv: () => undefined,
}))

/**
 * PHASE 9 — deterministic UI-control runtime regression (process()-level,
 * mirrors useAssistant). Recognised self-interaction commands must execute the
 * REAL panel/environment store actions and report the actual post-condition.
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

function lastReply(out: { replies: string[] }): string {
  return out.replies.at(-1) ?? ''
}

function collect(engine: AssistantEngine): { replies: string[]; notices: string[]; statuses: string[] } {
  const replies: string[] = []
  const notices: string[] = []
  const statuses: string[] = []
  engine.on((m: EngineOutMessage) => {
    if (m.type === 'transcript' && m.speaker === 'assistant') replies.push(m.text)
    if (m.type === 'notice') notices.push(m.text)
    if (m.type === 'status') statuses.push(m.status)
  })
  return { replies, notices, statuses }
}

describe('Phase 9 live runtime (process(), UI-control surface)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    usePanelLayoutStore.getState().resetLayout()
    useJarvisStore.getState().resetRun()
    useJarvisStore.getState().setTheme('classic')
  })

  it('"switch to astra" switches the real environment store', async () => {
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('switch to astra')

    expect(usePanelLayoutStore.getState().environmentId).toBe('astra')
    expect(lastReply(out)).toBe('Switched to Astra HUD.')
    expect(out.statuses).toContain('executing')
    expect(out.statuses).toContain('success')
  })

  it('already being in the target environment is reported honestly', async () => {
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('go to the arc reactor')

    expect(usePanelLayoutStore.getState().environmentId).toBe('arc')
    expect(lastReply(out)).toBe('You are already in the Arc Reactor environment.')
  })

  it('"next environment" steps the registry and reports the real target', async () => {
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('next environment')

    expect(usePanelLayoutStore.getState().environmentId).toBe('astra')
    expect(lastReply(out)).toBe('Switched to Astra HUD.')
  })

  it('"previous environment" wraps backwards', async () => {
    usePanelLayoutStore.getState().setEnvironment('astra')
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('previous environment')

    expect(usePanelLayoutStore.getState().environmentId).toBe('arc')
    expect(lastReply(out)).toBe('Switched to Arc Reactor.')
  })

  it('opens the core panel through the real store', async () => {
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('open the core')

    expect(usePanelLayoutStore.getState().panels.core.open).toBe(true)
    expect(lastReply(out)).toBe('Opened the JARVIS Core panel.')
    expect(out.notices.some((n) => n.includes('Opened the JARVIS Core panel.'))).toBe(true)
  })

  it('already-open panel is reported honestly (no double action)', async () => {
    usePanelLayoutStore.getState().openPanel('core')
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('open the core')

    expect(lastReply(out)).toBe('The JARVIS Core panel is already open.')
  })

  it('closes the system panel', async () => {
    usePanelLayoutStore.getState().openPanel('system')
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('close the system panel')

    expect(usePanelLayoutStore.getState().panels.system.open).toBe(false)
    expect(lastReply(out)).toBe('Closed the System panel.')
  })

  it('"show me the devices" opens the devices panel', async () => {
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('show me the devices')

    expect(usePanelLayoutStore.getState().panels.devices.open).toBe(true)
    expect(lastReply(out)).toBe('Opened the Devices panel.')
  })

  it('"toggle the system panel" toggles the store state', async () => {
    usePanelLayoutStore.getState().openPanel('system')
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('toggle the system panel')

    expect(usePanelLayoutStore.getState().panels.system.open).toBe(false)
    expect(lastReply(out)).toBe('Closed the System panel.')
  })

  it('"focus the conversation" focuses the open panel', async () => {
    usePanelLayoutStore.getState().openPanel('core')
    usePanelLayoutStore.getState().openPanel('conversation')
    const conversationZ = usePanelLayoutStore.getState().panels.conversation.z
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('focus the conversation')

    expect(usePanelLayoutStore.getState().panels.conversation.z).toBeGreaterThan(conversationZ)
    expect(lastReply(out)).toBe('Focused the Session Log panel.')
  })

  it('an explicit "camera panel" request opens the panel (not the raw camera intent)', async () => {
    usePanelLayoutStore.getState().closePanel('camera')
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('open the camera panel')

    expect(usePanelLayoutStore.getState().panels.camera.open).toBe(true)
    expect(lastReply(out)).toBe('Opened the Camera panel.')
    expect(lastReply(out)).not.toContain('webcam surface')
  })

  it('"open the camera" stays on the Phase 2.7 camera surface', async () => {
    usePanelLayoutStore.getState().closePanel('camera')
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('open the camera')

    expect(lastReply(out)).toContain('no webcam surface')
    expect(usePanelLayoutStore.getState().panels.camera.open).toBe(false)
  })

  it('unknown environment is refused honestly and nothing changes', async () => {
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('switch to the mars environment')

    expect(usePanelLayoutStore.getState().environmentId).toBe('arc')
    expect(lastReply(out)).toContain('not one of my environments')
    expect(lastReply(out)).toContain('Astra HUD')
  })

  it('unknown panel is refused honestly and nothing changes', async () => {
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('open the calculator panel')

    expect(usePanelLayoutStore.getState().panels.core.open).toBe(false)
    expect(lastReply(out)).toContain('not one of my panels')
    expect(lastReply(out)).toContain('JARVIS Core')
  })

  it('compound "switch to astra and open the core" runs both with one reply', async () => {
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('switch to astra and open the core')

    expect(usePanelLayoutStore.getState().environmentId).toBe('astra')
    expect(usePanelLayoutStore.getState().panels.core.open).toBe(true)
    const reply = lastReply(out)
    expect(reply).toContain('Switched to Astra HUD.')
    expect(reply).toContain('Opened the JARVIS Core panel.')
  })

  it('the voice channel drives the same action surface', async () => {
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('switch to astra', { channel: 'voice' })

    expect(usePanelLayoutStore.getState().environmentId).toBe('astra')
    expect(lastReply(out)).toBe('Switched to Astra HUD.')
  })

  it('does NOT hijack ordinary open requests ("open notepad" stays with the planner)', async () => {
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('open notepad')

    expect(lastReply(out)).toContain('open_application is not available')
    expect(usePanelLayoutStore.getState().panels.core.open).toBe(false)
  })

  it('the final status reflects a completed real self-action', async () => {
    const engine = new AssistantEngine({})
    await engine.process('open the core')
    expect(useJarvisStore.getState().status).toBe('success')
  })

  it('"switch the theme to cyber" mutates the real theme store', async () => {
    const engine = new AssistantEngine({})
    const out = collect(engine)

    expect(useJarvisStore.getState().theme).toBe('classic')
    await engine.process('switch the theme to cyber')

    expect(useJarvisStore.getState().theme).toBe('cyber')
    expect(lastReply(out)).toBe('Switched to the Cyber theme.')
  })

  it('"next theme" cycles the theme catalogue', async () => {
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('next theme')

    expect(useJarvisStore.getState().theme).toBe('cyber')
    expect(lastReply(out)).toBe('Switched to the Cyber theme.')
  })

  it('an unknown theme is answered honestly and nothing is changed', async () => {
    const engine = new AssistantEngine({})
    const out = collect(engine)

    await engine.process('switch the theme to paisley')

    expect(useJarvisStore.getState().theme).toBe('classic')
    expect(lastReply(out)).toContain('not one of my themes')
    expect(lastReply(out)).toContain('Cyber')
  })
})