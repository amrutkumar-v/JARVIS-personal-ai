/**
 * Phone LAN listener for the JARVIS Core backend (Phase 4.1 — Android
 * companion).
 *
 * The Android companion reaches JARVIS Core over the home Wi-Fi through this
 * SEPARATE, narrow listener. The main backend keeps binding `127.0.0.1` and is
 * never exposed to the LAN; this listener is the ONLY surface a phone talks to
 * and it exposes exactly six allow-listed endpoints:
 *
 *   POST /phone/pair       — exchange a short-lived pairing code for a device
 *                            credential (the ONLY unauthenticated endpoint)
 *   POST /phone/heartbeat   — real liveness + telemetry (credential auth)
 *   POST /phone/ping        — phone → core reachability echo (credential auth)
 *   POST /phone/status      — what JARVIS Core currently believes about this
 *                             device (credential auth)
 *   POST /phone/poll        — drain queued outbound commands (credential auth)
 *   POST /phone/ack         — report a concrete result for a command
 *                            (credential auth)
 *   POST /phone/event       — push a REAL device event (currently telephony
 *                            call state the phone observed from the OS) into
 *                            the JARVIS Core event bus (credential auth)
 *
 * Every non-pair endpoint requires a per-device credential issued at pairing.
 * The credential only ever works for the device it was issued to (the body id
 * must match the credential's device) and is validated in constant time against
 * a stored SHA-256. No AI keys, file upload, notify, open-url or registry-mut
 * surface exists here — a leaked access can only ever report/ack/h/.heartbeat
 * a single already-paired device.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Logger } from './log.js'
import { nullLogger } from './log.js'
import type { DeviceRegistry } from './registry.js'
import type { PhoneTrust, ClaimedPairing } from './phoneTrust.js'
import type { PhoneCommandQueue, OutboundCommand, PingAck } from './phoneCommands.js'
import type { EventBus } from './events.js'
import type { CallDirection, CallEventData, CallState, ClaimMeta } from './types.js'

const MAX_PHONE_BODY_BYTES = 64 * 1024
const FIELD_LIMIT = 60

/** The complete telephony-state vocabulary a phone may report. */
const CALL_STATES: readonly CallState[] = [
  'CALL_REQUESTED',
  'CALLING',
  'RINGING',
  'CONNECTED',
  'ENDED',
  'FAILED',
  'REJECTED',
  'CANCELLED',
  'PERMISSION_REQUIRED',
  'NOT_SUPPORTED',
  'DEVICE_OFFLINE',
]

/** The only event kinds the phone listener accepts from a device. */
const PHONE_EVENT_KINDS = ['call.state'] as const
const CALL_DIRECTIONS: readonly CallDirection[] = ['incoming', 'outgoing']

export interface PhoneServerOptions {
  host: string
  port: number
  registry: DeviceRegistry
  pairing: PhoneTrust
  commands: PhoneCommandQueue
  now: () => number
  log?: Logger
  /** Event bus: real device events pushed by the phone are fanned out here. */
  bus?: EventBus
}

export interface RunningPhoneServer {
  url: string
  port: number
  close(): Promise<void>
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_PHONE_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buf.length
    if (size > maxBytes) throw new Error('body_too_large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  return JSON.parse(text) as unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function str(value: unknown, limit = FIELD_LIMIT): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, limit) : undefined
}

function numberBattery(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(100, Math.max(0, value))
}

function stringArray(value: unknown, itemLimit = 64): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .slice(0, 40)
    .map((v) => v.trim().slice(0, itemLimit))
}

function parseMeta(body: Record<string, unknown>): ClaimMeta {
  const meta = asRecord(body.meta)
  const battery = numberBattery(meta.battery)
  return {
    name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim().slice(0, 80) : undefined,
    version: str(meta.version),
    battery,
    charging: typeof meta.charging === 'boolean' ? meta.charging : undefined,
    network: typeof meta.network === 'string' && meta.network.trim() ? meta.network.trim().slice(0, 40) : undefined,
    activity: typeof meta.activity === 'string' && meta.activity.trim() ? meta.activity.trim().slice(0, 80) : undefined,
    connection: str(meta.connection, 40),
    capabilities: stringArray(meta.capabilities),
    permissions: stringArray(meta.permissions),
  }
}

export async function startPhoneServer(options: PhoneServerOptions): Promise<RunningPhoneServer> {
  const log = options.log ?? nullLogger()
  const { registry, pairing, commands, now } = options

  const server: Server = createServer(async (req, res) => {
    res.on('error', () => undefined)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    try {
      if (pathname !== '/phone/pair' && pathname !== '/phone/heartbeat' && pathname !== '/phone/ping' && pathname !== '/phone/status' && pathname !== '/phone/poll' && pathname !== '/phone/ack' && pathname !== '/phone/event') {
        json(res, 404, { ok: false, error: 'not_found' })
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }

      let body: Record<string, unknown>
      try {
        const parsed = await readJsonBody(req)
        body = asRecord(parsed)
      } catch (error) {
        const code = error instanceof Error && error.message === 'body_too_large' ? 'body_too_large' : 'malformed'
        json(res, code === 'body_too_large' ? 413 : 400, { ok: false, error: code })
        return
      }

      /* ---------------------------- pairing (unauthenticated) ---------- */
      if (pathname === '/phone/pair') {
        const device = str(body.device, 80)?.toLowerCase()
        const code = typeof body.code === 'string' ? body.code.trim() : ''
        if (!device || !code) {
          json(res, 400, { ok: false, error: 'device and code are required' })
          return
        }
        const claimed = pairing.claim(device, code)
        if (!claimed.ok) {
          const status = claimed.error === 'pairing_expired' || claimed.error === 'pairing_exhausted' ? 410 : 401
          log.warn('phone', 'pairing rejected', { device: device.slice(0, 40), error: claimed.error, source: hostOf(req) })
          json(res, status, { ok: false, error: claimed.error })
          return
        }
        const record = registry.get(claimed.claimed.deviceId)
        log.info('phone', 'device paired', { device: claimed.claimed.deviceId, source: hostOf(req) })
        json(res, 200, {
          ok: true,
          token: claimed.claimed.token,
          device: record
            ? { id: record.id, name: record.name, role: record.role ?? null, platform: record.platform }
            : { id: claimed.claimed.deviceId, name: claimed.claimed.deviceId, role: null, platform: 'android' },
        })
        return
      }

      /* ---------------- credential auth for everything else ------------- */
      const header = req.headers.authorization ?? ''
      const token = header.trim().startsWith('Bearer ') ? header.trim().slice('Bearer '.length).trim() : header.trim()
      const deviceId = str(body.id, 80)?.toLowerCase()
      if (!deviceId) {
        json(res, 400, { ok: false, error: 'id is required' })
        return
      }
      if (!token || !pairing.authorize(deviceId, token)) {
        log.warn('phone', 'authentication failed', { device: deviceId.slice(0, 40), path: pathname, source: hostOf(req) })
        json(res, 401, { ok: false, error: 'unauthorized' })
        return
      }

      if (pathname === '/phone/heartbeat') {
        const meta = parseMeta(body)
        const ok = registry.heartbeat(deviceId, meta)
        json(res, 200, ok ? { ok: true, serverAt: now(), deviceId } : { ok: false, error: 'unknown_device' })
        return
      }

      if (pathname === '/phone/ping') {
        json(res, 200, { ok: true, pong: true, serverAt: now(), deviceId })
        return
      }

      if (pathname === '/phone/status') {
        const record = registry.get(deviceId)
        json(res, 200, record ? { ok: true, serverAt: now(), device: record } : { ok: false, error: 'unknown_device' })
        return
      }

      if (pathname === '/phone/poll') {
        const commandsOut: OutboundCommand[] = commands.nextFor(deviceId)
        json(res, 200, { ok: true, serverAt: now(), commands: commandsOut })
        return
      }

      if (pathname === '/phone/ack') {
        const commandId = str(body.commandId, 100)
        const commandOk = typeof body.ok === 'boolean' ? body.ok : false
        const detail = typeof body.detail === 'string' && body.detail.trim() ? body.detail.trim().slice(0, 500) : undefined
        if (!commandId) {
          json(res, 400, { ok: false, error: 'commandId is required' })
          return
        }
        const result: PingAck = { ok: commandOk, detail }
        const accepted = commands.ack(commandId, deviceId, result)
        json(res, 200, accepted ? { ok: true, acknowledged: true, commandId } : { ok: false, error: 'unknown_command' })
        return
      }

      if (pathname === '/phone/event') {
        // A phone may only push a small, closed set of REAL observations. The
        // state vocabulary is validated here, so a device can never inject an
        // arbitrary event shape into the JARVIS Core bus.
        const kind = str(body.kind, 40)
        if (!kind || !(PHONE_EVENT_KINDS as readonly string[]).includes(kind)) {
          json(res, 400, { ok: false, error: 'unsupported_event_kind' })
          return
        }
        const state = str(body.state, 40) as CallState | undefined
        if (!state || !CALL_STATES.includes(state)) {
          json(res, 400, { ok: false, error: 'invalid_call_state' })
          return
        }
        const directionRaw = str(body.direction, 20)
        const direction = directionRaw && (CALL_DIRECTIONS as readonly string[]).includes(directionRaw)
          ? (directionRaw as CallDirection)
          : undefined
        const record = registry.get(deviceId)
        const event: CallEventData = {
          deviceId,
          state,
          direction,
          commandId: str(body.commandId, 100),
          contactName: str(body.contactName, 80),
          number: str(body.number, 40),
          reason: str(body.reason, 200),
          at: now(),
        }
        log.info('phone', 'call state reported', { device: deviceId, state, direction: direction ?? 'unknown' })
        options.bus?.publish({ type: 'call', at: event.at, data: event })
        json(res, 200, { ok: true, accepted: true, deviceId, callState: state, deviceOnline: record?.online === true })
        return
      }
    } catch (error) {
      log.error('phone', 'request failed', { pathname, error: error instanceof Error ? error.message : String(error) })
      json(res, 500, { ok: false, error: 'internal_error' })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  log.info('phone', 'phone listener listening', {
    url: `http://${options.host}:${port}`,
    endpoints: ['/phone/pair', '/phone/heartbeat', '/phone/ping', '/phone/status', '/phone/poll', '/phone/ack', '/phone/event'],
  })

  return {
    url: `http://${options.host}:${port}`,
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function hostOf(req: IncomingMessage): string {
  const remote = req.socket?.remoteAddress ?? ''
  return remote.slice(0, 64)
}

export type { ClaimedPairing }