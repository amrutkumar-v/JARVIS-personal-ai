import type { BackendClient } from '../backend/BackendClient'
import type { CallAction, CallEventData, CallResultLookup, CallState, DeviceRecord } from '../backend/types'
import type {
  ActiveCall,
  AndroidCallOutcome,
  AndroidCallStateInput,
  AndroidCapabilities,
  AndroidPhoneCapability,
  AndroidProvider,
} from './provider'
import { callActionPermission, LIVE_CALL_STATES, phoneSupportsAction, TERMINAL_CALL_STATES } from './provider'

/**
 * BackendAndroidProvider — the real implementation of the Android telephony
 * seam, backed by the persistent JARVIS Core backend + paired companion phone.
 *
 * Truthful by construction:
 *  - every queue request goes through `POST /api/device/call`, whose response is
 *    the ONLY thing that decides `state` (the backend refuses offline /
 *    unsupported / permission-missing honestly);
 *  - `awaitCallState` can only ever resolve from a REAL `/phone/event`
 *    observation that the phone pushed from an OS call-state callback;
 *  - nothing is remembered beyond a bounded, newest-first event log.
 */

/** Bounded call-state observation history (real events only). */
export const MAX_CALL_EVENTS = 40

export class BackendAndroidProvider implements AndroidProvider {
  private readonly client: BackendClient
  private readonly reachable: () => boolean
  private readonly records: () => DeviceRecord[]
  private events: CallEventData[] = []
  private waiters = new Set<{
    isMatch: (event: CallEventData) => boolean
    settle: (event: CallEventData | null) => void
  }>()

  constructor(
    client: BackendClient,
    options: { reachable?: () => boolean; records?: () => DeviceRecord[] } = {},
  ) {
    this.client = client
    this.reachable = options.reachable ?? (() => client.hasConnected)
    this.records = options.records ?? (() => [])
  }

  /** Feed one real call-state event (wired from the backend SSE `call` event). */
  ingestCallEvent(event: CallEventData): void {
    this.events.unshift(event)
    if (this.events.length > MAX_CALL_EVENTS) this.events.length = MAX_CALL_EVENTS
    for (const waiter of [...this.waiters]) {
      if (waiter.isMatch(event)) waiter.settle(event)
    }
  }

  /** Drop the observation log (e.g. on reconnect, so stale states can't satisfy a wait). */
  clearCallEvents(): void {
    this.events = []
  }

  recentCallEvents(limit = 10): CallEventData[] {
    return this.events.slice(0, Math.max(0, limit))
  }

  /**
   * The live call, derived only from real OS observations.
   *
   * The log is newest-first. For each device the newest MEANINGFUL state
   * decides: a live state (CALLING/RINGING/CONNECTED) means a call is up, a
   * terminal state (ENDED/REJECTED/CANCELLED/FAILED) means it is not. States
   * that say nothing about a live call (the backend's synthetic
   * CALL_REQUESTED, or a permission refusal) are inconclusive and the scan
   * continues to the next observation.
   */
  activeCall(): ActiveCall | null {
    const byDevice = new Map<string, CallEventData[]>()
    for (const event of this.events) {
      const list = byDevice.get(event.deviceId) ?? []
      list.push(event)
      byDevice.set(event.deviceId, list)
    }
    for (const list of byDevice.values()) {
      for (const event of list) {
        if (LIVE_CALL_STATES.includes(event.state)) {
          return {
            deviceId: event.deviceId,
            state: event.state,
            direction: event.direction,
            contactName: event.contactName,
            number: event.number,
            at: event.at,
          }
        }
        // A terminal state means this device's call is definitively over.
        if (TERMINAL_CALL_STATES.includes(event.state)) break
        // Anything else (the backend's synthetic CALL_REQUESTED, a permission
        // refusal) says nothing about a live call — keep looking at this
        // device's older observations.
      }
    }
    return null
  }

  capabilities(): AndroidCapabilities {
    if (!this.reachable()) {
      return {
        available: false,
        reason: 'JARVIS Core backend is not connected, so the Android companion cannot be reached right now.',
      }
    }
    const phones = this.records().filter((d) => d.platform === 'android')
    if (phones.length === 0) {
      return { available: false, reason: 'No paired Android companion is registered with JARVIS Core.' }
    }
    const preferred = phones.find((d) => d.role === 'primary_phone') ?? phones[0]
    return { available: true, phone: capabilityOf(preferred) }
  }

  async refresh(): Promise<DeviceRecord[]> {
    if (!this.reachable()) return []
    return this.client.listDevices()
  }

  async requestCall(
    action: CallAction,
    input: { target?: string; number?: string; reason?: string; text?: string },
  ): Promise<AndroidCallOutcome> {
    if (!this.reachable()) {
      return {
        ok: false,
        state: 'DEVICE_OFFLINE',
        message: 'JARVIS Core backend is not connected, so the Android companion cannot be reached.',
      }
    }
    const phone = this.capabilities().phone
    if (!phone) {
      return { ok: false, state: 'DEVICE_OFFLINE', message: 'No paired Android companion is registered with JARVIS Core.' }
    }
    if (!phone.online) {
      return {
        ok: false,
        state: 'DEVICE_OFFLINE',
        message: `${phone.deviceName} is offline right now, so no call was placed.`,
        deviceId: phone.deviceId,
      }
    }
    if (!phoneSupportsAction(phone, action)) {
      const permission = callActionPermission(action)
      return {
        ok: false,
        state: phone.call || action === 'speak' ? 'PERMISSION_REQUIRED' : 'NOT_SUPPORTED',
        message:
          action === 'speak'
            ? `${phone.deviceName} does not advertise the call.speak capability, so JARVIS cannot speak on that phone yet.`
            : phone.call
              ? `${phone.deviceName} has not granted the ${permission} permission, so JARVIS cannot ${action} a call.`
              : `${phone.deviceName} reports no telephony capability, so JARVIS cannot ${action} a call.`,
        deviceId: phone.deviceId,
      }
    }

    const result = await this.client.requestCall({
      action,
      device: phone.deviceId,
      ...(input.target ? { contact: input.target } : {}),
      ...(input.number ? { number: input.number } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.text ? { text: input.text } : {}),
    })

    return {
      ok: result.ok,
      state: result.state,
      message: describeDispatch(action, result.state, phone, result.reason, input),
      deviceId: result.device ?? phone.deviceId,
      commandId: result.commandId,
      requestId: result.requestId,
      reason: result.reason,
    }
  }

  async callResult(commandId: string, deviceId: string): Promise<CallResultLookup> {
    return this.client.callResult({ device: deviceId, commandId })
  }

  awaitCallState(input: AndroidCallStateInput): Promise<CallEventData | null> {
    const wanted = new Set<CallState>(input.states)
    const since = input.since ?? 0
    const isMatch = (event: CallEventData): boolean => {
      if (event.deviceId !== input.deviceId) return false
      if (!wanted.has(event.state)) return false
      if (event.at < since) return false
      if (input.commandId && event.commandId && event.commandId !== input.commandId) return false
      return true
    }

    const already = this.events.find(isMatch)
    if (already) return Promise.resolve(already)
    if (input.signal?.aborted) return Promise.resolve(null)

    return new Promise<CallEventData | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const waiter = {
        isMatch,
        settle: (event: CallEventData | null): void => {
          if (timer) clearTimeout(timer)
          this.waiters.delete(waiter)
          input.signal?.removeEventListener?.('abort', onAbort)
          resolve(event)
        },
      }
      const onAbort = (): void => waiter.settle(null)
      this.waiters.add(waiter)
      timer = setTimeout(() => waiter.settle(null), Math.max(0, input.timeoutMs))
      input.signal?.addEventListener?.('abort', onAbort)
    })
  }
}

function capabilityOf(record: DeviceRecord): AndroidPhoneCapability {
  return {
    deviceId: record.id,
    deviceName: record.name,
    online: record.online === true,
    call: record.capabilities.includes('call'),
    speak: record.capabilities.includes('call.speak'),
    dialPermission: record.permissions.includes('CALL_PHONE'),
    callControlPermission: record.permissions.includes('ANSWER_PHONE_CALLS'),
  }
}

function describeDispatch(
  action: CallAction,
  state: CallState,
  phone: AndroidPhoneCapability,
  reason: string | undefined,
  input: { target?: string; number?: string },
): string {
  if (state === 'DEVICE_OFFLINE') {
    return `${phone.deviceName} is offline right now, so no call was placed.${reason ? ` (${reason})` : ''}`
  }
  if (state === 'PERMISSION_REQUIRED') {
    return `${phone.deviceName} has not granted the ${callActionPermission(action)} permission, so JARVIS cannot ${action} a call.`
  }
  if (state === 'NOT_SUPPORTED') {
    return `${phone.deviceName} reports no telephony capability, so JARVIS cannot ${action} a call.`
  }
  if (state !== 'CALL_REQUESTED') {
    return `The ${action} action was not accepted (${state}).${reason ? ` ${reason}` : ''}`
  }
  if (action === 'speak') {
    return `Sent the text to ${phone.deviceName} to speak on the phone's loudspeaker. Waiting for the phone to confirm it played.`
  }
  const who = input.target ?? input.number ?? 'the caller'
  switch (action) {
    case 'dial':
      return `Sent a real dial command for ${who} to ${phone.deviceName}. Waiting for the phone to report the call state.`
    case 'hangup':
      return `Sent a hang-up command to ${phone.deviceName}. Waiting for the phone to confirm the call ended.`
    case 'answer':
      return `Sent an answer command to ${phone.deviceName}. Waiting for the phone to report the call connected.`
    case 'reject':
      return `Sent a reject command to ${phone.deviceName}. Waiting for the phone to confirm it was rejected.`
  }
}
