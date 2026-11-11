import { describe, expect, it } from 'vitest'
import { createAndroidCallTools, normalizeDialNumber, deviceErrorForCallState } from './AndroidCallTools'
import type {
  ActiveCall,
  AndroidCallOutcome,
  AndroidCapabilities,
  AndroidCallStateInput,
  AndroidProvider,
} from './provider'
import type { CallAction, CallEventData, CallResultLookup, CallState, DeviceRecord } from '../backend/types'

/**
 * Phase 10 — Android telephony tools WITHOUT a phone.
 *
 * These tests pin the honesty contract of the tool layer:
 *  - nothing is queued while the phone is unreachable / offline / unsupported /
 *    missing the permission — each case fails with its OWN truthful state and
 *    the matching engine recovery code;
 *  - a call is only reported as confirmed when a REAL call-state event the
 *    phone pushed satisfies the verifier;
 *  - a missing event is a failure, not a silent success.
 */

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
  requests: Array<{ action: CallAction; input: { target?: string; number?: string; reason?: string; text?: string } }> = []
  outcome: AndroidCallOutcome = {
    ok: true,
    state: 'CALL_REQUESTED',
    message: 'Sent a real dial command.',
    deviceId: 's26-ultra',
    commandId: 'cmd-1',
    requestId: 'req-1',
  }
  events: CallEventData[] = []
  /** When true, `requestCall` pushes a confirming event like the real phone does. */
  emitEventOnRequest = true
  /** The ack `callResult` reports (the phone's own confirmation). */
  callResultValue: CallResultLookup = { ok: true, acknowledged: true, result: true }

  capabilities(): AndroidCapabilities {
    return this.capabilitiesResult
  }

  refresh(): Promise<DeviceRecord[]> {
    return Promise.resolve([])
  }

  requestCall(
    action: CallAction,
    input: { target?: string; number?: string; reason?: string; text?: string },
  ): Promise<AndroidCallOutcome> {
    this.requests.push({ action, input })
    if (this.outcome.ok && this.emitEventOnRequest && action === 'dial') {
      this.events.unshift({
        deviceId: 's26-ultra',
        state: 'CALLING',
        direction: 'outgoing',
        commandId: this.outcome.commandId,
        contactName: input.target,
        number: input.number,
        at: Date.now(),
      })
    }
    return Promise.resolve(this.outcome)
  }

  callResult(): Promise<CallResultLookup> {
    return Promise.resolve(this.callResultValue)
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
    const found = this.events.find(
      (e) => e.deviceId === input.deviceId && wanted.has(e.state) && (!input.commandId || !e.commandId || e.commandId === input.commandId),
    )
    return Promise.resolve(found ?? null)
  }
}

function tool(provider: AndroidProvider, id: string) {
  const found = createAndroidCallTools(provider).find((t) => t.id === id)
  if (!found) throw new Error(`tool ${id} not created`)
  return found
}

const ctx = { requestId: 'r1' }

describe('Phase 10 — Android call tools', () => {
  it('creates exactly the implemented telephony tools', () => {
    const ids = createAndroidCallTools(new FakeAndroidProvider()).map((t) => t.id)
    expect(ids).toEqual([
      'call.dial',
      'call.answer',
      'call.reject',
      'call.end',
      'call.speak',
      'call.converse',
      'call.conclude',
      'call.summarize',
      'call.status',
    ])
    // Nothing is invented: no contacts-copy / SMS tool exists here.
    expect(ids).not.toContain('phone.sms')
  })

  it('creates NO tools without a provider', () => {
    expect(createAndroidCallTools(undefined)).toEqual([])
  })

  it('normalizes only dialable numbers', () => {
    expect(normalizeDialNumber('+91 98765-43210')).toBe('+919876543210')
    expect(normalizeDialNumber('(555) 019-9')).toBe('5550199')
    expect(normalizeDialNumber('Dad')).toBeUndefined()
    expect(normalizeDialNumber('1-800-FLOWERS')).toBeUndefined()
    expect(normalizeDialNumber('12')).toBeUndefined()
  })

  it('dial requires a target or a number (a bare verb is never dialled)', async () => {
    const provider = new FakeAndroidProvider()
    for (const query of ['call', 'dial', 'phone', 'call to']) {
      const result = await tool(provider, 'call.dial').execute({ query, params: {} }, ctx)
      expect(result.ok, `query="${query}" should not dial`).toBe(false)
    }
    expect(provider.requests).toHaveLength(0)
  })

  it('dial falls back to the utterance only when it names a real target', async () => {
    const provider = new FakeAndroidProvider()
    const result = await tool(provider, 'call.dial').execute({ query: 'call Dad', params: {} }, ctx)
    expect(result.ok).toBe(true)
    expect(provider.requests[0]?.input.target).toBe('Dad')
  })

  it('dial never sends a malformed number to the phone', async () => {
    const provider = new FakeAndroidProvider()
    const result = await tool(provider, 'call.dial').execute({ query: 'call 12', params: { number: '12' } }, ctx)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('not a valid phone number')
    expect(provider.requests).toHaveLength(0)
  })

  it('dial queues a real command and verifies from the REAL call-state event', async () => {
    const provider = new FakeAndroidProvider()
    const dial = tool(provider, 'call.dial')
    const result = await dial.execute({ query: 'call Dad', params: { target: 'Dad' } }, ctx)
    expect(result.ok).toBe(true)
    expect(provider.requests[0]).toEqual({ action: 'dial', input: { target: 'Dad' } })

    const verification = await dial.verify!({ query: 'call Dad', params: { target: 'Dad' } }, result, ctx)
    expect(verification.ok).toBe(true)
    expect(verification.message).toContain('CALLING')
  })

  it('dial FAILS verification when the phone never reports a call state', async () => {
    const provider = new FakeAndroidProvider()
    provider.emitEventOnRequest = false
    const dial = tool(provider, 'call.dial')
    const result = await dial.execute({ query: 'call 5550199', params: { number: '5550199' } }, ctx)
    expect(result.ok).toBe(true)
    const verification = await dial.verify!({ query: '', params: {} }, result, ctx)
    expect(verification.ok).toBe(false)
    expect(verification.message).toContain('did not report a confirming call state')
  })

  it('reports the phone\'s own refusal immediately instead of waiting out the timeout', async () => {
    const provider = new FakeAndroidProvider()
    provider.emitEventOnRequest = false
    provider.outcome = { ok: false, state: 'FAILED', message: 'ambiguous contact', deviceId: 's26-ultra', commandId: 'cmd-7' }
    provider.events = [
      {
        deviceId: 's26-ultra',
        state: 'FAILED',
        direction: 'outgoing',
        commandId: 'cmd-7',
        contactName: 'Sam',
        reason: '"Sam" matches 2 contacts: Samantha (…1234); Samuel (…5678). Which one should I call?',
        at: Date.now(),
      },
    ]
    const dial = tool(provider, 'call.dial')
    const result = await dial.execute({ query: 'call Sam', params: { target: 'Sam' } }, ctx)
    expect(result.ok).toBe(false)
    const verification = await dial.verify!({ query: 'call Sam', params: { target: 'Sam' } }, result, ctx)
    expect(verification.ok).toBe(false)
    // The phone's real reason is passed through — JARVIS asks WHICH contact
    // rather than picking one, and never claims the call happened.
    expect(verification.message).toContain('Which one should I call?')
    expect(verification.message).toContain('Samantha')
  })

  it('refuses while the companion is unreachable, with the device-disconnected code', async () => {
    const provider = new FakeAndroidProvider()
    provider.capabilitiesResult = { available: false, reason: 'JARVIS Core backend is not connected.' }
    const result = await tool(provider, 'call.dial').execute({ query: 'call Dad', params: { target: 'Dad' } }, ctx)
    expect(result.ok).toBe(false)
    expect((result.data as { deviceError: string }).deviceError).toBe('device_disconnected')
    expect((result.data as { callState: CallState }).callState).toBe('DEVICE_OFFLINE')
    expect(provider.requests).toHaveLength(0)
  })

  it('refuses an offline phone honestly (never queues a call)', async () => {
    const provider = new FakeAndroidProvider()
    provider.capabilitiesResult = {
      available: true,
      phone: { deviceId: 's26-ultra', deviceName: "Amrut's S26 Ultra", online: false, call: true, speak: true, dialPermission: true, callControlPermission: true },
    }
    const result = await tool(provider, 'call.dial').execute({ query: 'call Dad', params: { target: 'Dad' } }, ctx)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('offline')
    expect((result.data as { callState: CallState }).callState).toBe('DEVICE_OFFLINE')
    expect(provider.requests).toHaveLength(0)
  })

  it('refuses a phone without telephony capability with NOT_SUPPORTED', async () => {
    const provider = new FakeAndroidProvider()
    provider.capabilitiesResult = {
      available: true,
      phone: { deviceId: 's26-ultra', deviceName: "Amrut's S26 Ultra", online: true, call: false, speak: false, dialPermission: false, callControlPermission: false },
    }
    const result = await tool(provider, 'call.dial').execute({ query: 'call Dad', params: { target: 'Dad' } }, ctx)
    expect(result.ok).toBe(false)
    expect((result.data as { callState: CallState }).callState).toBe('NOT_SUPPORTED')
    expect((result.data as { deviceError: string }).deviceError).toBe('device_unavailable')
    expect(provider.requests).toHaveLength(0)
  })

  it('refuses a missing CALL_PHONE permission with PERMISSION_REQUIRED', async () => {
    const provider = new FakeAndroidProvider()
    provider.capabilitiesResult = {
      available: true,
      phone: { deviceId: 's26-ultra', deviceName: "Amrut's S26 Ultra", online: true, call: true, speak: true, dialPermission: false, callControlPermission: true },
    }
    const result = await tool(provider, 'call.dial').execute({ query: 'call Dad', params: { target: 'Dad' } }, ctx)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('CALL_PHONE')
    expect((result.data as { deviceError: string }).deviceError).toBe('device_permission_required')
    expect(provider.requests).toHaveLength(0)
  })

  it('call control needs ANSWER_PHONE_CALLS, not CALL_PHONE', async () => {
    const provider = new FakeAndroidProvider()
    provider.capabilitiesResult = {
      available: true,
      phone: { deviceId: 's26-ultra', deviceName: "Amrut's S26 Ultra", online: true, call: true, speak: true, dialPermission: true, callControlPermission: false },
    }
    const result = await tool(provider, 'call.end').execute({ query: 'hang up', params: {} }, ctx)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('ANSWER_PHONE_CALLS')
    expect(provider.requests).toHaveLength(0)
  })

  it('surfaces the phone-reported failure state instead of claiming success', async () => {
    const provider = new FakeAndroidProvider()
    provider.outcome = { ok: false, state: 'FAILED', message: 'Android refused the call.', deviceId: 's26-ultra', commandId: 'cmd-9' }
    const result = await tool(provider, 'call.dial').execute({ query: 'call Dad', params: { target: 'Dad' } }, ctx)
    expect(result.ok).toBe(false)
    expect((result.data as { callState: CallState }).callState).toBe('FAILED')
  })

  it('call.status reports the REAL last observed state and permission truth', async () => {
    const provider = new FakeAndroidProvider()
    provider.events = [{ deviceId: 's26-ultra', state: 'CONNECTED', direction: 'incoming', number: '+15550199', at: 5 }]
    const result = await tool(provider, 'call.status').execute({ query: 'call status', params: {} }, ctx)
    expect(result.ok).toBe(true)
    const data = result.data as { active: boolean; permissions: Record<string, boolean> }
    expect(data.active).toBe(true)
    expect(data.permissions.CALL_PHONE).toBe(true)
    expect(result.message).toContain('CONNECTED')
  })

  it('maps every call state to a bounded engine recovery code', () => {
    expect(deviceErrorForCallState('DEVICE_OFFLINE')).toBe('device_disconnected')
    expect(deviceErrorForCallState('PERMISSION_REQUIRED')).toBe('device_permission_required')
    expect(deviceErrorForCallState('NOT_SUPPORTED')).toBe('device_unavailable')
    expect(deviceErrorForCallState('FAILED')).toBe('device_unavailable')
  })
})

describe('call.speak — JARVIS talking on a live call', () => {
  it('refuses to speak when there is no live call', async () => {
    const provider = new FakeAndroidProvider()
    const result = await tool(provider, 'call.speak').execute({ query: 'say hi on the call', params: { text: 'Hello' } }, ctx)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('no live call')
    expect(provider.requests).toHaveLength(0)
  })

  it('refuses to speak into a call that is only ringing, not connected', async () => {
    const provider = new FakeAndroidProvider()
    provider.events = [{ deviceId: 's26-ultra', state: 'RINGING', direction: 'outgoing', at: 5 }]
    const result = await tool(provider, 'call.speak').execute({ query: 'say hi on the call', params: { text: 'Hello' } }, ctx)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('RINGING')
    expect(provider.requests).toHaveLength(0)
  })

  it('queues the text for the phone when a call is live', async () => {
    const provider = new FakeAndroidProvider()
    provider.events = [{ deviceId: 's26-ultra', state: 'CONNECTED', direction: 'outgoing', at: 5 }]
    const result = await tool(provider, 'call.speak').execute({ query: 'say hi on the call', params: { text: 'Hello there' } }, ctx)
    expect(result.ok).toBe(true)
    expect(provider.requests[0]?.action).toBe('speak')
    expect(provider.requests[0]?.input.text).toBe('Hello there')
  })

  it('refuses to speak without text', async () => {
    const provider = new FakeAndroidProvider()
    provider.events = [{ deviceId: 's26-ultra', state: 'CONNECTED', direction: 'outgoing', at: 5 }]
    const result = await tool(provider, 'call.speak').execute({ query: 'say hi on the call', params: {} }, ctx)
    expect(result.ok).toBe(false)
    expect(provider.requests).toHaveLength(0)
  })

  it('is verified ONLY by the phone acknowledgement, never by assumption', async () => {
    const provider = new FakeAndroidProvider()
    provider.events = [{ deviceId: 's26-ultra', state: 'CONNECTED', direction: 'outgoing', at: 5 }]
    const speak = tool(provider, 'call.speak')
    const result = await speak.execute({ query: 'say hi on the call', params: { text: 'Hello there' } }, ctx)

    provider.callResultValue = { ok: true, acknowledged: true, result: true, detail: 'SPOKEN: played on the loudspeaker' }
    const good = await speak.verify!(  { query: 'say hi on the call', params: { text: 'Hello there' } }, result, ctx)
    expect(good.ok).toBe(true)

    provider.callResultValue = { ok: true, acknowledged: true, result: false, detail: 'FAILED: the call is on the earpiece' }
    const bad = await speak.verify!({ query: 'say hi on the call', params: { text: 'Hello there' } }, result, ctx)
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain('earpiece')
  })

  it('a phone without the call.speak capability cannot be asked to speak', async () => {
    const provider = new FakeAndroidProvider()
    provider.events = [{ deviceId: 's26-ultra', state: 'CONNECTED', direction: 'outgoing', at: 5 }]
    provider.capabilitiesResult = {
      available: true,
      phone: {
        deviceId: 's26-ultra',
        deviceName: "Amrut's S26 Ultra",
        online: true,
        call: true,
        speak: false,
        dialPermission: true,
        callControlPermission: true,
      },
    }
    const result = await tool(provider, 'call.speak').execute({ query: 'say hi on the call', params: { text: 'Hello' } }, ctx)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('call.speak')
    expect(provider.requests).toHaveLength(0)
  })
})
