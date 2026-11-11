import type { CallAction, CallDirection, CallEventData, CallResultLookup, CallState, DeviceRecord } from '../backend/types'

/**
 * Android companion telephony seam (REAL — replaces the earlier simulated
 * bridge that fabricated contacts, call states and audio bridging).
 *
 * The engine talks to the paired Android phone EXCLUSIVELY through this
 * optional provider. Nothing here executes anything locally: the provider
 * queues a command on the JARVIS Core backend, the phone runs it on its next
 * poll through Android OS telephony APIs, and the outcome is only ever what
 * the phone acked (`/phone/ack`) or what the OS reported as call state
 * (`/phone/event`).
 *
 * Without a live provider — or without a registered Android companion — NO
 * call tool is registered, so the model can never claim call reach it does not
 * have. A phone that has not granted `CALL_PHONE` / `ANSWER_PHONE_CALLS` makes
 * every call fail honestly with `PERMISSION_REQUIRED`; a phone that reports no
 * telephony capability fails with `NOT_SUPPORTED`; an offline phone fails with
 * `DEVICE_OFFLINE`. None of those are ever smoothed over.
 */

export interface AndroidPhoneCapability {
  deviceId: string
  deviceName: string
  online: boolean
  /** The companion build genuinely implements telephony (reported via heartbeat). */
  call: boolean
  /** The companion build can speak text on the phone during a live call. */
  speak: boolean
  /** Runtime permission `CALL_PHONE` is currently granted on the phone. */
  dialPermission: boolean
  /** Runtime permission `ANSWER_PHONE_CALLS` is currently granted on the phone. */
  callControlPermission: boolean
}

export interface AndroidCapabilities {
  available: boolean
  reason?: string
  /** The phone a call would target (the primary phone when one is registered). */
  phone?: AndroidPhoneCapability
}

export interface AndroidCallOutcome {
  ok: boolean
  /** Truthful outcome state — never a synthesized success. */
  state: CallState
  message: string
  deviceId?: string
  commandId?: string
  requestId?: string
  reason?: string
}

export interface AndroidCallStateInput {
  deviceId: string
  states: CallState[]
  /** Attribute the wait to a specific queued command when known. */
  commandId?: string
  /** Only accept events at/after this timestamp (ms). */
  since?: number
  timeoutMs: number
  signal?: AbortSignal
}

/** A call the phone's OS last reported as live. */
export interface ActiveCall {
  deviceId: string
  state: CallState
  direction?: CallDirection
  contactName?: string
  number?: string
  at: number
}

/** Call states that mean a call is currently up on the phone. */
export const LIVE_CALL_STATES: readonly CallState[] = ['CALLING', 'RINGING', 'CONNECTED']

/** Call states that mean a call is definitively over. */
export const TERMINAL_CALL_STATES: readonly CallState[] = ['ENDED', 'REJECTED', 'CANCELLED', 'FAILED']

export interface AndroidProvider {
  /** Live capability view derived from the real device registry. */
  capabilities(): AndroidCapabilities
  /** Live device table from the backend (empty when unreachable). */
  refresh(): Promise<DeviceRecord[]>
  /** Queue a real telephony action; never claims more than the backend accepted. */
  requestCall(
    action: CallAction,
    input: { target?: string; number?: string; reason?: string; text?: string },
  ): Promise<AndroidCallOutcome>
  /** The phone's concrete ack for a queued call command. */
  callResult(commandId: string, deviceId: string): Promise<CallResultLookup>
  /** Newest-first bounded log of REAL call-state events the phone reported. */
  recentCallEvents(limit?: number): CallEventData[]
  /** Bounded wait for one of `states` attributed to a command/device. */
  awaitCallState(input: AndroidCallStateInput): Promise<CallEventData | null>
  /**
   * The call the phone's OS last reported as live, or null when no call is up.
   * Derived ONLY from real `/phone/event` observations.
   */
  activeCall(): ActiveCall | null
}

/**
 * Runtime permission each telephony action needs the phone to have granted.
 *
 * `speak` needs NO telephony permission: playing audio on the phone is not a
 * telephony operation. It is still gated on the phone's own `call.speak`
 * capability, so a companion without a speech engine simply cannot be asked.
 */
export function callActionPermission(action: CallAction): string {
  if (action === 'dial') return 'CALL_PHONE'
  if (action === 'speak') return ''
  return 'ANSWER_PHONE_CALLS'
}

/** True when the phone's reported flags permit `action`. */
export function phoneSupportsAction(phone: AndroidPhoneCapability | undefined, action: CallAction): boolean {
  if (!phone) return false
  if (action === 'dial') return phone.dialPermission
  if (action === 'speak') return phone.speak
  return phone.callControlPermission
}
