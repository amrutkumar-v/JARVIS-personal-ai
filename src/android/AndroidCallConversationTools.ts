/**
 * The conversational-call surface: JARVIS places a REAL call on the paired
 * Android phone, introduces ITSELF, asks the question you gave it, and - once
 * you relay the answer - closes the call and records exactly what was said.
 *
 * WHY IT IS SPLIT IN TWO TOOLS (`call.converse` then `call.conclude`)
 *   Android does not let a normal app capture a live call's far-end audio:
 *   since Android 10 the `VOICE_CALL` / `VOICE_DOWNLINK` audio sources are
 *   refused unless the app holds `CAPTURE_AUDIO_OUTPUT`, a signature|privileged
 *   permission that is never granted to a third-party app. So JARVIS can TALK
 *   on the call, but it cannot HEAR the other party.
 *
 *   The honest, workable arrangement is therefore:
 *     1. `call.converse` - dials, waits for the call to connect, introduces
 *        itself as your assistant acting on your behalf, and asks your
 *        question. The call stays OPEN.
 *     2. You relay the answer (speak it to the PC or type it).
 *     3. `call.conclude` - speaks a closing line, hangs up for real, and
 *        saves a summary of the exchange (including the answer you relayed)
 *        to JARVIS's memory.
 *
 *   Every step is verified against a REAL observation: the phone's own call
 *   state callback, and the phone's own acknowledgement that it played the
 *   audio. Nothing here is simulated, and a failure is always reported as the
 *   failure it was.
 */
import type { ToolContext, ToolContextId, ToolInput, ToolPermission, ToolResult, ToolVerification } from '../tools/Tool'
import type { ToolInputSchema } from '../engine/provider'
import type { AndroidProvider } from './provider'
import { deviceErrorForCallState } from './AndroidCallTools'
import type { CallEventData, CallState } from '../backend/types'
import type { MemoryManager } from '../memory/MemoryManager'

/** How long the phone may take to connect before the attempt is a failure. */
export const CALL_CONNECT_TIMEOUT_MS = 60_000
/** How long the phone may take to acknowledge that it played an utterance. */
export const CALL_SPEAK_ACK_TIMEOUT_MS = 20_000
/** How long the phone may take to report that the call ended. */
export const CALL_END_TIMEOUT_MS = 30_000
/** Poll interval while waiting for the phone's acknowledgement. */
const ACK_POLL_MS = 600

/** States that mean the phone refused the call instead of placing it. */
const REFUSING_STATES: readonly CallState[] = [
  'FAILED',
  'REJECTED',
  'CANCELLED',
  'PERMISSION_REQUIRED',
  'NOT_SUPPORTED',
  'DEVICE_OFFLINE',
]

/** The metadata key a call record carries in JARVIS's memory. */
const CALL_RECORD_KIND = 'call_record'

export interface CallConversationData {
  callState: CallState
  deviceId?: string
  commandId?: string
  contact?: string
  brief?: string
  /** The exact words JARVIS said on the call, in order. */
  spoken?: string[]
  /** What the human relayed back as the other party's answer. */
  reply?: string
  /** The id of the memory item holding the call record. */
  recordId?: string
  [key: string]: unknown
}

/** The operator's name, when memory knows one. */
function operatorName(memory: MemoryManager | undefined): string {
  const raw = memory?.snapshot?.().profile?.name?.trim()
  if (!raw || raw.toLowerCase() === 'operator') return 'the user'
  return raw
}

/** The default introduction JARVIS speaks when it opens a call. */
export function defaultIntroduction(name: string): string {
  return `Hi, this is JARVIS, ${name}'s personal assistant, calling on ${name}'s behalf.`
}

/** The default closing JARVIS speaks when it closes a call. */
export function defaultClosing(name: string): string {
  return `Thanks for your time. I'll pass that on to ${name}. Goodbye.`
}

/** The default question JARVIS asks, carrying the brief verbatim. */
export function defaultQuestion(name: string, brief: string): string {
  return `${name} asked me to ask you: ${brief}`
}

/** Read the open call record out of memory, if there is one. */
function findOpenCallRecord(memory: MemoryManager | undefined): { id: string; content: string; metadata?: Record<string, unknown> } | null {
  if (!memory) return null
  for (const item of memory.items()) {
    const metadata = item.metadata as Record<string, unknown> | undefined
    if (metadata && metadata[CALL_RECORD_KIND] && metadata.state === 'open') {
      return { id: item.id, content: item.content, metadata }
    }
  }
  return null
}

/** Save or update the call record in memory. */
function writeCallRecord(
  memory: MemoryManager | undefined,
  patch: { content: string; metadata: Record<string, unknown> },
): string | undefined {
  if (!memory) return undefined
  const existing = findOpenCallRecord(memory)
  if (existing) {
    memory.update(existing.id, {
      content: patch.content,
      type: 'NOTE',
      importance: 0.6,
      metadata: patch.metadata,
    })
    return existing.id
  }
  const item = memory.remember(patch.content, {
    type: 'NOTE',
    importance: 0.6,
    source: 'user',
    metadata: patch.metadata,
  })
  return item.id
}

/** Wait for the phone to acknowledge that it played an utterance. */
async function waitForSpeakAck(
  provider: AndroidProvider,
  deviceId: string,
  commandId: string | undefined,
  ctx: ToolContext,
): Promise<{ ok: boolean; detail?: string }> {
  if (!commandId) return { ok: false, detail: 'The phone did not return a command id for the utterance.' }
  const deadline = Date.now() + CALL_SPEAK_ACK_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (ctx.signal?.aborted) return { ok: false, detail: 'The call was cancelled.' }
    const lookup = await provider.callResult(commandId, deviceId)
    if (lookup.acknowledged) {
      if (lookup.result === true) return { ok: true, detail: lookup.detail ?? undefined }
      return { ok: false, detail: lookup.detail ?? 'The phone did not play the audio.' }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(ACK_POLL_MS, remaining)))
  }
  return { ok: false, detail: `The phone did not acknowledge the utterance within ${CALL_SPEAK_ACK_TIMEOUT_MS / 1000}s.` }
}

/** Wait for a real call-state observation, or a refusal from the phone. */
async function waitForCallState(
  provider: AndroidProvider,
  input: { deviceId: string; states: CallState[]; since: number; commandId?: string },
  ctx: ToolContext,
  timeoutMs: number,
): Promise<{ event?: CallEventData; refusal?: CallEventData }> {
  const observed = await provider.awaitCallState({
    deviceId: input.deviceId,
    states: input.states,
    commandId: input.commandId,
    since: input.since,
    timeoutMs,
    signal: ctx.signal,
  })
  if (observed) return { event: observed }
  const refusal = provider
    .recentCallEvents(8)
    .find(
      (event) =>
        event.deviceId === input.deviceId &&
        REFUSING_STATES.includes(event.state) &&
        event.at >= input.since - 1_000,
    )
  return refusal ? { refusal } : {}
}

/**
 * Open a call and ask the question - the "JARVIS introduces itself" step.
 */
export class CallConverseTool {
  readonly id = 'call.converse'
  readonly name = 'Call someone and ask on my behalf'
  readonly description =
    'Place a REAL call on the paired Android phone, wait until it connects, introduce yourself as the user\'s personal ' +
    'assistant acting on their behalf, and ask them the question given in "brief". The call is left OPEN so the answer can ' +
    'be relayed and the call closed with call.conclude. You CANNOT hear the other party - Android does not allow a normal ' +
    'app to capture live call audio - so the user must relay the reply. Use "target" for a contact name or "number" for a ' +
    'phone number. Requires confirmation, an online phone, the CALL_PHONE permission, and a phone that can speak.'
  readonly category = 'communication' as const
  readonly permission: ToolPermission = 'user_confirmation'
  readonly requiresPermission = false
  readonly contexts: ToolContextId[] = ['android', 'desktop']
  readonly timeoutMs = 150_000
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      brief: {
        type: 'string',
        description:
          'What to ask them, in plain words (e.g. "whether you can come to the house at 5 pm today"). JARVIS says this ' +
          'word for word, so keep it to one or two sentences.',
      },
      target: { type: 'string', description: 'Contact name to call (e.g. "Dad"), resolved against the phone\'s real contacts.' },
      number: { type: 'string', description: 'Explicit phone number to dial (e.g. "+919876543210").' },
      intro: {
        type: 'string',
        description: 'Optional custom opening line. Defaults to JARVIS introducing itself as the user\'s assistant.',
      },
    },
    required: ['brief'],
  }

  private readonly provider: AndroidProvider

  constructor(provider: AndroidProvider) {
    this.provider = provider
  }

  canRun(query: string): boolean {
    return /\b(call|phone|ring)\b/i.test(query || '') && /\b(ask|tell|ask on my behalf|on my behalf|relay|question)\b/i.test(query || '')
  }

  async execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
    const brief = typeof input.params?.brief === 'string' ? input.params.brief.trim() : ''
    const target = typeof input.params?.target === 'string' ? input.params.target.trim() : undefined
    const number = typeof input.params?.number === 'string' ? input.params.number.trim() : undefined
    const introOverride = typeof input.params?.intro === 'string' ? input.params.intro.trim() : undefined
    if (!brief) {
      return { ok: false, message: 'Tell me what to ask them, and I will put it to them.', data: { callState: 'FAILED' } }
    }
    if (!target && !number) {
      return {
        ok: false,
        message: 'Tell me who to call - a contact name or a phone number.',
        data: { callState: 'FAILED' },
      }
    }

    const caps = this.provider.capabilities()
    const phone = caps.phone
    if (!caps.available || !phone) {
      return {
        ok: false,
        message: caps.reason ?? 'No Android companion is reachable right now.',
        data: { callState: 'DEVICE_OFFLINE' as CallState, deviceError: 'device_disconnected' },
      }
    }
    if (!phone.online) {
      return {
        ok: false,
        message: `${phone.deviceName} is offline right now, so no call was placed.`,
        data: { callState: 'DEVICE_OFFLINE' as CallState, deviceError: 'device_disconnected' },
      }
    }
    if (!phone.call || !phone.dialPermission) {
      return {
        ok: false,
        message: !phone.call
          ? `${phone.deviceName} reports no telephony capability, so JARVIS cannot call anyone.`
          : `${phone.deviceName} has not granted the CALL_PHONE permission, so JARVIS cannot call anyone.`,
        data: { callState: 'PERMISSION_REQUIRED' as CallState, deviceError: 'device_permission_required' },
      }
    }
    if (!phone.speak) {
      return {
        ok: false,
        message: `${phone.deviceName} cannot speak on a call (its speech engine is unavailable), so JARVIS cannot talk for you.`,
        data: { callState: 'NOT_SUPPORTED' as CallState, deviceError: 'device_unavailable' },
      }
    }

    const name = operatorName(ctx.memory)

    // 1. Place the real call.
    const dial = await this.provider.requestCall('dial', { ...(target ? { target } : {}), ...(number ? { number } : {}) })
    if (!dial.ok) {
      return {
        ok: false,
        message: dial.message,
        data: { callState: dial.state, deviceError: deviceErrorForCallState(dial.state) },
      }
    }
    const deviceId = dial.deviceId ?? phone.deviceId
    const startedAt = Date.now()

    // 2. Wait for the call to actually CONNECT.
    const connected = await waitForCallState(
      this.provider,
      { deviceId, states: ['CONNECTED'], since: startedAt, commandId: dial.commandId },
      ctx,
      CALL_CONNECT_TIMEOUT_MS,
    )
    if (connected.refusal) {
      return {
        ok: false,
        message: `The phone did not connect the call (${connected.refusal.state}): ${connected.refusal.reason ?? 'no reason reported'}`,
        data: { callState: connected.refusal.state, deviceError: deviceErrorForCallState(connected.refusal.state) },
      }
    }
    if (!connected.event) {
      return {
        ok: false,
        message: `The phone did not report the call as connected within ${CALL_CONNECT_TIMEOUT_MS / 1000}s, so nothing was said.`,
        data: { callState: 'FAILED' as CallState, deviceError: 'device_timeout' },
      }
    }

    // 3. Introduce itself, then ask the question.
    const spoken: string[] = []
    const introduction = introOverride || defaultIntroduction(name)
    const question = defaultQuestion(name, brief)
    for (const line of [introduction, question]) {
      const said = await this.provider.requestCall('speak', { text: line })
      if (!said.ok) {
        return {
          ok: false,
          message: `The call connected, but the phone refused to speak: ${said.message}`,
          data: { callState: said.state, deviceError: deviceErrorForCallState(said.state), spoken },
        }
      }
      const ack = await waitForSpeakAck(this.provider, deviceId, said.commandId, ctx)
      if (!ack.ok) {
        return {
          ok: false,
          message: `The call connected, but the phone did not confirm it played the message: ${ack.detail ?? 'no reason reported'}`,
          data: { callState: 'FAILED' as CallState, deviceError: 'device_timeout', spoken },
        }
      }
      spoken.push(line)
    }

    // 4. Record the open call so the closing step (and later turns) know
    //    exactly who was called and what was asked.
    const recordContent = `Call in progress: called ${target ?? number ?? 'someone'} and asked "${brief}". JARVIS introduced itself as ${name}'s assistant. Awaiting the reply.`
    const recordId = writeCallRecord(ctx.memory, {
      content: recordContent,
      metadata: { [CALL_RECORD_KIND]: true, state: 'open', contact: target ?? number ?? 'unknown', brief, spoken },
    })

    return {
      ok: true,
      message:
        `Called ${target ?? number} and the phone reported the call as connected. JARVIS said: "${introduction}" and then ` +
        `"${question}". The call is still open. JARVIS cannot hear the other party (Android blocks call-audio capture for ` +
        `normal apps), so tell me what they said and I will close the call and record the exchange.`,
      data: {
        callState: 'CONNECTED' as CallState,
        deviceId,
        commandId: dial.commandId,
        contact: target ?? number,
        brief,
        spoken,
        recordId,
      } satisfies CallConversationData,
    }
  }

  async verify(_input: ToolInput, result: ToolResult, ctx: ToolContext): Promise<ToolVerification> {
    const data = (result.data ?? {}) as Partial<CallConversationData>
    if (!data.deviceId) {
      return { ok: false, message: 'No companion device id was recorded, so the open call could not be observed.', checks: [] }
    }
    const live = this.provider.activeCall()
    if (live && live.deviceId === data.deviceId && live.state === 'CONNECTED') {
      return { ok: true, message: 'The phone still reports the call as connected.', checks: ['call-state-observed'] }
    }
    if (ctx.signal?.aborted) {
      return { ok: false, message: 'The call verification was cancelled.', checks: [] }
    }
    return { ok: false, message: 'The phone no longer reports the call as connected.', checks: [] }
  }
}

/**
 * Close the call and record what was communicated.
 */
export class CallConcludeTool {
  readonly id = 'call.conclude'
  readonly name = 'Close the call and record the exchange'
  readonly description =
    'Finish a call JARVIS opened: speak a short closing line on the still-open call, hang up for real, and save a summary ' +
    'of the exchange - including the answer the user relayed - to JARVIS\'s memory. Pass the answer the user gave you in ' +
    '"reply", and optionally a custom "closing" line to say to the other party before hanging up.'
  readonly category = 'communication' as const
  readonly permission: ToolPermission = 'user_confirmation'
  readonly requiresPermission = false
  readonly contexts: ToolContextId[] = ['android', 'desktop']
  readonly timeoutMs = 120_000
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      reply: {
        type: 'string',
        description: 'What the user said the other party answered, in their words (e.g. "he said yes, come at 5 pm").',
      },
      closing: {
        type: 'string',
        description: 'Optional custom closing line for the other party. Defaults to a short sign-off.',
      },
    },
    required: [],
  }

  private readonly provider: AndroidProvider

  constructor(provider: AndroidProvider) {
    this.provider = provider
  }

  canRun(query: string): boolean {
    return /\b(hang ?up|end the call|close the call|finish the call|wrap up|conclude)\b/i.test(query || '')
  }

  async execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
    const reply = typeof input.params?.reply === 'string' ? input.params.reply.trim() : undefined
    const closingOverride = typeof input.params?.closing === 'string' ? input.params.closing.trim() : undefined

    const caps = this.provider.capabilities()
    const phone = caps.phone
    if (!caps.available || !phone) {
      return {
        ok: false,
        message: caps.reason ?? 'No Android companion is reachable right now.',
        data: { callState: 'DEVICE_OFFLINE' as CallState, deviceError: 'device_disconnected' },
      }
    }
    const live = this.provider.activeCall()
    if (!live || live.state !== 'CONNECTED') {
      return {
        ok: false,
        message: 'There is no open call on the phone to close.',
        data: { callState: live?.state ?? ('ENDED' as CallState), deviceError: 'device_unavailable' },
      }
    }
    if (!phone.speak) {
      return {
        ok: false,
        message: `${phone.deviceName} cannot speak on a call, so JARVIS cannot say a closing line.`,
        data: { callState: 'NOT_SUPPORTED' as CallState, deviceError: 'device_unavailable' },
      }
    }

    const name = operatorName(ctx.memory)
    const record = findOpenCallRecord(ctx.memory)
    const brief = typeof record?.metadata?.brief === 'string' ? record.metadata.brief : undefined
    const contact =
      (typeof record?.metadata?.contact === 'string' ? record.metadata.contact : undefined) ??
      live.contactName ??
      live.number
    const closing = closingOverride || defaultClosing(name)

    // 1. Say the closing line while the call is still up.
    const said = await this.provider.requestCall('speak', { text: closing })
    if (!said.ok) {
      return {
        ok: false,
        message: `The phone refused to say the closing line: ${said.message}`,
        data: { callState: said.state, deviceError: deviceErrorForCallState(said.state) },
      }
    }
    const ack = await waitForSpeakAck(this.provider, live.deviceId, said.commandId, ctx)
    if (!ack.ok) {
      return {
        ok: false,
        message: `The phone did not confirm it played the closing line: ${ack.detail ?? 'no reason reported'}`,
        data: { callState: 'FAILED' as CallState, deviceError: 'device_timeout' },
      }
    }

    // 2. Hang up for real.
    const ended = await this.provider.requestCall('hangup', {})
    if (!ended.ok) {
      return {
        ok: false,
        message: `JARVIS said the closing line, but the phone refused to end the call: ${ended.message}`,
        data: { callState: ended.state, deviceError: deviceErrorForCallState(ended.state) },
      }
    }
    const finished = await waitForCallState(
      this.provider,
      { deviceId: live.deviceId, states: ['ENDED'], since: Date.now() - 2_000, commandId: ended.commandId },
      ctx,
      CALL_END_TIMEOUT_MS,
    )
    if (!finished.event) {
      return {
        ok: false,
        message: `The phone did not report the call as ended within ${CALL_END_TIMEOUT_MS / 1000}s.`,
        data: { callState: 'FAILED' as CallState, deviceError: 'device_timeout' },
      }
    }

    // 3. Record what was communicated.
    const priorSpoken = record?.metadata?.spoken
    const spoken = [...(Array.isArray(priorSpoken) ? (priorSpoken as string[]) : []), closing]
    const summary =
      `Called ${contact ?? 'someone'}` +
      (brief ? ` and asked "${brief}".` : '.') +
      ` JARVIS introduced itself as ${name}'s personal assistant and said: ${spoken.map((line) => `"${line}"`).join(' ')}` +
      (reply ? ` The user relayed the answer: "${reply}".` : ' The user did not relay an answer.') +
      ' The call was ended by JARVIS.'
    const recordId = writeCallRecord(ctx.memory, {
      content: summary,
      metadata: {
        [CALL_RECORD_KIND]: true,
        state: 'closed',
        contact: contact ?? 'unknown',
        brief: brief ?? '',
        spoken,
        reply: reply ?? '',
      },
    })

    return {
      ok: true,
      message: `Closed the call to ${contact ?? 'the person'}. ${summary}`,
      data: {
        callState: 'ENDED' as CallState,
        deviceId: live.deviceId,
        contact,
        brief,
        spoken,
        reply,
        recordId,
        summary,
      } satisfies CallConversationData,
    }
  }

  async verify(_input: ToolInput, result: ToolResult, _ctx: ToolContext): Promise<ToolVerification> {
    const data = (result.data ?? {}) as Partial<CallConversationData>
    if (data.callState !== 'ENDED') {
      return { ok: false, message: 'The call was not reported as ended.', checks: [] }
    }
    const live = this.provider.activeCall()
    if (live && live.state === 'CONNECTED') {
      return { ok: false, message: 'The phone still reports a connected call.', checks: [] }
    }
    return { ok: true, message: 'The phone reported the call as ended.', checks: ['call-state-observed'] }
  }
}

/**
 * Read back what the last call(s) actually communicated.
 */
export class CallSummarizeTool {
  readonly id = 'call.summarize'
  readonly name = 'Summarize the last call'
  readonly description =
    'Summarize the last phone call JARVIS made: who was called, what was asked, what the user said the answer was, and how ' +
    'the call ended. Reads the call records JARVIS saved - it never invents a call that did not happen.'
  readonly category = 'communication' as const
  readonly permission: ToolPermission = 'read_only'
  readonly requiresPermission = false
  readonly contexts: ToolContextId[] = ['android', 'desktop']
  readonly verifiable = false
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {},
    required: [],
  }

  private readonly provider: AndroidProvider

  constructor(provider: AndroidProvider) {
    this.provider = provider
  }

  canRun(query: string): boolean {
    return /\b(summar|what did (i|we) (say|tell)|recap|last call)\b/i.test(query || '')
  }

  async execute(_input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
    const caps = this.provider.capabilities()
    if (!caps.available) {
      return {
        ok: false,
        message: caps.reason ?? 'No Android companion is reachable right now.',
        data: { callState: 'DEVICE_OFFLINE' as CallState, deviceError: 'device_disconnected' },
      }
    }
    const memory = ctx.memory
    if (!memory) {
      return { ok: false, message: 'JARVIS memory is not available, so the call record cannot be read.', data: { callState: 'FAILED' } }
    }
    const records = memory
      .items()
      .filter((item) => {
        const metadata = item.metadata as Record<string, unknown> | undefined
        return Boolean(metadata && metadata[CALL_RECORD_KIND])
      })
      .slice(0, 5)
    if (records.length === 0) {
      return {
        ok: true,
        message: 'JARVIS has no call records yet - no call has been made from this device.',
        data: { callState: 'ENDED' as CallState, records: [] },
      }
    }
    const lines = records.map((item) => `- ${item.content}`)
    return {
      ok: true,
      message: `Call records:\n${lines.join('\n')}`,
      data: {
        callState: 'ENDED' as CallState,
        records: records.map((item) => ({ id: item.id, content: item.content, updatedAt: item.updatedAt })),
      },
    }
  }
}
