/**
 * HTTP + SSE server for the JARVIS Core backend (Phase 2.8).
 *
 * Zero-dependency `node:http` router:
 *   GET  /health                    — aggregate runtime health
 *   GET  /events                    — SSE event hub (named events)
 *   GET  /api/device/registry       — the four trusted devices (identity + presence)
 *   GET  /api/device/list           — device registry snapshot (alias)
 *   POST /api/device/claim          — PAIRED device claims a trusted identity
 *   POST /api/device/heartbeat      — trusted device liveness + telemetry
 *   POST /api/device/pair/begin     — start a phone pairing session (code shown on the laptop)
 *   POST /api/device/ping           — queue a verifiable ping for a trusted phone
 *   POST /api/device/ping/result    — read the result of a queued ping (loopback only)
 *   POST /api/device/call           — queue a real telephony action (dial/hangup/answer/reject)
 *   POST /api/device/call/result    — read the concrete result/ack of a queued call command
 *   POST /api/device/notify         — notify 'all' or one trusted device
 *   POST /api/device/open-url       — ask an online trusted device to open a URL
 *   POST /api/device/file           — upload a bounded, optionally targeted file
 *   GET  /api/files|/api/files/:id  — list / download transferred files
 *   POST /api/inbound               — device → laptop text
 *   POST /api/assistant/state       — browser assistant runtime mirror
 *   POST /api/ai/chat/completions   — AI Provider Router: chat (multi-provider)
 *   POST /api/ai/embeddings         — AI Provider Router: semantic embeddings
 *   POST /api/wake                  — browser wake registry events
 *   GET  /                          — built SPA (when present)
 *   GET  /phone                     — companion device page
 *
 * Security model: JARVIS is a PERSONAL four-device ecosystem. Unknown devices
 * are refused at `/api/device/claim` (never added to the registry), notify
 * only targets canonical trusted ids, and every `/api/*` POST requires the
 * bearer token when one is configured. The assistant engine itself stays
 * browser-hosted (see version.ts); the backend is the durable coordinator.
 *
 * Android companion pairing: the main backend stays loopback-only. The phone
 * reaches JARVIS through the separate phone listener (phoneServer.ts) on the
 * LAN; this server only starts pairing sessions and queues/verifies pings.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { Logger } from './log.js'
import { nullLogger } from './log.js'
import type { EventBus, SseClient } from './events.js'
import type { DeviceRegistry } from './registry.js'
import type { FileStore } from './files.js'
import type { NativeStatus } from './native.js'
import type { BackendHealth, CallState, InboundMessage, WakeState } from './types.js'
import { AI_PROXY_SUBPATHS, type AiProxyOptions, type AiProxySubpath } from './ai.js'
import { createAiProviderRouter, type AiRouter, type AiRouteResult } from './aiProvider.js'
import { PhoneTrust } from './phoneTrust.js'
import { PhoneCommandQueue } from './phoneCommands.js'
import { trustedDeviceByRole } from './trusted.js'
import { NATIVE_RPC_METHODS } from './nativeMethods.js'
import type { TaskService } from './taskService.js'
import { DevEngine } from './dev/DevEngine.js'

const SESSION_COOKIE = 'jarvis_session'
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60

const MAX_BODY_BYTES = 48 * 1024 * 1024
const TITLE_LIMIT = 120
const MESSAGE_LIMIT = 2000
const TEXT_LIMIT = 2000
const URL_LIMIT = 2048
const MAX_LIST_ITEMS = 40

export interface RuntimeContext {
  name: string
  version: string
  protocol: string
  pid: number
  startedAt: number
  dataDir: string
  lockFile?: string
  logFile?: string
  registry: DeviceRegistry
  bus: EventBus
  files: FileStore
  nativeStatus: () => NativeStatus
  assistant: Record<string, unknown>
  wake: WakeState
  now: () => number
  health: () => BackendHealth
  /** Phone pairing trust store (optional — created in-memory when absent). */
  pairing?: PhoneTrust
  /** Queued outbound phone commands (optional — created in-memory when absent). */
  deviceCommands?: PhoneCommandQueue
  /** Persistent background task orchestrator service. */
  tasks?: TaskService
  /** Autonomous development agent engine. */
  devEngine?: DevEngine
}

export interface HttpServerOptions {
  host: string
  port: number
  context: RuntimeContext
  /** Directory containing the built SPA (dist/); optional. */
  staticDir?: string
  /** Directory containing static public assets (phone.html). */
  publicDir?: string
  /** Optional bearer token protecting POST endpoints. */
  token: string
  /** Explicit browser origins allowed to call privileged backend routes. */
  trustedOrigins?: string[]
  /** Server-side authenticated native agent. Never sent to browser code. */
  nativeAgent?: { baseUrl: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number }
  /** Optional server-side AI proxy configuration (JARVIS_AI_BASE_URL). */
  ai?: AiProxyOptions
  log?: Logger
}

/**
 * Explicit allowlist of metadata fields that unprivileged HTTP clients may provide.
 * Security-critical fields (autoApprove, authorizedScopes, permissions, etc.) are strictly prohibited.
 */
export const ALLOWED_CLIENT_TASK_METADATA_FIELDS = new Set([
  'clientRequestId',
  'source',
  'uiContext',
  'displayMode',
  'category',
  'notes',
  'description',
  'customLabels',
  'notificationLevel',
  'projectPath',
  'idempotencyKey',
])

export function sanitizeClientTaskMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (ALLOWED_CLIENT_TASK_METADATA_FIELDS.has(key)) {
      clean[key] = value
    }
  }
  return Object.keys(clean).length > 0 ? clean : undefined
}

export interface RunningHttp {
  url: string
  port: number
  close(): Promise<void>
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function appendAiRouteHeaders(res: ServerResponse, route: AiRouteResult): void {
  if (route.provider !== 'none') res.setHeader('x-jarvis-provider', route.provider)
  if (route.model) res.setHeader('x-jarvis-provider-model', route.model)
}

function isAuthorized(token: string, req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? ''
  const given = header.trim().startsWith('Bearer ') ? header.trim().slice('Bearer '.length).trim() : header.trim()
  if (!given || given.length !== token.length) return false
  let diff = 0
  for (let i = 0; i < token.length; i += 1) {
    diff |= token.charCodeAt(i) ^ given.charCodeAt(i)
  }
  return diff === 0
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const cookie = req.headers.cookie
  if (!cookie) return undefined
  for (const entry of cookie.split(';')) {
    const separator = entry.indexOf('=')
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue
    return entry.slice(separator + 1).trim()
  }
  return undefined
}

function sameSecret(left: string | undefined, right: string): boolean {
  if (!left || left.length !== right.length) return false
  return timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

function normalizeOrigin(origin: string): string | undefined {
  if (origin === 'null') return undefined
  try {
    const parsed = new URL(origin)
    if (parsed.origin !== origin || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

function defaultTrustedOrigins(host: string, port: number): string[] {
  return [
    `http://${hostToString(host)}:${port}`,
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]
}

function setSessionCookie(res: ServerResponse, req: IncomingMessage, sessionId: string): void {
  const secure = Boolean((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted)
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure ? '; Secure' : ''}`)
  res.setHeader('Cache-Control', 'no-store')
}

async function readRawBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += buf.length
    if (size > maxBytes) {
      throw new Error('body_too_large')
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const text = (await readRawBody(req, maxBytes)).toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text) as unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function stringSlice(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const s = value.trim()
  return s.length > 0 ? s.slice(0, limit) : undefined
}

/**
 * A list of strings the client reported, or `undefined` when the field was
 * ABSENT.
 *
 * "Not reported" must never be confused with "reported empty": a client that
 * omits `capabilities`/`permissions` must not erase what the device can do.
 */
function stringArray(value: unknown, itemLimit = 64): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .slice(0, MAX_LIST_ITEMS)
    .map((v) => v.trim().slice(0, itemLimit))
}

/* --------------------------------------------------- telephony helpers */

/**
 * The closed set of call actions the backend can queue for a phone, and the
 * exact Android permission each one needs the phone to report. Nothing here
 * executes anything — the phone does, on its next poll, through OS APIs only.
 */
/** Capability the phone MUST report (via heartbeat) before a call is queued. */
export const CALL_CAPABILITY = 'call'

/** Capability the phone MUST report before it may speak into a live call. */
export const SPEAK_CAPABILITY = 'call.speak'

export interface CallActionSpec {
  kind: 'call.dial' | 'call.hangup' | 'call.answer' | 'call.reject' | 'call.speak'
  /** Runtime permission the companion app MUST report for this action. */
  permission: string | null
  /** Capability the companion app MUST report for this action. */
  capability: string
}

export const CALL_ACTIONS: Record<string, CallActionSpec> = {
  dial: { kind: 'call.dial', permission: 'CALL_PHONE', capability: CALL_CAPABILITY },
  hangup: { kind: 'call.hangup', permission: 'ANSWER_PHONE_CALLS', capability: CALL_CAPABILITY },
  answer: { kind: 'call.answer', permission: 'ANSWER_PHONE_CALLS', capability: CALL_CAPABILITY },
  reject: { kind: 'call.reject', permission: 'ANSWER_PHONE_CALLS', capability: CALL_CAPABILITY },
  // Speaking into a live call needs no telephony permission, but the phone MUST
  // advertise that it can actually speak (it needs a text-to-speech engine).
  speak: { kind: 'call.speak', permission: null, capability: SPEAK_CAPABILITY },
}

/** Normalize a dialled number: keep an optional leading +, digits only. */
export function normalizePhoneNumber(raw: string): string | undefined {
  const trimmed = raw.trim().slice(0, 40)
  if (!trimmed) return undefined
  const plus = trimmed.startsWith('+')
  const digits = trimmed.replace(/[^\d]/g, '')
  if (digits.length < 3 || digits.length > 20) return undefined
  return plus ? `+${digits}` : digits
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

function contentTypeFor(pathname: string): string {
  const dot = pathname.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return MIME[pathname.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

async function serveFile(res: ServerResponse, dir: string | undefined, pathname: string, fallback?: string): Promise<boolean> {
  if (!dir || !existsSync(dir)) return false
  const candidate = normalize(join(dir, fallback ?? pathname))
  const root = normalize(dir)
  if (candidate !== root && !candidate.startsWith(root + '\\') && !candidate.startsWith(root + '/') && !candidate.startsWith('\\\\?\\')) {
    return false
  }
  try {
    const info = await stat(candidate)
    if (!info.isFile()) return false
    const body = await readFile(candidate)
    res.writeHead(200, {
      'content-type': contentTypeFor(candidate),
      'content-length': body.length,
    })
    res.end(body)
    return true
  } catch {
    return false
  }
}

/** Serve the companion page without embedding any server-side credential. */
async function servePhone(res: ServerResponse, publicDir: string | undefined): Promise<boolean> {
  if (!publicDir) return false
  const file = join(publicDir, 'phone.html')
  if (!existsSync(file)) return false
  const html = await readFile(file, 'utf8')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) })
  res.end(html)
  return true
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttp> {
  if (!options.token?.trim()) throw new Error('JARVIS_BACKEND_TOKEN is required; privileged backend APIs cannot run without authentication.')
  const log = options.log ?? nullLogger()
  const ctx = options.context
  const sseClients = new Set<{ id: string; res: ServerResponse }>()
  const sessionId = randomBytes(32).toString('base64url')
  const trustedOrigins = new Set(
    (options.trustedOrigins ?? defaultTrustedOrigins(options.host, options.port))
      .map(normalizeOrigin)
      .filter((origin): origin is string => origin !== undefined),
  )
  const nativeFetch = options.nativeAgent?.fetchImpl ?? fetch
  if (options.nativeAgent) {
    let nativeUrl: URL
    try {
      nativeUrl = new URL(options.nativeAgent.baseUrl)
    } catch {
      throw new Error('Native RPC broker URL must be a loopback HTTP URL.')
    }
    if (
      nativeUrl.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(nativeUrl.hostname.toLowerCase()) ||
      !options.nativeAgent.token.trim()
    ) {
      throw new Error('Native RPC broker requires a loopback HTTP agent and a non-empty server-side bearer token.')
    }
  }

  // Phone pairing trust + outbound command queue. Created in-memory when the
  // caller (tests) does not provide persisted instances; the backend wires
  // persistent ones in.
  const pairing = ctx.pairing ?? new PhoneTrust({ now: ctx.now })
  const deviceCommands = ctx.deviceCommands ?? new PhoneCommandQueue({ now: ctx.now })

  // One self-contained AI Provider Router per server. When JARVIS_AI_BASE_URL is
  // set it seeds the legacy single-upstream provider; otherwise the router reads
  // the provider-router env (JARVIS_AI_PRIMARY_PROVIDER / keys / locales) plus
  // the historical GEMINI_API_KEY default. Keys stay server-side.
  const aiRouter: AiRouter = createAiProviderRouter({
    legacy: options.ai?.baseUrl
      ? { baseUrl: options.ai.baseUrl, key: options.ai.key ?? '', timeoutMs: options.ai.timeoutMs }
      : undefined,
  })

  const server: Server = createServer(async (req, res) => {
    res.on('error', () => undefined)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    const rawOrigin = req.headers.origin
    const origin = typeof rawOrigin === 'string' ? normalizeOrigin(rawOrigin) : undefined

    if (req.method === 'OPTIONS') {
      if (!origin || !trustedOrigins.has(origin)) {
        json(res, 403, { ok: false, error: 'origin_denied' })
        return
      }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Jarvis-Provider',
        'Access-Control-Expose-Headers': 'x-jarvis-provider, x-jarvis-provider-model',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      })
      res.end()
      return
    }

    if (rawOrigin !== undefined) {
      if (!origin || !trustedOrigins.has(origin)) {
        json(res, 403, { ok: false, error: 'origin_denied' })
        return
      }
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Access-Control-Expose-Headers', 'x-jarvis-provider, x-jarvis-provider-model')
      res.setHeader('Vary', 'Origin')
    }

    try {
      /* ------------------------------- browser session + auth fence --------------- */
      if (req.method === 'GET' && pathname === '/api/session') {
        // SEC-05: Strict origin & caller trust enforcement for session issuance
        if (rawOrigin !== undefined) {
          if (!origin || !trustedOrigins.has(origin)) {
            json(res, 403, { ok: false, error: 'origin_denied' })
            return
          }
        } else {
          // No Origin header: verify local loopback trust or require authentication
          const remoteIp = req.socket.remoteAddress
          const isLoopback =
            remoteIp === '127.0.0.1' ||
            remoteIp === '::1' ||
            remoteIp === '::ffff:127.0.0.1' ||
            remoteIp === 'localhost'

          if (!isLoopback && !isAuthorized(options.token, req)) {
            json(res, 403, { ok: false, error: 'remote_session_issuance_forbidden' })
            return
          }

          // Refuse cross-site fetches
          const fetchSite = req.headers['sec-fetch-site']
          if (fetchSite === 'cross-site') {
            json(res, 403, { ok: false, error: 'cross_site_session_forbidden' })
            return
          }

          const referer = req.headers.referer
          if (typeof referer === 'string' && referer.trim()) {
            try {
              const refOrigin = new URL(referer).origin
              if (!trustedOrigins.has(refOrigin)) {
                json(res, 403, { ok: false, error: 'untrusted_referer' })
                return
              }
            } catch {
              json(res, 403, { ok: false, error: 'malformed_referer' })
              return
            }
          }
        }

        setSessionCookie(res, req, sessionId)
        json(res, 200, { ok: true })
        return
      }

      const protectedRoute = pathname.startsWith('/api/') || pathname === '/events'
      if (protectedRoute && !(req.method === 'GET' && pathname === '/api/session')) {
        const hasSession = sameSecret(cookieValue(req, SESSION_COOKIE), sessionId)
        if (!hasSession && !isAuthorized(options.token, req)) {
          json(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
      }

      /* -------------------------- AI Provider Router (server-side keys) ----- */
      // The browser can never hold the AI key, so `/api/ai/*` routes through
      // the provider router, which selects the primary provider, fails over to
      // explicitly configured fallbacks on retryable failures, and translates
      // Claude to/from the OpenAI-Compatible envelope the client speaks. Only
      // two allow-listed subpaths exist (chat + embeddings). The router passes
      // upstream status/body through so the client reports failures honestly,
      // and NEVER logs the body or any key.
      if (pathname === '/api/ai' || pathname.startsWith('/api/ai/')) {
        const subpath: AiProxySubpath | '' = pathname === '/api/ai' ? '' : (`/${pathname.slice('/api/ai/'.length)}` as AiProxySubpath | '')

        if (subpath === '/health') {
          const result = await aiRouter.getHealth()
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(result))
          return
        }

        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method_not_allowed' })
          return
        }

        if (!(AI_PROXY_SUBPATHS as readonly string[]).includes(subpath)) {
          json(res, 404, { ok: false, error: 'not_found' })
          return
        }

        let body: Buffer
        try {
          body = await readRawBody(req)
        } catch {
          json(res, 413, { ok: false, error: 'body_too_large' })
          return
        }

        try {
          const route = await aiRouter.route({
            subpath: subpath as '/chat/completions' | '/embeddings',
            body,
            pinned: typeof req.headers['x-jarvis-provider'] === 'string' ? req.headers['x-jarvis-provider'] : null,
          })
          if (route.errorCode === 'ai_not_configured') {
            json(res, 503, { ok: false, error: 'ai_not_configured' })
            return
          }
          if (route.errorCode === 'ai_upstream_unreachable') {
            json(res, 502, { ok: false, error: 'ai_upstream_unreachable' })
            return
          }
          if (route.errorCode === 'ai_upstream_timeout') {
            json(res, 504, { ok: false, error: 'ai_upstream_timeout' })
            return
          }
          if (route.errorCode === 'unsupported_capability' || route.errorCode === 'provider_not_configured') {
            json(res, 503, { ok: false, error: route.errorCode, message: route.errorMessage })
            return
          }
          if (route.errorCode === 'invalid_body') {
            json(res, 400, { ok: false, error: 'invalid_body' })
            return
          }
          // Additive, key-free provider transparency headers always travel back.
          appendAiRouteHeaders(res, route)
          res.writeHead(route.status, { 'content-type': route.contentType })
          res.end(route.body)
          return
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            json(res, 504, { ok: false, error: 'ai_upstream_timeout' })
            return
          }
          json(res, 502, { ok: false, error: 'ai_upstream_unreachable' })
          return
        }
      }

      /* ------------------------------- native RPC broker --------------- */
      if (req.method === 'POST' && pathname === '/api/native/rpc') {
        if (!options.nativeAgent) {
          json(res, 503, { ok: false, error: 'native_unavailable' })
          return
        }
        let body: Record<string, unknown>
        try {
          const parsed = asRecord(await readJsonBody(req))
          const id = parsed.id
          const method = parsed.method
          const params = parsed.params
          if (
            parsed.jsonrpc !== '2.0' ||
            !(typeof id === 'string' || typeof id === 'number' || id === null) ||
            typeof method !== 'string' ||
            !(NATIVE_RPC_METHODS as readonly string[]).includes(method) ||
            (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params)))
          ) {
            json(res, 400, { jsonrpc: '2.0', id: id ?? null, error: { code: 'unsupported', message: 'Invalid or non-allow-listed native RPC request.' } })
            return
          }
          body = parsed
        } catch {
          json(res, 400, { jsonrpc: '2.0', id: null, error: { code: 'malformed', message: 'Invalid native RPC request body.' } })
          return
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), options.nativeAgent.timeoutMs ?? 30_000)
        try {
          const upstream = await nativeFetch(`${options.nativeAgent.baseUrl.replace(/\/+$/, '')}/`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${options.nativeAgent.token}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
            redirect: 'error',
          })
          const responseBody = await upstream.arrayBuffer()
          res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
          res.end(Buffer.from(responseBody))
        } catch (error) {
          const timedOut = error instanceof Error && error.name === 'AbortError'
          json(res, timedOut ? 504 : 502, {
            jsonrpc: '2.0',
            id: body.id ?? null,
            error: {
              code: timedOut ? 'timeout' : 'native_unavailable',
              message: timedOut ? 'The native agent did not answer in time.' : 'The native agent is not reachable.',
            },
          })
        } finally {
          clearTimeout(timeout)
        }
        return
      }

      /* ------------------------------- health --------------- */
      if (req.method === 'GET' && pathname === '/health') {
        const health = ctx.health()
        json(res, 200, {
          name: health.name,
          version: health.version,
          protocol: health.protocol,
          status: health.status,
        })
        return
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        json(res, 200, ctx.health())
        return
      }

      /* ------------------------------- SSE hub --------------- */
      if (req.method === 'GET' && pathname === '/events') {
        const clientId = `sse-${Math.random().toString(36).slice(2, 10)}`
        const payload = JSON.stringify(ctx.health())
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(`event: ready\ndata: ${payload}\n\n`)
        const client: SseClient = {
          id: clientId,
          send(event, data) {
            if (res.writableEnded || res.destroyed) return
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          },
        }
        const entry = { id: clientId, res }
        sseClients.add(entry)
        const unsubscribe = ctx.bus.subscribe(client)
        const keepAlive = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n')
        }, 15_000)
        req.on('close', () => {
          clearInterval(keepAlive)
          unsubscribe()
          sseClients.delete(entry)
        })
        return
      }

      /* ------------------------------- device registry --------------- */
      if (req.method === 'GET' && pathname === '/api/device/registry') {
        json(res, 200, { devices: ctx.registry.list(), count: ctx.registry.count() })
        return
      }

      if (req.method === 'GET' && pathname === '/api/device/list') {
        json(res, 200, { devices: ctx.registry.list() })
        return
      }

      if (req.method === 'POST' && pathname === '/api/device/claim') {
        const body = asRecord(await readJsonBody(req))
        const deviceId = typeof body.device === 'string' ? body.device.trim().slice(0, 80) : (typeof body.id === 'string' ? body.id.trim().slice(0, 80) : '')
        if (!deviceId) {
          json(res, 400, { ok: false, error: 'device (canonical trusted id) is required' })
          return
        }
        const meta = asRecord(body.meta ?? {})
        const claimed = ctx.registry.register({
          id: deviceId,
          name: typeof meta.name === 'string' ? meta.name.slice(0, 80) : undefined,
          connection: typeof meta.connection === 'string' ? meta.connection.slice(0, 40) : undefined,
          version: typeof meta.version === 'string' ? meta.version.slice(0, 40) : undefined,
          battery: typeof meta.battery === 'number' && Number.isFinite(meta.battery) ? Math.min(100, Math.max(0, meta.battery)) : undefined,
          charging: typeof meta.charging === 'boolean' ? meta.charging : undefined,
          network: typeof meta.network === 'string' ? meta.network.slice(0, 40) : undefined,
          activity: typeof meta.activity === 'string' ? meta.activity.slice(0, 80) : undefined,
          capabilities: stringArray(meta.capabilities),
          permissions: stringArray(meta.permissions),
        })
        if (!claimed) {
          json(res, 403, {
            ok: false,
            error: 'untrusted_device',
            reason: `"${deviceId}" is not one of the trusted JARVIS devices. Unknown devices are never added to the registry — only the four trusted devices (victus-5050, dell-laptop, s26-ultra, s23-fe) can pair.`,
          })
          return
        }
        ctx.bus.publish({ type: 'device', at: ctx.now(), data: { event: 'claimed', device: claimed } })
        json(res, 200, { ok: true, device: claimed })
        return
      }

      if (req.method === 'POST' && pathname === '/api/device/heartbeat') {
        const body = asRecord(await readJsonBody(req))
        const id = typeof body.id === 'string' ? body.id.trim().slice(0, 80) : ''
        const meta = asRecord(body.meta ?? {})
        const ok = id
          ? ctx.registry.heartbeat(id, {
              version: typeof meta.version === 'string' ? meta.version.slice(0, 40) : undefined,
              battery: typeof meta.battery === 'number' && Number.isFinite(meta.battery) ? Math.min(100, Math.max(0, meta.battery)) : undefined,
              charging: typeof meta.charging === 'boolean' ? meta.charging : undefined,
              network: typeof meta.network === 'string' ? meta.network.slice(0, 40) : undefined,
              activity: typeof meta.activity === 'string' ? meta.activity.slice(0, 80) : undefined,
              connection: typeof meta.connection === 'string' ? meta.connection.slice(0, 40) : undefined,
              capabilities: stringArray(meta.capabilities),
              permissions: stringArray(meta.permissions),
            })
          : false
        if (ok) ctx.bus.publish({ type: 'device', at: ctx.now(), data: { event: 'heartbeat', device: id } })
        json(res, 200, ok ? { ok: true } : { ok: false, error: 'unknown_device' })
        return
      }

      /* ------------------------------- phone pairing --------------- */
      // Start a phone pairing session. Loopback-only (this server binds
      // 127.0.0.1): the 6-digit code is displayed locally so the person at the
      // laptop can type it into the Android app; it is never exposed over the
      // LAN or over SSE.
      if (req.method === 'POST' && pathname === '/api/device/pair/begin') {
        const body = asRecord(await readJsonBody(req))
        const device = typeof body.device === 'string' && body.device.trim() ? body.device.trim().toLowerCase().slice(0, 80) : ''
        if (!device) {
          json(res, 400, { ok: false, error: 'device is required' })
          return
        }
        const begun = pairing.begin(device)
        if (!begun) {
          json(res, 400, {
            ok: false,
            error: 'not_a_phone_device',
            reason: `"${device}" is not one of the trusted Android devices. Only the trusted phones (s26-ultra, s23-fe) can pair.`,
          })
          return
        }
        // The pairing code itself is a credential: it is returned to the
        // caller (who must type it into the phone) but never written to logs,
        // where the redaction regex (key names only) would not catch it.
        log.info('phone', 'pairing code generated', { device: begun.deviceId, expiresInMs: begun.expiresInMs })
        json(res, 200, {
          ok: true,
          code: begun.code,
          device: begun.deviceId,
          expiresAt: begun.expiresAt,
          expiresInMs: begun.expiresInMs,
          note: 'Type this code into the JARVIS Companion app on the phone. It expires in 10 minutes.',
        })
        return
      }

      /* ------------------------------- phone ping command --------------- */
      if (req.method === 'POST' && pathname === '/api/device/ping') {
        const body = asRecord(await readJsonBody(req))
        const device = typeof body.device === 'string' && body.device.trim() ? body.device.trim().toLowerCase().slice(0, 80) : ''
        if (!device) {
          json(res, 400, { ok: false, error: 'device is required' })
          return
        }
        if (!ctx.registry.isTrusted(device)) {
          json(res, 400, { ok: false, error: 'invalid_target', reason: `"${device}" is not a trusted device id.` })
          return
        }
        const deviceRecord = ctx.registry.get(device)
        const dispatch = deviceCommands.dispatchPing(device, deviceRecord?.online === true)
        if (!dispatch.command) {
          json(res, 429, { ok: false, error: 'ping_queue_full', reason: dispatch.reason })
          return
        }
        json(res, 200, {
          ok: true,
          commandId: dispatch.command.commandId,
          requestId: dispatch.command.requestId,
          delivered: dispatch.delivered,
          device,
          status: dispatch.delivered ? 'queued' : 'offline',
          reason: dispatch.reason,
        })
        return
      }

      if (req.method === 'POST' && pathname === '/api/device/ping/result') {
        const body = asRecord(await readJsonBody(req))
        const device = typeof body.device === 'string' && body.device.trim() ? body.device.trim().toLowerCase().slice(0, 80) : ''
        if (!device) {
          json(res, 400, { ok: false, error: 'device is required' })
          return
        }
        if (!ctx.registry.isTrusted(device)) {
          json(res, 400, { ok: false, error: 'invalid_target', reason: `"${device}" is not a trusted device id.` })
          return
        }
        const requestId = typeof body.requestId === 'string' && body.requestId.trim() ? body.requestId.trim().slice(0, 120) : undefined
        const result = deviceCommands.pingResult(requestId, device)
        if (!result) {
          json(res, 404, { ok: false, error: 'no_ping_found', reason: 'No ping command was found for that device/id.' })
          return
        }
        const deviceRecord = ctx.registry.get(device)
        json(res, 200, {
          ok: true,
          device,
          requestId: result.requestId,
          pending: result.pending,
          acknowledged: result.ackedAt !== undefined,
          ackedAt: result.ackedAt,
          // The phone's concrete result — only ever true when /phone/ack said so.
          result: result.ok ?? null,
          detail: result.detail ?? null,
          deviceOnline: deviceRecord?.online === true,
        })
        return
      }

      /* ------------------------------- calling --------------- */
      // Queue a real telephony action for a paired phone. Nothing is executed
      // here: the phone runs it on its next poll through OS telephony APIs and
      // acks the concrete result. The backend refuses honestly (offline / no
      // capability / permission missing) instead of pretending a call started.
      if (req.method === 'POST' && pathname === '/api/device/call') {
        const body = asRecord(await readJsonBody(req))
        const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : ''
        const spec = CALL_ACTIONS[action]
        if (!spec) {
          json(res, 400, {
            ok: false,
            error: 'invalid_action',
            reason: `action must be one of: ${Object.keys(CALL_ACTIONS).join(', ')}`,
          })
          return
        }
        const rawDevice = typeof body.device === 'string' && body.device.trim() ? body.device.trim().toLowerCase() : ''
        const primaryPhone = trustedDeviceByRole('primary_phone')?.id
        const deviceId = rawDevice || primaryPhone || ''
        if (!deviceId) {
          json(res, 400, { ok: false, error: 'device is required' })
          return
        }
        if (!ctx.registry.isTrusted(deviceId)) {
          json(res, 400, { ok: false, error: 'invalid_target', reason: `"${deviceId}" is not a trusted device id.` })
          return
        }
        const device = ctx.registry.get(deviceId)
        if (!device || device.platform !== 'android') {
          json(res, 400, {
            ok: false,
            error: 'not_a_phone',
            reason: `"${deviceId}" is not a trusted Android companion; calls can only be placed through a phone.`,
          })
          return
        }
        if (!device.online) {
          ctx.bus.publish({
            type: 'call',
            at: ctx.now(),
            data: { deviceId, state: 'DEVICE_OFFLINE', at: ctx.now(), reason: 'device is offline' },
          })
          json(res, 200, {
            ok: false,
            error: 'device_offline',
            state: 'DEVICE_OFFLINE',
            device: deviceId,
            reason: `${device.name} is offline right now, so no call was placed.`,
          })
          return
        }
        const capabilityMissing = !device.capabilities.includes(spec.capability)
        const permissionMissing = spec.permission !== null && !device.permissions.includes(spec.permission)
        if (capabilityMissing || permissionMissing) {
          const state: CallState = permissionMissing ? 'PERMISSION_REQUIRED' : 'NOT_SUPPORTED'
          ctx.bus.publish({ type: 'call', at: ctx.now(), data: { deviceId, state, at: ctx.now() } })
          json(res, 200, {
            ok: false,
            error: permissionMissing ? 'permission_required' : 'not_supported',
            state,
            device: deviceId,
            reason: permissionMissing
              ? `${device.name} has not granted the ${spec.permission} permission, so JARVIS cannot perform this action.`
              : `${device.name} reports no ${spec.capability} capability, so JARVIS cannot perform this action.`,
          })
          return
        }

        let payload: Record<string, unknown> | undefined
        if (action === 'dial') {
          const contactName = typeof body.contact === 'string' ? body.contact.trim().slice(0, 80) : ''
          const rawNumber = typeof body.number === 'string' ? body.number : ''
          const number = rawNumber ? normalizePhoneNumber(rawNumber) : undefined
          if (!contactName && !number) {
            json(res, 400, {
              ok: false,
              error: 'invalid_argument',
              reason: 'A dial action needs a contact name or a valid phone number.',
            })
            return
          }
          if (rawNumber && !number) {
            json(res, 400, { ok: false, error: 'invalid_argument', reason: `"${rawNumber}" is not a valid phone number.` })
            return
          }
          payload = { ...(number ? { number } : {}), ...(contactName ? { contactName } : {}) }
        } else if (action === 'reject') {
          const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 120) : undefined
          if (reason) payload = { reason }
        } else if (action === 'speak') {
          const text = typeof body.text === 'string' ? body.text.trim().slice(0, 400) : ''
          if (!text) {
            json(res, 400, {
              ok: false,
              error: 'invalid_argument',
              reason: 'A speak action needs the text to say on the phone.',
            })
            return
          }
          payload = { text }
        }

        const dispatch = deviceCommands.enqueue({ deviceId, kind: spec.kind, payload, online: device.online })
        if (!dispatch.command) {
          json(res, 429, { ok: false, error: 'call_queue_full', reason: dispatch.reason })
          return
        }
        // Speaking is not a call STATE, so it deliberately publishes no `call`
        // event: the phone's acknowledgement is the authoritative channel, and a
        // synthetic state here would pollute the real observation log.
        if (action !== 'speak') {
          ctx.bus.publish({
            type: 'call',
            at: ctx.now(),
            data: {
              deviceId,
              state: 'CALL_REQUESTED',
              commandId: dispatch.command.commandId,
              contactName: payload?.contactName,
              number: payload?.number,
              at: ctx.now(),
            },
          })
        }
        json(res, 200, {
          ok: true,
          state: 'CALL_REQUESTED',
          action,
          commandId: dispatch.command.commandId,
          requestId: dispatch.command.requestId,
          device: deviceId,
          delivered: dispatch.delivered,
          reason: dispatch.reason,
        })
        return
      }

      if (req.method === 'POST' && pathname === '/api/device/call/result') {
        const body = asRecord(await readJsonBody(req))
        const deviceId = typeof body.device === 'string' && body.device.trim() ? body.device.trim().toLowerCase() : ''
        if (!deviceId) {
          json(res, 400, { ok: false, error: 'device is required' })
          return
        }
        if (!ctx.registry.isTrusted(deviceId)) {
          json(res, 400, { ok: false, error: 'invalid_target', reason: `"${deviceId}" is not a trusted device id.` })
          return
        }
        const commandId = typeof body.commandId === 'string' && body.commandId.trim() ? body.commandId.trim().slice(0, 100) : undefined
        const requestId = typeof body.requestId === 'string' && body.requestId.trim() ? body.requestId.trim().slice(0, 120) : undefined
        const result = deviceCommands.result(
          { commandId, requestId, kind: commandId || requestId ? undefined : 'call.dial' },
          deviceId,
        )
        if (!result) {
          json(res, 404, { ok: false, error: 'no_call_found', reason: 'No call command was found for that device/id.' })
          return
        }
        const device = ctx.registry.get(deviceId)
        json(res, 200, {
          ok: true,
          device: deviceId,
          commandId: result.commandId,
          kind: result.kind,
          requestId: result.requestId,
          pending: result.pending,
          acknowledged: result.ackedAt !== undefined,
          ackedAt: result.ackedAt,
          // The phone's concrete result — only ever true when /phone/ack said so.
          result: result.ok ?? null,
          detail: result.detail ?? null,
          deviceOnline: device?.online === true,
        })
        return
      }

      /* ------------------------------- notify / file --------------- */
      if (req.method === 'POST' && pathname === '/api/device/notify') {
        const body = asRecord(await readJsonBody(req))
        const title = stringSlice(body.title, TITLE_LIMIT)
        const message = stringSlice(body.message, MESSAGE_LIMIT)
        if (!title || !message) {
          json(res, 400, { ok: false, error: 'title and message are required' })
          return
        }
        const rawTarget = typeof body.device === 'string' && body.device.trim() ? body.device.trim().toLowerCase() : 'all'
        if (rawTarget !== 'all' && !ctx.registry.isTrusted(rawTarget)) {
          json(res, 400, { ok: false, error: 'invalid_target', reason: `"${rawTarget}" is not a trusted device id.` })
          return
        }
        const target = rawTarget
        const online = ctx.registry.list().filter((d) => d.online && (target === 'all' || d.id === target))
        if (online.length === 0) {
          const known = target !== 'all' && ctx.registry.get(target)
          json(res, 200, {
            ok: true,
            delivered: false,
            deliveredTo: [],
            reason: known ? 'device is offline' : 'no devices online',
          })
          return
        }
        const deliveredTo: string[] = []
        for (const device of online) {
          deliveredTo.push(device.id)
          ctx.bus.publish({
            type: 'notify',
            at: ctx.now(),
            data: { deviceId: device.id, deviceName: device.name, title, message, at: ctx.now() },
          })
        }
        json(res, 200, { ok: true, delivered: true, deliveredTo })
        return
      }

      /* ------------------------------- open URL on a device --------------- */
      if (req.method === 'POST' && pathname === '/api/device/open-url') {
        const body = asRecord(await readJsonBody(req))
        const deviceId = typeof body.deviceId === 'string' && body.deviceId.trim() ? body.deviceId.trim().toLowerCase() : ''
        const rawUrl = stringSlice(body.url, URL_LIMIT)
        if (!deviceId) {
          json(res, 400, { ok: false, error: 'deviceId is required' })
          return
        }
        if (!ctx.registry.isTrusted(deviceId)) {
          json(res, 400, { ok: false, error: 'invalid_target', reason: `"${deviceId}" is not a trusted device id.` })
          return
        }
        let url: URL
        try {
          url = new URL(rawUrl ?? '')
        } catch {
          json(res, 400, { ok: false, error: 'invalid_url', reason: 'The URL could not be parsed.' })
          return
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          json(res, 400, { ok: false, error: 'invalid_url', reason: 'Only http/https URLs can be opened on a device.' })
          return
        }
        const device = ctx.registry.get(deviceId)
        if (!device?.online) {
          json(res, 200, {
            ok: false,
            error: 'device_offline',
            delivered: false,
            reason: device ? `"${deviceId}" is offline right now, so the URL was not opened on it.` : 'device not found',
          })
          return
        }
        ctx.bus.publish({ type: 'open-url', at: ctx.now(), data: { deviceId, deviceName: device.name, url: url.toString(), at: ctx.now() } })
        json(res, 200, { ok: true, delivered: true, deliveredTo: [deviceId] })
        return
      }

      if (req.method === 'POST' && pathname === '/api/device/file') {
        const body = asRecord(await readJsonBody(req))
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'file.bin'
        const targetDevice = typeof body.device === 'string' && body.device.trim() ? body.device.trim().toLowerCase() : undefined
        if (targetDevice !== undefined && !ctx.registry.isTrusted(targetDevice)) {
          json(res, 400, { ok: false, error: 'invalid_target', reason: `"${targetDevice}" is not a trusted device id.` })
          return
        }
        let bytes: Uint8Array
        if (typeof body.content === 'string') {
          bytes = new Uint8Array(Buffer.from(body.content, 'base64'))
        } else if (body.content instanceof Uint8Array) {
          bytes = body.content
        } else {
          json(res, 400, { ok: false, error: 'content (base64 string) is required' })
          return
        }
        const saved = await ctx.files.save(name, bytes, { deviceId: targetDevice })
        if ('error' in saved) {
          json(res, saved.error === 'too_large' ? 413 : 400, { ok: false, error: saved.error })
          return
        }
        ctx.bus.publish({ type: 'file', at: ctx.now(), data: saved })
        json(res, 200, { ok: true, file: saved })
        return
      }

      if (req.method === 'GET' && pathname === '/api/files') {
        json(res, 200, { files: ctx.files.list() })
        return
      }

      const fileDownload = pathname.match(/^\/api\/files\/([A-Za-z0-9-]+)$/)
      if (req.method === 'GET' && fileDownload) {
        const result = await ctx.files.read(fileDownload[1])
        if (!result) {
          json(res, 404, { ok: false, error: 'not_found' })
          return
        }
        const safeName = result.record.name
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': result.bytes.length,
          'content-disposition': `attachment; filename="${safeName.replaceAll('"', "'")}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
        })
        res.end(result.bytes)
        return
      }

      /* ------------------------------- persistent task orchestrator --------------- */
      if (req.method === 'GET' && pathname === '/api/tasks') {
        if (!ctx.tasks) {
          json(res, 503, { ok: false, error: 'task_service_unavailable' })
          return
        }
        const stateParam = url.searchParams.get('state')
        const filter = stateParam ? { states: stateParam.split(',') as any } : undefined
        const tasks = await ctx.tasks.listTasks(filter)
        json(res, 200, { ok: true, tasks })
        return
      }

      if (req.method === 'POST' && pathname === '/api/tasks') {
        if (!ctx.tasks) {
          json(res, 503, { ok: false, error: 'task_service_unavailable' })
          return
        }
        const body = asRecord(await readJsonBody(req))
        const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : ''
        const objective = typeof body.objective === 'string' ? body.objective.trim().slice(0, 2000) : ''
        const priority = typeof body.priority === 'number' ? body.priority : 50
        const subtasks = Array.isArray(body.subtasks) ? body.subtasks : undefined
        const tags = Array.isArray(body.tags) ? body.tags.map(String) : []
        const projectPath = typeof body.projectPath === 'string' ? body.projectPath.trim().slice(0, 500) : undefined
        const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : undefined
        // CRIT-02 Remediation: Sanitize metadata against server allowlist; reject autoApprove & authorizedScopes
        const metadata = sanitizeClientTaskMetadata(body.metadata)

        if (!objective) {
          json(res, 400, { ok: false, error: 'objective is required' })
          return
        }

        let task
        try {
          task = await ctx.tasks.createTask({
            title: title || objective.slice(0, 80),
            objective,
            priority,
            subtasks,
            tags,
            projectPath,
            idempotencyKey,
            metadata,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const status = message.startsWith('planning_unavailable') ? 503 : 400
          json(res, status, { ok: false, error: message })
          return
        }

        json(res, 201, { ok: true, task })
        return
      }

      const taskMatch = pathname.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)(?:\/([a-z]+))?$/)
      if (taskMatch) {
        if (!ctx.tasks) {
          json(res, 503, { ok: false, error: 'task_service_unavailable' })
          return
        }
        const taskId = taskMatch[1]
        const action = taskMatch[2]

        if (req.method === 'GET' && !action) {
          const task = await ctx.tasks.getTask(taskId)
          if (!task) {
            json(res, 404, { ok: false, error: 'task_not_found' })
            return
          }
          json(res, 200, { ok: true, task })
          return
        }

        if (req.method === 'POST') {
          if (action === 'pause') {
            const ok = await ctx.tasks.pauseTask(taskId)
            json(res, 200, { ok })
            return
          }
          if (action === 'resume') {
            const ok = await ctx.tasks.resumeTask(taskId)
            json(res, 200, { ok })
            return
          }
          if (action === 'cancel') {
            const body = asRecord(await readJsonBody(req).catch(() => ({})))
            const reason = typeof body.reason === 'string' ? body.reason : undefined
            const ok = await ctx.tasks.cancelTask(taskId, reason)
            json(res, 200, { ok })
            return
          }
          if (action === 'approve') {
            const body = asRecord(await readJsonBody(req))
            const approvalId = typeof body.approvalId === 'string' ? body.approvalId : ''
            if (!approvalId) {
              json(res, 400, { ok: false, error: 'approvalId is required' })
              return
            }
            const ok = await ctx.tasks.approveAction(taskId, approvalId)
            json(res, 200, { ok })
            return
          }
          if (action === 'reject') {
            const body = asRecord(await readJsonBody(req))
            const approvalId = typeof body.approvalId === 'string' ? body.approvalId : ''
            const reason = typeof body.reason === 'string' ? body.reason : undefined
            if (!approvalId) {
              json(res, 400, { ok: false, error: 'approvalId is required' })
              return
            }
            const ok = await ctx.tasks.rejectAction(taskId, approvalId, reason)
            json(res, 200, { ok })
            return
          }
          if (action === 'revoke') {
            const body = asRecord(await readJsonBody(req))
            const approvalId = typeof body.approvalId === 'string' ? body.approvalId : ''
            const reason = typeof body.reason === 'string' ? body.reason : undefined
            if (!approvalId) {
              json(res, 400, { ok: false, error: 'approvalId is required' })
              return
            }
            const ok = await (ctx.tasks as any).revokeAction(taskId, approvalId, reason)
            json(res, 200, { ok })
            return
          }
        }
      }

      /* ------------------------------- dev tools execution ------------------ */
      if (req.method === 'POST' && pathname === '/api/dev/execute') {
        const body = asRecord(await readJsonBody(req).catch(() => ({})))
        const action = typeof body.action === 'string' ? body.action : ''
        const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>
        if (!action) {
          json(res, 400, { ok: false, error: 'action_required' })
          return
        }
        const devEngine = ctx.devEngine ?? new DevEngine()
        const result = await devEngine.execute(action, params)
        json(res, 200, result)
        return
      }

      /* ------------------------------- inbound / state / wake --------------- */
      if (req.method === 'POST' && pathname === '/api/inbound') {
        const body = asRecord(await readJsonBody(req))
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 80) : ''
        const text = stringSlice(body.text, TEXT_LIMIT)
        if (!text) {
          json(res, 400, { ok: false, error: 'text is required' })
          return
        }
        const device = ctx.registry.get(deviceId)
        const inbound: InboundMessage = {
          deviceId: device?.id ?? deviceId,
          deviceName: device?.name ?? 'Companion device',
          text,
          at: ctx.now(),
        }
        ctx.bus.publish({ type: 'inbound', at: inbound.at, data: inbound })
        json(res, 200, { ok: true, inbound })
        return
      }

      if (req.method === 'POST' && pathname === '/api/assistant/state') {
        const body = asRecord(await readJsonBody(req))
        const status = typeof body.status === 'string' ? body.status.slice(0, 40) : undefined
        if (status) ctx.assistant.status = status
        if (typeof body.isSpeaking === 'boolean') ctx.assistant.isSpeaking = body.isSpeaking
        if (typeof body.voiceArmed === 'boolean') ctx.assistant.voiceArmed = body.voiceArmed
        if (typeof body.wakeWordEnabled === 'boolean') ctx.assistant.wakeWordEnabled = body.wakeWordEnabled
        if (typeof body.cameraActive === 'boolean') ctx.assistant.cameraActive = body.cameraActive
        ctx.assistant.lastSeenAt = ctx.now()
        ctx.bus.publish({ type: 'assistant', at: ctx.now(), data: { event: 'state', ...ctx.assistant } })
        json(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && pathname === '/api/wake') {
        const body = asRecord(await readJsonBody(req))
        const event = body.event
        const at = ctx.now()
        if (event === 'arm') ctx.wake.armAt = at
        if (event === 'disarm') ctx.wake.disarmAt = at
        if (event === 'wake') ctx.wake.lastWakeAt = at
        ctx.bus.publish({ type: 'wake', at, data: { event, at, wake: ctx.wake } })
        json(res, 200, { ok: true })
        return
      }

      /* ------------------------------- static UI --------------- */
      if (req.method === 'GET' && pathname === '/phone') {
        setSessionCookie(res, req, sessionId)
        if (await servePhone(res, options.publicDir)) return
        json(res, 404, { ok: false, error: 'phone companion page not available' })
        return
      }

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        setSessionCookie(res, req, sessionId)
        if (await serveFile(res, options.staticDir, pathname, pathname === '/' ? 'index.html' : undefined)) return
        const splash = `JARVIS Core ${ctx.version} is running.\nHealth: GET /health / Events: GET /events / Companion device page: GET /phone`
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(splash)
        return
      }

      if (req.method === 'GET') {
        if (await serveFile(res, options.staticDir, pathname)) return
        json(res, 404, { ok: false, error: 'not_found' })
        return
      }

      json(res, 405, { ok: false, error: 'method_not_allowed' })
    } catch (error) {
      if (error instanceof Error && error.message === 'body_too_large') {
        json(res, 413, { ok: false, error: 'body_too_large' })
        return
      }
      log.error('http', 'request failed', { pathname, error: error instanceof Error ? error.message : String(error) })
      json(res, 500, { ok: false, error: 'internal_error' })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  await ctx.files.load()
  log.info('http', 'http server listening', { url: `http://${options.host}:${port}`, health: '/health', events: '/events', phone: '/phone' })

  return {
    url: `http://${hostToString(options.host)}:${port}`,
    port,
    close: async () => {
      for (const entry of sseClients) entry.res.end()
      sseClients.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function hostToString(host: string): string {
  return host === '0.0.0.0' ? '127.0.0.1' : host
}
