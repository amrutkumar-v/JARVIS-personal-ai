import { describe, expect, it, beforeEach } from 'vitest'
import { AssistantEngine } from '../engine/AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from '../engine/provider'
import type { EngineOutMessage, ToolConfirmationRequest } from '../engine/contracts'
import type { ActiveCall, AndroidCallOutcome, AndroidCapabilities, AndroidCallStateInput, AndroidProvider } from './provider'
import type { CallAction, CallEventData, CallResultLookup, DeviceRecord } from '../backend/types'
import { useConversationStore } from '../state/conversation.store'
import { useJarvisStore } from '../state/jarvis.store'
import { resetProviders } from '../engine/providers'

/**
 * Phase 10 — the Android calling surface through the REAL engine loop.
 *
 * Proves the integration is not a side-path:
 *  - zero call.* tools (and zero phone_call_* capabilities) while no provider
 *    is bound, so the model can never claim calling reach it does not have;
 *  - a bound provider registers the real tools + capability cluster;
 *  - placing a call goes through the SAME confirmation gate as every other
 *    consequential action, and cancelling it queues nothing;
 *  - confirming runs the real tool and the step is VERIFIED only from a real
 *    call-state event the phone reported;
 *  - detaching the provider removes the entire surface.
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

class ScriptedProvider implements AIProvider {
  readonly id = 'scripted'
  readonly label = 'Scripted'
  requests: AIRequest[] = []
  private readonly queue: AIResponse[]

  constructor(script: AIResponse[]) {
    this.queue = [...script]
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    this.requests.push(request)
    const next = this.queue.shift()
    if (!next) return { text: 'No more scripted steps.' }
    return next
  }

  isConfigured(): boolean {
    return true
  }

  isReachable(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

function req(toolId: string, payload: Record<string, unknown> = {}, capability?: string): AIResponse {
  return { text: '', toolRequests: [{ toolId, payload, ...(capability ? { capability } : {}) }] }
}

const text = (value: string): AIResponse => ({ text: value })

class FakeAndroidProvider implements AndroidProvider {
  capabilitiesResult: AndroidCapabilities = {
    available: true,
    phone: {
      deviceId: 's26-ultra',
      deviceName: "Amrut's S26 Ultra",
      online: true,
      call: true,
      speak: true,
      dialPermission: true,
      callControlPermission: true,
    },
  }
  requests: CallAction[] = []
  events: CallEventData[] = []
  /** The exact words the phone was asked to say, in order. */
  speaks: string[] = []
  /** The call state the phone reports right after the dial. */
  connectState: 'CALLING' | 'CONNECTED' = 'CALLING'
  outcome: AndroidCallOutcome = {
    ok: true,
    state: 'CALL_REQUESTED',
    message: 'Sent a real dial command for Dad to the phone.',
    deviceId: 's26-ultra',
    commandId: 'cmd-1',
    requestId: 'req-1',
  }

  capabilities(): AndroidCapabilities {
    return this.capabilitiesResult
  }

  refresh(): Promise<DeviceRecord[]> {
    return Promise.resolve([])
  }

  requestCall(action: CallAction, input: { target?: string; text?: string }): Promise<AndroidCallOutcome> {
    this.requests.push(action)
    if (action === 'speak' && input.text) this.speaks.push(input.text)
    if (this.outcome.ok) {
      if (action === 'dial') {
        // The real phone pushes the OS-observed state right after the ack.
        this.events.unshift({
          deviceId: 's26-ultra',
          state: this.connectState,
          direction: 'outgoing',
          commandId: this.outcome.commandId,
          contactName: input.target,
          at: Date.now(),
        })
      }
      if (action === 'hangup') {
        this.events.unshift({ deviceId: 's26-ultra', state: 'ENDED', at: Date.now() })
      }
    }
    return Promise.resolve(this.outcome)
  }

  callResult(): Promise<CallResultLookup> {
    return Promise.resolve({ ok: true, acknowledged: true, result: true })
  }

  recentCallEvents(limit = 10): CallEventData[] {
    return this.events.slice(0, limit)
  }

  activeCall(): ActiveCall | null {
    // Same semantics as the real provider: the newest meaningful state wins,
    // and a terminal state ends the call.
    const terminal = ['ENDED', 'REJECTED', 'CANCELLED', 'FAILED']
    for (const e of this.events) {
      if (['CALLING', 'RINGING', 'CONNECTED'].includes(e.state)) {
        return {
          deviceId: e.deviceId,
          state: e.state,
          direction: e.direction,
          contactName: e.contactName,
          number: e.number,
          at: e.at,
        }
      }
      if (terminal.includes(e.state)) return null
    }
    return null
  }

  awaitCallState(input: AndroidCallStateInput): Promise<CallEventData | null> {
    const wanted = new Set(input.states)
    const found = this.events.find((e) => e.deviceId === input.deviceId && wanted.has(e.state))
    return Promise.resolve(found ?? null)
  }
}

async function waitForToolConfirmRequest(events: EngineOutMessage[]): Promise<ToolConfirmationRequest> {
  for (let i = 0; i < 100; i += 1) {
    const found = events.find((m) => m.type === 'tool-confirm')
    if (found) return (found as { request: ToolConfirmationRequest }).request
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('Timed out waiting for tool-confirm')
}

describe('Phase 10 — Android calling through the engine', () => {
  beforeEach(() => {
    stubBrowserStorage()
    resetProviders()
    useJarvisStore.getState().resetRun()
    useConversationStore.getState().clearConversation()
  })

  it('registers NO call tools or calling capabilities without a provider', () => {
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    engine.on(() => undefined)
    expect(engine.tools.get('call.dial')).toBeUndefined()
    expect(engine.tools.get('call.status')).toBeUndefined()
    const ids = engine.capabilityCatalog().map((c) => c.id)
    expect(ids).not.toContain('phone_call_dial')
    expect(ids).not.toContain('phone_call_status')
    void engine
  })

  it('registers the real call tools and capability cluster when a provider is bound', () => {
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])], android: new FakeAndroidProvider() })
    engine.on(() => undefined)
    expect(engine.tools.get('call.dial')).toBeDefined()
    expect(engine.tools.get('call.answer')).toBeDefined()
    expect(engine.tools.get('call.reject')).toBeDefined()
    expect(engine.tools.get('call.end')).toBeDefined()
    expect(engine.tools.get('call.status')).toBeDefined()
    // The conversational call surface: open a call and ask, close it, read it back.
    expect(engine.tools.get('call.converse')).toBeDefined()
    expect(engine.tools.get('call.conclude')).toBeDefined()
    expect(engine.tools.get('call.summarize')).toBeDefined()
    const ids = engine.capabilityCatalog().map((c) => c.id)
    expect(ids).toContain('phone_call_dial')
    expect(ids).toContain('phone_call_answer')
    expect(ids).toContain('phone_call_converse')
    expect(ids).toContain('phone_call_conclude')
    // `phone_call_summarize` is now backed by a REAL tool.
    expect(ids).toContain('phone_call_summarize')
    // Declared-but-unimplemented call capabilities stay absent (honest).
    expect(ids).not.toContain('phone_sms_send')
  })

  it('requires confirmation and queues NOTHING when the user cancels', async () => {
    const android = new FakeAndroidProvider()
    const provider = new ScriptedProvider([req('call.dial', { target: 'Dad' }), text('Not calling.')])
    const engine = new AssistantEngine({ providers: [provider], android })
    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))

    const pending = engine.process('call Dad')
    await waitForToolConfirmRequest(events)
    expect(engine.hasPendingConfirmation).toBe(true)

    engine.cancelPending()
    await pending

    // Nothing reached the phone, and the plan says so honestly: a refused
    // confirmation is a BLOCKED step (permission_denied), never a success and
    // never a silent cancellation of the run.
    expect(android.requests).toEqual([])
    expect(engine.goalPlan().steps[0]?.state).toBe('blocked')
  })

  it('confirms, places the call, and VERIFIES it from the real call-state event', async () => {
    const android = new FakeAndroidProvider()
    const provider = new ScriptedProvider([req('call.dial', { target: 'Dad' }, 'phone_call_dial'), text('Calling Dad.')])
    const engine = new AssistantEngine({ providers: [provider], android })
    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))

    const pending = engine.process('call Dad')
    const request = await waitForToolConfirmRequest(events)
    await request.onConfirm()
    await pending

    expect(android.requests).toEqual(['dial'])
    const step = engine.goalPlan().steps[0]
    expect(step?.toolId).toBe('call.dial')
    expect(step?.capability).toBe('phone_call_dial')
    expect(step?.state).toBe('verified')
  })

  it('attaching mid-session adds the surface; detaching removes it entirely', () => {
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    engine.on(() => undefined)
    expect(engine.tools.get('call.dial')).toBeUndefined()

    engine.attachAndroid(new FakeAndroidProvider())
    expect(engine.tools.get('call.dial')).toBeDefined()
    expect(engine.capabilityCatalog().map((c) => c.id)).toContain('phone_call_dial')

    engine.attachAndroid(undefined)
    expect(engine.tools.get('call.dial')).toBeUndefined()
    expect(engine.tools.get('call.status')).toBeUndefined()
    const ids = engine.capabilityCatalog().map((c) => c.id)
    expect(ids).not.toContain('phone_call_dial')
    expect(ids).not.toContain('phone_call_status')
  })

  it('reports the REAL calling availability in the capability snapshot', async () => {
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])], android: new FakeAndroidProvider() })
    engine.on(() => undefined)
    await engine.start()
    expect(useJarvisStore.getState().capabilities.callingEnabled).toBe(true)

    engine.attachAndroid(undefined)
    expect(useJarvisStore.getState().capabilities.callingEnabled).toBe(false)
  })
})

describe('the conversational call through the engine', () => {
  beforeEach(() => {
    stubBrowserStorage()
    resetProviders()
    useJarvisStore.getState().resetRun()
    useConversationStore.getState().clearConversation()
  })

  it('plans and executes: dials, introduces itself, asks the question, and leaves the call open', async () => {
    const android = new FakeAndroidProvider()
    android.connectState = 'CONNECTED'
    const provider = new ScriptedProvider([
      req('call.converse', { target: 'Dad', brief: 'whether he can come at 5 pm today' }, 'phone_call_converse'),
      text('I called Dad and asked him. The call is still open — what did he say?'),
    ])
    const engine = new AssistantEngine({ providers: [provider], android })
    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))

    const pending = engine.process('call Dad and ask whether he can come at 5 pm today')
    const request = await waitForToolConfirmRequest(events)
    // A real call is never auto-approved: the user confirms it.
    expect(request.toolId).toBe('call.converse')
    await request.onConfirm()
    await pending

    // The phone really dialled, and really said both lines.
    expect(android.requests).toContain('dial')
    expect(android.requests.filter((a) => a === 'speak')).toHaveLength(2)
    expect(android.speaks[0]).toContain('personal assistant')
    // The operator's name comes from the real memory profile; with no name on
    // file JARVIS says "the user" rather than inventing one.
    expect(android.speaks[0]).toMatch(/calling on (the user|Amrut)'s behalf/)
    expect(android.speaks[1]).toContain('whether he can come at 5 pm today')
    // The step is VERIFIED from the real call-state observation.
    const step = engine.goalPlan().steps[0]
    expect(step?.toolId).toBe('call.converse')
    expect(step?.state).toBe('verified')
  })

  it('closes the call and records what was communicated', async () => {
    const android = new FakeAndroidProvider()
    android.connectState = 'CONNECTED'
    const provider = new ScriptedProvider([
      req('call.conclude', { reply: 'he said yes, come at 5 pm' }, 'phone_call_conclude'),
      text('Done — I closed the call and saved the summary.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], android })
    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))

    // The call is already open when the closing step runs.
    android.events.unshift({ deviceId: 's26-ultra', state: 'CONNECTED', direction: 'outgoing', at: Date.now() })

    const pending = engine.process('he said yes, hang up now')
    const request = await waitForToolConfirmRequest(events)
    await request.onConfirm()
    await pending

    expect(android.requests).toContain('speak')
    expect(android.requests).toContain('hangup')
    const step = engine.goalPlan().steps[0]
    expect(step?.toolId).toBe('call.conclude')
    expect(step?.state).toBe('verified')
  })
})
