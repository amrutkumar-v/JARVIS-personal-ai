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
 *   POST /api/device/notify         — notify 'all' or one trusted device
 *   POST /api/device/open-url       — ask an online trusted device to open a URL
 *   POST /api/device/file           — upload a bounded, optionally targeted file
 *   GET  /api/files|/api/files/:id  — list / download transferred files
 *   POST /api/inbound               — device → laptop text
 *   POST /api/assistant/state       — browser assistant runtime mirror
 *   POST /api/ai/chat/completions   — server-side AI chat proxy (key stays on server)
 *   POST /api/ai/embeddings         — server-side semantic-embedding proxy
 *   POST /api/wake                  — browser wake registry events
 *   GET  /                          — built SPA (when present)
 *   GET  /phone                     — companion device page
 *
 * Security model: JARVIS is a PERSONAL four-device ecosystem. Unknown devices
 * are refused at `/api/device/claim` (never added to the registry), notify
 * only targets canonical trusted ids, and every `/api/*` POST requires the
 * bearer token when one is configured. The assistant engine itself stays
 * browser-hosted (see version.ts); the backend is the durable coordinator.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { Logger } from './log.js'
import { nullLogger } from './log.js'
import type { EventBus, SseClient } from './events.js'
import type { DeviceRegistry } from './registry.js'
import type { FileStore } from './files.js'
import type { NativeStatus } from './native.js'
import type { BackendHealth, InboundMessage, WakeState } from './types.js'
import { AI_PROXY_SUBPATHS, proxyAiRequest, type AiProxyOptions, type AiProxySubpath } from './ai.js'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '0',
}

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
  token?: string
  /** Optional server-side AI proxy configuration (JARVIS_AI_BASE_URL). */
  ai?: AiProxyOptions
  log?: Logger
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
    ...CORS_HEADERS,
  })
  res.end(payload)
}

function corsOnly(res: ServerResponse): void {
  res.writeHead(204, CORS_HEADERS)
  res.end()
}

function isAuthorized(token: string | undefined, req: IncomingMessage): boolean {
  if (!token) return true
  const header = req.headers.authorization ?? ''
  const given = header.trim().startsWith('Bearer ') ? header.trim().slice('Bearer '.length).trim() : header.trim()
  if (!given || given.length !== token.length) return false
  let diff = 0
  for (let i = 0; i < token.length; i += 1) {
    diff |= token.charCodeAt(i) ^ given.charCodeAt(i)
  }
  return diff === 0
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

function stringArray(value: unknown, itemLimit = 64): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .slice(0, MAX_LIST_ITEMS)
    .map((v) => v.trim().slice(0, itemLimit))
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
      ...CORS_HEADERS,
    })
    res.end(body)
    return true
  } catch {
    return false
  }
}

/** Serve /phone with the optional backend token substituted in. */
async function servePhone(res: ServerResponse, publicDir: string | undefined, token: string): Promise<boolean> {
  if (!publicDir) return false
  const file = join(publicDir, 'phone.html')
  if (!existsSync(file)) return false
  let html = await readFile(file, 'utf8')
  html = html.replaceAll('__JARVIS_BACKEND_TOKEN__', JSON.stringify(token))
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), ...CORS_HEADERS })
  res.end(html)
  return true
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttp> {
  const log = options.log ?? nullLogger()
  const ctx = options.context
  const sseClients = new Set<{ id: string; res: ServerResponse }>()

  const server: Server = createServer(async (req, res) => {
    res.on('error', () => undefined)
    if (req.method === 'OPTIONS') {
      corsOnly(res)
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    try {
      /* ------------------------------- auth fence --------------- */
      // Every /api/* POST (claim, heartbeat, notify, file, inbound,
      // assistant/state, wake) requires the configured bearer token. JARVIS
      // exposes no unrestricted POST endpoints.
      if (req.method === 'POST' && pathname.startsWith('/api/')) {
        if (!isAuthorized(options.token, req)) {
          json(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
      }

      /* ------------------------------- AI proxy (server-side key) ---------- */
      // The browser cannot hold the AI key, so production routes /api/ai/* to a
      // server-side proxy that injects JARVIS_API_KEY. Only two allow-listed
      // OpenAI-compatible subpaths exist (chat + embeddings); when the proxy is
      // configured the upstream status/body is passed through verbatim so the
      // client reports failures honestly. Never logs the body or the key.
      if (pathname === '/api/ai' || pathname.startsWith('/api/ai/')) {
        const subpath: AiProxySubpath | '' = pathname === '/api/ai' ? '' : (`/${pathname.slice('/api/ai/'.length)}` as AiProxySubpath | '')
        if (subpath === '/health') {
          const aiOpts = options.ai || {
            baseUrl: process.env.GEMINI_API_KEY ? 'https://generativelanguage.googleapis.com/v1beta/openai' : '',
            key: process.env.GEMINI_API_KEY || '',
            timeoutMs: 10000,
          }
          const result = await proxyAiRequest(aiOpts, '/health')
          res.writeHead(result.status, { 'content-type': result.contentType, ...CORS_HEADERS })
          res.end(result.body)
          return
        }

        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method_not_allowed' })
          return
        }

        const effectiveBase = options.ai?.baseUrl || (process.env.GEMINI_API_KEY ? 'https://generativelanguage.googleapis.com/v1beta/openai' : '')
        if (!effectiveBase) {
          json(res, 503, { ok: false, error: 'ai_not_configured' })
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
          const aiOpts = options.ai || {
            baseUrl: effectiveBase,
            key: process.env.GEMINI_API_KEY || '',
            timeoutMs: 45000,
          }
          const result = await proxyAiRequest(aiOpts, subpath as AiProxySubpath, body)
          res.writeHead(result.status, { 'content-type': result.contentType, ...CORS_HEADERS })
          res.end(result.body)
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

      /* ------------------------------- health --------------- */
      if (req.method === 'GET' && pathname === '/health') {
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
          ...CORS_HEADERS,
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
          ...CORS_HEADERS,
        })
        res.end(result.bytes)
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
        if (await servePhone(res, options.publicDir, options.token ?? '')) return
        json(res, 404, { ok: false, error: 'phone companion page not available' })
        return
      }

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        if (await serveFile(res, options.staticDir, pathname, pathname === '/' ? 'index.html' : undefined)) return
        const splash = `JARVIS Core ${ctx.version} is running.\nHealth: GET /health / Events: GET /events / Companion device page: GET /phone`
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...CORS_HEADERS })
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