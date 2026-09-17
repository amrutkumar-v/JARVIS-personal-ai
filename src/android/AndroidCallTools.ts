import type { Tool, ToolCategory, ToolContext, ToolContextId, ToolInput, ToolPermission, ToolResult, ToolVerification } from '../tools/Tool'
import type { ToolInputSchema } from '../engine/provider'
import type { CallAction, CallState, DeviceErrorKind } from '../backend/types'
import type { AndroidProvider } from './provider'
import { callActionPermission, phoneSupportsAction } from './provider'

/**
 * Real Android telephony tools, bound to a live `AndroidProvider`.
 *
 * These tools replace the earlier SIMULATED bridge (hardcoded contacts, a fake
 * "Google Pixel 8 Pro", `setTimeout` call-state transitions and a claimed PC
 * audio bridge). Nothing here fabricates anything:
 *
 *   - a command is queued on the real backend and the phone runs it through
 *     Android OS telephony APIs;
 *   - the outcome state is whatever the backend/phone actually reported;
 *   - `verify()` can only succeed from a REAL call-state event pushed by the
 *     phone, so "Calling Dad" is never claimed unless the OS observed a call.
 *
 * Only genuinely implemented capabilities are registered: dial / answer /
 * reject / hang up / status. There is deliberately no fake call-summary or
 * contact-copy tool.
 */

/** How long a verifier waits for the OS-observed call state (ms). */
export const CALL_VERIFY_TIMEOUT_MS = 8_000
/** Slice of the verify window after which a refused call is reported. */
export const CALL_REFUSAL_POLL_MS = 1_500
/** Upper bound on refusal checks inside one verify window. */
const MAX_REFUSAL_CHECKS = 6

/**
 * States that mean the phone REFUSED (or could not start) the action. They end
 * verification immediately with the phone's own reason, so an ambiguous contact
 * name, a denied permission or an offline radio is reported in ~1.5s with the
 * real explanation instead of a generic 8s timeout.
 */
const REFUSING_STATES: CallState[] = ['FAILED', 'REJECTED', 'CANCELLED', 'PERMISSION_REQUIRED', 'NOT_SUPPORTED', 'DEVICE_OFFLINE']
/** Execution budget for queueing one telephony command (ms). */
const CALL_EXECUTE_TIMEOUT_MS = 15_000

/** States that confirm each action really happened. */
const CONFIRMING_STATES: Record<CallAction, CallState[]> = {
  dial: ['CALLING', 'RINGING', 'CONNECTED'],
  answer: ['CONNECTED'],
  reject: ['REJECTED', 'ENDED'],
  hangup: ['ENDED'],
}

/** Bounded mapping from an honest call state to the engine's recovery vocabulary. */
export function deviceErrorForCallState(state: CallState): DeviceErrorKind {
  switch (state) {
    case 'DEVICE_OFFLINE':
      return 'device_disconnected'
    case 'PERMISSION_REQUIRED':
      return 'device_permission_required'
    case 'NOT_SUPPORTED':
      return 'device_unavailable'
    case 'FAILED':
    case 'REJECTED':
    case 'CANCELLED':
      return 'device_unavailable'
    default:
      return 'device_protocol_error'
  }
}

export interface CallResultData {
  callState: CallState
  deviceId?: string
  commandId?: string
  requestId?: string
  action: CallAction
}

function paramStr(input: ToolInput, key: string): string | undefined {
  const value = input.params?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Normalize a dialled number: keep an optional leading +, digits only. */
export function normalizeDialNumber(raw: string): string | undefined {
  const trimmed = raw.trim().slice(0, 40)
  if (!trimmed || /[A-Za-z]/.test(trimmed)) return undefined
  const plus = trimmed.startsWith('+')
  const digits = trimmed.replace(/[^\d]/g, '')
  if (digits.length < 3 || digits.length > 20) return undefined
  return plus ? `+${digits}` : digits
}

abstract class BaseAndroidCallTool implements Tool {
  readonly category: ToolCategory = 'communication'
  readonly requiresPermission = false
  /** Reachable from the PC and phone scopes (the phone can ask too). */
  readonly contexts: ToolContextId[] = ['android', 'desktop']
  readonly timeoutMs = CALL_EXECUTE_TIMEOUT_MS
  protected readonly provider: AndroidProvider

  constructor(provider: AndroidProvider) {
    this.provider = provider
  }

  abstract readonly id: string
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly permission: ToolPermission
  abstract readonly inputSchema: ToolInputSchema

  abstract canRun(query: string): boolean
  abstract execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult>

  /** Refuse honestly BEFORE queueing anything the phone cannot do. */
  protected preflight(action: CallAction): ToolResult | null {
    const caps = this.provider.capabilities()
    const phone = caps.phone
    if (!caps.available || !phone) {
      const reason = caps.reason ?? 'No Android companion is reachable right now.'
      return {
        ok: false,
        message: reason,
        data: { deviceError: 'device_disconnected' as DeviceErrorKind, callState: 'DEVICE_OFFLINE' as CallState },
      }
    }
    if (!phone.online) {
      return {
        ok: false,
        message: `${phone.deviceName} is offline right now, so no call action was attempted.`,
        data: { deviceError: 'device_disconnected' as DeviceErrorKind, callState: 'DEVICE_OFFLINE' as CallState },
      }
    }
    if (!phone.call) {
      return {
        ok: false,
        message: `${phone.deviceName} reports no telephony capability, so JARVIS cannot ${action} a call.`,
        data: { deviceError: 'device_unavailable' as DeviceErrorKind, callState: 'NOT_SUPPORTED' as CallState },
      }
    }
    if (!phoneSupportsAction(phone, action)) {
      return {
        ok: false,
        message: `${phone.deviceName} has not granted the ${callActionPermission(action)} permission, so JARVIS cannot ${action} a call. Grant it in Android settings to enable this.`,
        data: { deviceError: 'device_permission_required' as DeviceErrorKind, callState: 'PERMISSION_REQUIRED' as CallState },
      }
    }
    return null
  }

  /** Shared execution: preflight → queue → honest result. */
  protected async run(action: CallAction, input: { target?: string; number?: string; reason?: string }): Promise<ToolResult> {
    const blocker = this.preflight(action)
    if (blocker) return blocker
    try {
      const outcome = await this.provider.requestCall(action, input)
      const data: CallResultData = {
        callState: outcome.state,
        deviceId: outcome.deviceId,
        commandId: outcome.commandId,
        requestId: outcome.requestId,
        action,
      }
      if (!outcome.ok) {
        return { ok: false, message: outcome.message, data: { ...data, deviceError: deviceErrorForCallState(outcome.state) } }
      }
      return { ok: true, message: outcome.message, data }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Could not reach the Android companion.',
        data: { deviceError: 'device_unavailable' as DeviceErrorKind, callState: 'FAILED' as CallState, action },
      }
    }
  }

  /** Bounded wait for the REAL call-state event that confirms this action. */
  protected async verifyCallState(action: CallAction, result: ToolResult, ctx: ToolContext): Promise<ToolVerification> {
    const data = (result.data ?? {}) as Partial<CallResultData>
    const deviceId = data.deviceId
    if (!deviceId) {
      return { ok: false, message: 'No companion device id was recorded, so the call could not be observed.', checks: [] }
    }
    const started = Date.now()
    const deadline = started + CALL_VERIFY_TIMEOUT_MS
    // Bounded on BOTH axes: wall clock and checks, so a provider that answers
    // instantly without an event can never spin the verifier.
    for (let attempt = 0; attempt < MAX_REFUSAL_CHECKS && Date.now() < deadline; attempt += 1) {
      if (ctx.signal?.aborted) {
        return { ok: false, message: 'The call verification was cancelled.', checks: [] }
      }
      const window = Math.min(CALL_REFUSAL_POLL_MS, deadline - Date.now())
      const observed = await this.provider.awaitCallState({
        deviceId,
        commandId: data.commandId,
        states: CONFIRMING_STATES[action],
        timeoutMs: window,
        signal: ctx.signal,
      })
      if (observed) {
        return {
          ok: true,
          message: `The phone reported call state ${observed.state}${observed.contactName ? ` for ${observed.contactName}` : ''}.`,
          checks: ['call-state-observed'],
        }
      }
      // A refusal the phone itself reported ends the wait immediately — and its
      // reason is passed through verbatim (this is how "which one should I call?"
      // for an ambiguous contact name reaches the user).
      const refusal = this.provider
        .recentCallEvents(8)
        .find(
          (event) =>
            event.deviceId === deviceId &&
            REFUSING_STATES.includes(event.state) &&
            (!data.commandId || !event.commandId || event.commandId === data.commandId) &&
            event.at >= started - 1_000,
        )
      if (refusal) {
        return {
          ok: false,
          message: `The phone did not place the call (${refusal.state}): ${refusal.reason ?? 'no reason reported'}`,
          checks: ['call-state-observed'],
        }
      }
    }
    return {
      ok: false,
      message: `The phone did not report a confirming call state within ${CALL_VERIFY_TIMEOUT_MS / 1000}s.`,
      checks: ['call-state-observed'],
    }
  }
}

/* --------------------------------------------------------------- dial */

export class CallDialTool extends BaseAndroidCallTool {
  readonly id = 'call.dial'
  readonly name = 'Call a contact or number'
  readonly description =
    'Place a REAL phone call through the paired Android companion. Give either a contact name (resolved on the phone) or a ' +
    'phone number. The call is queued on JARVIS Core and executed by the phone through Android telephony APIs; the result is ' +
    'reported only after the phone observes the real call state. Requires confirmation, an online phone, and the CALL_PHONE permission.'
  readonly permission: ToolPermission = 'user_confirmation'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Contact name to call (e.g. "Dad"), resolved against the phone\'s real contacts.' },
      number: { type: 'string', description: 'Explicit phone number to dial (e.g. "+919876543210").' },
    },
    required: [],
  }

  canRun(query: string): boolean {
    const q = (query || '').toLowerCase()
    return /^(?:call|dial|phone|ring)\b/i.test(q) || /\b(?:place a call to|make a phone call to|call up)\b/i.test(q)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const rawTarget = paramStr(input, 'target') ?? undefined
    const rawNumber = paramStr(input, 'number') ?? undefined
    if (!rawTarget && !rawNumber) {
      // Fall back to the utterance itself ONLY when it carries a real target.
      // A bare verb ("call", "call to") must never be dialled as a number or
      // treated as a contact name.
      const utterance = (input.query || '').trim()
      const fallback = utterance
        .replace(/^(?:call|dial|phone|ring)\b/i, '')
        .replace(/^\s*to\b\s*/i, '')
        .trim()
      if (!fallback || fallback.toLowerCase() === utterance.toLowerCase()) {
        return { ok: false, message: 'Tell me who to call — a contact name or a phone number.', data: { kind: 'invalid_input' } }
      }
      if (/^[+\d][\d\s()-]*$/.test(fallback)) {
        const normalizedFallback = normalizeDialNumber(fallback)
        if (!normalizedFallback) {
          return { ok: false, message: `"${fallback}" is not a valid phone number.`, data: { kind: 'invalid_input' } }
        }
        return this.run('dial', { number: normalizedFallback })
      }
      return this.run('dial', { target: fallback })
    }
    if (rawNumber) {
      const normalized = normalizeDialNumber(rawNumber)
      if (!normalized) {
        return { ok: false, message: `"${rawNumber}" is not a valid phone number.`, data: { kind: 'invalid_input' } }
      }
      return this.run('dial', { ...(rawTarget ? { target: rawTarget } : {}), number: normalized })
    }
    return this.run('dial', { target: rawTarget! })
  }

  verify(_input: ToolInput, result: ToolResult, ctx: ToolContext): Promise<ToolVerification> {
    return this.verifyCallState('dial', result, ctx)
  }
}

/* -------------------------------------------------------------- answer */

export class CallAnswerTool extends BaseAndroidCallTool {
  readonly id = 'call.answer'
  readonly name = 'Answer incoming call'
  readonly description =
    'Answer a currently ringing call on the paired Android companion, where the phone’s Android version and the ' +
    'ANSWER_PHONE_CALLS permission permit it. Reports NOT_SUPPORTED or PERMISSION_REQUIRED instead of pretending.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = { type: 'object', properties: {}, required: [] }

  canRun(query: string): boolean {
    return /\b(?:answer(?: the)? call|pick up(?: the phone)?|accept (?:the )?call)\b/i.test(query || '')
  }

  execute(): Promise<ToolResult> {
    return this.run('answer', {})
  }

  verify(_input: ToolInput, result: ToolResult, ctx: ToolContext): Promise<ToolVerification> {
    return this.verifyCallState('answer', result, ctx)
  }
}

/* -------------------------------------------------------------- reject */

export class CallRejectTool extends BaseAndroidCallTool {
  readonly id = 'call.reject'
  readonly name = 'Reject incoming call'
  readonly description =
    'Reject a currently ringing call on the paired Android companion, where the Android version and the ANSWER_PHONE_CALLS ' +
    'permission permit it. No SMS auto-reply is sent — JARVIS does not claim message delivery it cannot verify.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: { reason: { type: 'string', description: 'Optional short note recorded locally about why the call was rejected.' } },
    required: [],
  }

  canRun(query: string): boolean {
    return /\b(?:reject(?: the)? call|decline(?: the)? call|ignore call|dismiss call|send to voicemail)\b/i.test(query || '')
  }

  execute(input: ToolInput): Promise<ToolResult> {
    const reason = paramStr(input, 'reason')
    return this.run('reject', reason ? { reason } : {})
  }

  verify(_input: ToolInput, result: ToolResult, ctx: ToolContext): Promise<ToolVerification> {
    return this.verifyCallState('reject', result, ctx)
  }
}

/* -------------------------------------------------------------- hangup */

export class CallEndTool extends BaseAndroidCallTool {
  readonly id = 'call.end'
  readonly name = 'Hang up the call'
  readonly description =
    'End the active call on the paired Android companion. Works only where the Android version exposes call control ' +
    '(ANSWER_PHONE_CALLS); otherwise the phone reports NOT_SUPPORTED and JARVIS says so.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = { type: 'object', properties: {}, required: [] }

  canRun(query: string): boolean {
    return /\b(?:hang up|end(?: the)? call|disconnect(?: the)? call|stop call|terminate call)\b/i.test(query || '')
  }

  execute(): Promise<ToolResult> {
    return this.run('hangup', {})
  }

  verify(_input: ToolInput, result: ToolResult, ctx: ToolContext): Promise<ToolVerification> {
    return this.verifyCallState('hangup', result, ctx)
  }
}

/* -------------------------------------------------------------- status */

export class CallStatusTool extends BaseAndroidCallTool {
  readonly id = 'call.status'
  readonly name = 'Call and phone status'
  readonly description =
    'Report the real telephony state of the paired Android companion: the newest call-state event the phone actually ' +
    'reported, whether the phone is online, and which call permissions it has granted. Never estimates.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = { type: 'object', properties: {}, required: [] }

  canRun(query: string): boolean {
    return /\b(?:call status|who is calling|is the phone ringing|active call|check call|phone status|on a call)\b/i.test(query || '')
  }

  async execute(): Promise<ToolResult> {
    const caps = this.provider.capabilities()
    const phone = caps.phone
    if (!caps.available || !phone) {
      return {
        ok: false,
        message: caps.reason ?? 'No Android companion is reachable right now.',
        data: { deviceError: 'device_disconnected' as DeviceErrorKind, callState: 'DEVICE_OFFLINE' as CallState },
      }
    }
    const [latest] = this.provider.recentCallEvents(1)
    const permissionBits = [
      `CALL_PHONE ${phone.dialPermission ? 'granted' : 'not granted'}`,
      `ANSWER_PHONE_CALLS ${phone.callControlPermission ? 'granted' : 'not granted'}`,
    ].join(', ')
    const live = latest && ['CALLING', 'RINGING', 'CONNECTED'].includes(latest.state)
    const who = latest?.contactName ?? latest?.number
    const stateLine = latest
      ? `Last reported call state: ${latest.state}${who ? ` (${who})` : ''}${latest.direction ? ` · ${latest.direction}` : ''}.`
      : 'No call-state event has been reported since JARVIS started.'
    return {
      ok: true,
      message: `${phone.deviceName}: ${phone.online ? 'online' : 'offline'} · telephony ${phone.call ? 'supported' : 'not supported'} · ${permissionBits}. ${stateLine}`,
      data: {
        callState: (latest?.state ?? 'ENDED') as CallState,
        active: Boolean(live),
        deviceId: phone.deviceId,
        device: phone,
        telephonySupported: phone.call,
        permissions: { CALL_PHONE: phone.dialPermission, ANSWER_PHONE_CALLS: phone.callControlPermission },
        lastEvent: latest ?? null,
      },
    }
  }
}

/** Bind the real telephony tools to a provider; absent provider => zero tools. */
export function createAndroidCallTools(provider: AndroidProvider | undefined): Tool[] {
  if (!provider) return []
  return [
    new CallDialTool(provider),
    new CallAnswerTool(provider),
    new CallRejectTool(provider),
    new CallEndTool(provider),
    new CallStatusTool(provider),
  ]
}
