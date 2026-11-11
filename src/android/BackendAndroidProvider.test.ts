import { describe, expect, it } from 'vitest'
import { BackendAndroidProvider } from './BackendAndroidProvider'
import type { BackendClient } from '../backend/BackendClient'
import type { CallEventData, DeviceRecord } from '../backend/types'

/**
 * The live-call view that gates the AI-assisted call path.
 *
 * It is derived ONLY from real `/phone/event` observations the phone pushed —
 * never from what the PC hoped for. These tests pin the cases where a naive
 * "is there a CONNECTED event?" check would be wrong:
 *   - a call that ENDED must not look live, even though an older CONNECTED
 *     event is still in the log;
 *   - the backend's synthetic CALL_REQUESTED (a queued command, not a state)
 *     must not hide a call that is genuinely up;
 *   - a refusal (PERMISSION_REQUIRED / DEVICE_OFFLINE) is not a call state
 *     and must not invent one.
 */

const DEVICE: DeviceRecord = {
  id: 's26-ultra',
  name: "Amrut's S26 Ultra",
  type: 'android',
  connection: 'lan',
  capabilities: ['call', 'call.speak'],
  permissions: ['CALL_PHONE', 'ANSWER_PHONE_CALLS'],
  online: true,
  health: 'ok',
  lastHeartbeatAt: 1,
  registeredAt: 1,
  platform: 'android',
  trusted: true,
}

function providerWith(events: CallEventData[]): BackendAndroidProvider {
  const client = {
    hasConnected: true,
    requestCall: async () => ({
      ok: true,
      state: 'CALL_REQUESTED' as const,
      action: 'speak' as const,
      commandId: 'cmd-1',
      requestId: 'req-1',
      device: 's26-ultra',
      delivered: true,
    }),
    callResult: async () => ({ ok: true, acknowledged: true, result: true }),
    refreshDevices: async () => [DEVICE],
  } as unknown as BackendClient
  const provider = new BackendAndroidProvider(client, { reachable: () => true, records: () => [DEVICE] })
  // Events arrive from the phone in chronological order, exactly as the real
  // SSE stream delivers them.
  for (const event of events) provider.ingestCallEvent(event)
  return provider
}

describe('BackendAndroidProvider — the live call view', () => {
  it('reports no call when the phone has never reported one', () => {
    expect(providerWith([]).activeCall()).toBeNull()
  })

  it('reports the connected call the phone reported', () => {
    const provider = providerWith([
      { deviceId: 's26-ultra', state: 'CONNECTED', direction: 'outgoing', contactName: 'Dad', at: 10 },
    ])
    const live = provider.activeCall()
    expect(live?.state).toBe('CONNECTED')
    expect(live?.contactName).toBe('Dad')
  })

  it('a call that ENDED is not live, even with an older CONNECTED event in the log', () => {
    const provider = providerWith([
      { deviceId: 's26-ultra', state: 'CONNECTED', at: 10 },
      { deviceId: 's26-ultra', state: 'ENDED', at: 20 },
    ])
    expect(provider.activeCall()).toBeNull()
  })

  it('the backend synthetic CALL_REQUESTED does not hide a call that is up', () => {
    const provider = providerWith([
      { deviceId: 's26-ultra', state: 'CONNECTED', at: 10 },
      { deviceId: 's26-ultra', state: 'CALL_REQUESTED', at: 30 },
    ])
    expect(provider.activeCall()?.state).toBe('CONNECTED')
  })

  it('a command refusal is not a call state and does not cancel a live call', () => {
    const provider = providerWith([
      { deviceId: 's26-ultra', state: 'CONNECTED', at: 10 },
      { deviceId: 's26-ultra', state: 'PERMISSION_REQUIRED', at: 30 },
    ])
    // The refusal is about a queued command, not about the call. The phone
    // re-checks the call state itself before it speaks, so the PC never
    // treats this as "the other party heard it".
    expect(provider.activeCall()?.state).toBe('CONNECTED')
  })

  it('a RINGING call is live but not connected', () => {
    const provider = providerWith([{ deviceId: 's26-ultra', state: 'RINGING', direction: 'incoming', at: 10 }])
    expect(provider.activeCall()?.state).toBe('RINGING')
  })

  it('the speak capability is read from the REAL device record', () => {
    const provider = providerWith([])
    expect(provider.capabilities().phone?.speak).toBe(true)
  })
})
