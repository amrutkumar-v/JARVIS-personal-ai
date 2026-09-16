/**
 * Outbound command queue for companion phones (Phase 4.1 — Android companion).
 *
 * JARVIS Core cannot open inbound connections to a phone behind home NAT, so
 * commands (currently just verifiable `ping`) are queued here and picked up by
 * the phone on its next `/phone/poll`. The phone executes the command and
 * acknowledges with a concrete result at `/phone/ack` — nothing is ever
 * claimed delivered without that ack.
 *
 * Queued commands expire so a phone that never comes back does not accumulate
 * stale work, and each device has a bounded pending window.
 */

export const COMMAND_TTL_MS = 60_000
export const MAX_PENDING_PER_DEVICE = 5
export const COMMAND_HISTORY_TTL_MS = 5 * 60_000

export type OutboundCommandKind = 'ping'

export interface OutboundCommand {
  commandId: string
  kind: OutboundCommandKind
  deviceId: string
  requestId: string
  enqueuedAt: number
  expiresAt: number
  /** `undefined` until the phone acknowledges. */
  ackedAt?: number
  ok?: boolean
  detail?: string
}

export interface PingAck {
  ok: boolean
  detail?: string
}

export interface PingDispatch {
  delivered: boolean
  command: OutboundCommand | null
  reason?: string
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

  /** Queue a `ping` for a trusted device; returns the dispatch verdict. */
  dispatchPing(deviceId: string, online: boolean): PingDispatch {
    const id = deviceId.trim().toLowerCase()
    this.prune(id)
    const pending = this.pendingFor(id)
    if (pending.length >= MAX_PENDING_PER_DEVICE) {
      return { delivered: false, command: null, reason: 'too many unacknowledged commands' }
    }
    const at = this.now()
    const command: OutboundCommand = {
      commandId: nextCommandId(),
      kind: 'ping',
      deviceId: id,
      requestId: nextRequestId(),
      enqueuedAt: at,
      expiresAt: at + this.commandTtlMs,
    }
    this.commands.set(command.commandId, command)
    return {
      delivered: online,
      command,
      reason: online ? undefined : 'device is offline right now; the ping is queued and will only complete when the phone polls again',
    }
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
  ack(commandId: string, deviceId: string, result: PingAck): boolean {
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

  /** Last known result for a ping requestId (or the latest ping for a device). */
  pingResult(requestId: string | undefined, deviceId: string): { requestId: string; ok?: boolean; detail?: string; ackedAt?: number; pending: boolean } | null {
    let candidate: OutboundCommand | undefined
    for (const command of this.commands.values()) {
      if (command.deviceId !== deviceId) continue
      if (requestId !== undefined && command.requestId !== requestId) continue
      if (requestId === undefined) {
        // latest ping wins
        if (!candidate || command.enqueuedAt > candidate.enqueuedAt) candidate = command
        continue
      }
      candidate = command
      break
    }
    if (!candidate) return null
    const pending = candidate.ackedAt === undefined && candidate.expiresAt > this.now()
    return {
      requestId: candidate.requestId,
      ok: candidate.ok,
      detail: candidate.detail,
      ackedAt: candidate.ackedAt,
      pending,
    }
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