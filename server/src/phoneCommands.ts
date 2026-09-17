/**
 * Outbound command queue for companion phones (Phase 4.1 → Phase 10 calling).
 *
 * JARVIS Core cannot open inbound connections to a phone behind home NAT, so
 * commands are queued here and picked up by the phone on its next
 * `/phone/poll`. The phone executes the command and acknowledges with a
 * concrete result at `/phone/ack` — nothing is ever claimed delivered without
 * that ack.
 *
 * The command set is a CLOSED, application-owned allow-list. There is no
 * generic "run this" command: the model can only ever request one of these
 * kinds, and each kind declares the exact payload fields it accepts so nothing
 * else can be smuggled to the device.
 *
 * Queued commands expire so a phone that never comes back does not accumulate
 * stale work, and each device has a bounded pending window.
 */

export const COMMAND_TTL_MS = 60_000
export const MAX_PENDING_PER_DEVICE = 5
export const COMMAND_HISTORY_TTL_MS = 5 * 60_000
/** Bounded size of one string payload field (numbers/reasons/etc.). */
export const MAX_PAYLOAD_FIELD_CHARS = 120

/**
 * The complete command vocabulary. `ping` is the reachability echo; the call
 * commands are the real telephony surface the Android companion implements
 * through OS telephony APIs where the platform permits them.
 */
export type OutboundCommandKind = 'ping' | 'call.dial' | 'call.hangup' | 'call.answer' | 'call.reject'

export const OUTBOUND_COMMAND_KINDS: readonly OutboundCommandKind[] = [
  'ping',
  'call.dial',
  'call.hangup',
  'call.answer',
  'call.reject',
]

/**
 * Exact payload fields each kind accepts. Anything not listed here is DROPPED
 * (never forwarded): the phone therefore only ever receives fields its own
 * handler validates.
 */
export const COMMAND_PAYLOAD_FIELDS: Record<OutboundCommandKind, readonly string[]> = {
  ping: [],
  'call.dial': ['target', 'number', 'contactName'],
  'call.hangup': [],
  'call.answer': [],
  'call.reject': ['reason'],
}

export interface OutboundCommand {
  commandId: string
  kind: OutboundCommandKind
  deviceId: string
  requestId: string
  enqueuedAt: number
  expiresAt: number
  /** Allow-listed, bounded payload for this kind (absent for payload-free kinds). */
  payload?: Record<string, string>
  /** `undefined` until the phone acknowledges. */
  ackedAt?: number
  ok?: boolean
  detail?: string
}

export interface CommandAck {
  ok: boolean
  detail?: string
}

/** Backwards-compatible alias (the original queue only carried pings). */
export type PingAck = CommandAck

export interface CommandDispatch {
  delivered: boolean
  command: OutboundCommand | null
  reason?: string
}

export interface PingDispatch extends CommandDispatch {}

export interface EnqueueInput {
  deviceId: string
  kind: OutboundCommandKind
  /** Raw candidate payload; sanitized against COMMAND_PAYLOAD_FIELDS. */
  payload?: Record<string, unknown>
  /** Whether the target device is online RIGHT NOW. */
  online: boolean
}

export interface CommandResult {
  commandId: string
  kind: OutboundCommandKind
  requestId: string
  ok?: boolean
  detail?: string
  ackedAt?: number
  pending: boolean
}

/** Keep only the allow-listed fields for `kind`, bounded and trimmed. */
export function sanitizeCommandPayload(
  kind: OutboundCommandKind,
  payload: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!payload) return undefined
  const allowed = COMMAND_PAYLOAD_FIELDS[kind]
  if (allowed.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const field of allowed) {
    const value = payload[field]
    if (typeof value === 'string') {
      const trimmed = value.trim().slice(0, MAX_PAYLOAD_FIELD_CHARS)
      if (trimmed) out[field] = trimmed
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[field] = String(value).slice(0, MAX_PAYLOAD_FIELD_CHARS)
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

let sequence = 0

function nextRequestId(): string {
  sequence = (sequence + 1) % 0xffffff
  return `${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function nextCommandId(): string {
  return nextRequestId()
}

export class PhoneCommandQueue {
  private readonly now: () => number
  private readonly commandTtlMs: number
  private readonly historyTtlMs: number
  private readonly commands = new Map<string, OutboundCommand>()

  constructor(opts: { now?: () => number; commandTtlMs?: number; historyTtlMs?: number } = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.commandTtlMs = opts.commandTtlMs ?? COMMAND_TTL_MS
    this.historyTtlMs = opts.historyTtlMs ?? COMMAND_HISTORY_TTL_MS
  }

  /** Queue any allow-listed command for a trusted device; returns the verdict. */
  enqueue(input: EnqueueInput): CommandDispatch {
    const id = input.deviceId.trim().toLowerCase()
    if (!id) return { delivered: false, command: null, reason: 'deviceId is required' }
    if (!OUTBOUND_COMMAND_KINDS.includes(input.kind)) {
      return { delivered: false, command: null, reason: `"${input.kind}" is not an allowed command kind` }
    }
    this.prune(id)
    const pending = this.pendingFor(id)
    if (pending.length >= MAX_PENDING_PER_DEVICE) {
      return { delivered: false, command: null, reason: 'too many unacknowledged commands' }
    }
    const at = this.now()
    const payload = sanitizeCommandPayload(input.kind, input.payload)
    const command: OutboundCommand = {
      commandId: nextCommandId(),
      kind: input.kind,
      deviceId: id,
      requestId: nextRequestId(),
      enqueuedAt: at,
      expiresAt: at + this.commandTtlMs,
      ...(payload ? { payload } : {}),
    }
    this.commands.set(command.commandId, command)
    return {
      delivered: input.online,
      command,
      reason: input.online ? undefined : 'device is offline right now; the command is queued and will only complete when the phone polls again',
    }
  }

  /** Queue a `ping` for a trusted device (original Phase 4.1 surface). */
  dispatchPing(deviceId: string, online: boolean): PingDispatch {
    return this.enqueue({ deviceId, kind: 'ping', online })
  }

  /** Drain (and mark in-flight) the pending commands a phone should run now. */
  nextFor(deviceId: string, limit = 10): OutboundCommand[] {
    const id = deviceId.trim().toLowerCase()
    this.prune(id)
    const at = this.now()
    const found: OutboundCommand[] = []
    for (const command of this.commands.values()) {
      if (found.length >= limit) break
      if (command.deviceId !== id || command.ackedAt !== undefined || command.expiresAt <= at) continue
      found.push({ ...command })
    }
    return found
  }

  /** Verify a phone executed a command and record the concrete result. */
  ack(commandId: string, deviceId: string, result: CommandAck): boolean {
    const command = this.commands.get(commandId)
    if (!command || command.deviceId !== deviceId.trim().toLowerCase()) return false
    if (command.ackedAt !== undefined) return false
    const at = this.now()
    command.ackedAt = at
    command.ok = result.ok
    command.detail = result.detail
    command.expiresAt = at + this.historyTtlMs
    return true
  }

  /** The command a specific id refers to (undefined when unknown). */
  get(commandId: string): OutboundCommand | undefined {
    const command = this.commands.get(commandId)
    return command ? { ...command } : undefined
  }

  /**
   * Latest result for a command: by explicit `commandId`, or by `requestId`,
   * or (when neither is given) the newest command of `kind` for the device.
   */
  result(
    lookup: { commandId?: string; requestId?: string; kind?: OutboundCommandKind },
    deviceId: string,
  ): CommandResult | null {
    const id = deviceId.trim().toLowerCase()
    const now = this.now()
    let candidate: OutboundCommand | undefined
    for (const command of this.commands.values()) {
      if (command.deviceId !== id) continue
      if (lookup.commandId !== undefined) {
        if (command.commandId === lookup.commandId) candidate = command
        continue
      }
      if (lookup.requestId !== undefined) {
        if (command.requestId === lookup.requestId) candidate = command
        continue
      }
      if (lookup.kind !== undefined && command.kind !== lookup.kind) continue
      if (!candidate || command.enqueuedAt > candidate.enqueuedAt) candidate = command
    }
    if (!candidate) return null
    return {
      commandId: candidate.commandId,
      kind: candidate.kind,
      requestId: candidate.requestId,
      ok: candidate.ok,
      detail: candidate.detail,
      ackedAt: candidate.ackedAt,
      pending: candidate.ackedAt === undefined && candidate.expiresAt > now,
    }
  }

  /** Last known result for a ping requestId (or the latest ping for a device). */
  pingResult(
    requestId: string | undefined,
    deviceId: string,
  ): { requestId: string; ok?: boolean; detail?: string; ackedAt?: number; pending: boolean } | null {
    const result = this.result({ requestId, kind: 'ping' }, deviceId)
    if (!result) return null
    return { requestId: result.requestId, ok: result.ok, detail: result.detail, ackedAt: result.ackedAt, pending: result.pending }
  }

  private pendingFor(deviceId: string): OutboundCommand[] {
    const now = this.now()
    return [...this.commands.values()].filter((c) => c.deviceId === deviceId && c.ackedAt === undefined && c.expiresAt > now)
  }

  private prune(deviceId: string): void {
    const now = this.now()
    for (const [commandId, command] of this.commands) {
      if (command.deviceId !== deviceId) continue
      const dead = command.expiresAt <= now
      const ackedOld = command.ackedAt !== undefined && command.ackedAt + this.historyTtlMs <= now
      if (dead || ackedOld) this.commands.delete(commandId)
    }
  }
}
