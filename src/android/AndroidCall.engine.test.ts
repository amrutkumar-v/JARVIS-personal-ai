import { describe, expect, it, beforeEach } from 'vitest'
import { AssistantEngine } from '../engine/AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from '../engine/provider'
import type { EngineOutMessage, ToolConfirmationRequest } from '../engine/contracts'
import type { AndroidCallOutcome, AndroidCapabilities, AndroidCallStateInput, AndroidProvider } from './provider'
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
      dialPermission: true,
      callControlPermission: true,
    },
  }
  requests: CallAction[] = []
  events: CallEventData[] = []
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

  requestCall(action: CallAction, input: { target?: string }): Promise<AndroidCallOutcome> {
    this.requests.push(action)
    if (this.outcome.ok) {
      // The real phone pushes the OS-observed state right after the ack.
      this.events.unshift({
        deviceId: 's26-ultra',
        state: 'CALLING',
        direction: 'outgoing',
        commandId: this.outcome.commandId,
        contactName: input.target,
        at: Date.now(),
      })
    }
    return Promise.resolve(this.outcome)
  }

  callResult(): Promise<CallResultLookup> {
    return Promise.resolve({ ok: true, acknowledged: true, result: true })
  }

  recentCallEvents(limit = 10): CallEventData[] {
    return this.events.slice(0, limit)
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
    const ids = engine.capabilityCatalog().map((c) => c.id)
    expect(ids).toContain('phone_call_dial')
    expect(ids).toContain('phone_call_answer')
    // Declared-but-unimplemented call capabilities stay absent (honest).
    expect(ids).not.toContain('phone_call_summarize')
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
