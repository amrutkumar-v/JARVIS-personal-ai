import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeError } from './errors.js'
import type { NativeError } from './errors.js'
import { normalizeRelPath } from './paths.js'
import {
  APP_ID_PATTERN,
  NATIVE_AGENT_VERSION,
  NATIVE_DEFAULT_HOST,
  NATIVE_DEFAULT_PORT,
  NATIVE_METHODS,
  NATIVE_PROTOCOL,
} from './protocol.js'
import type { NativeFailure, NativeMethod, NativeResponse, NativeSuccess } from './protocol.js'
import { NATIVE_LIMITS } from './limits.js'
import { APP_LIMITS } from './limits.js'
import type { FsBackend } from './backend.js'
import { RealFsBackend } from './backend.js'
import type { ApplicationBackend } from './applications.js'
import { RealAppBackend } from './appBackend.js'
import type { ObservationBackend } from './observation.js'
import { RealObsBackend } from './obsWin32.js'
import { MAX_WINDOW_ID_LENGTH, WINDOW_ID_PATTERN } from './protocol.js'
import {
  coordParam,
  desktopKeyParam,
  hotkeyParams,
  screenCoordParam,
  scrollDeltaParam,
  typeTextParam,
} from './desktop.js'
import type { DesktopInteractionBackend } from './desktop.js'
import { RealDesktopInteractionBackend } from './desktopInput.js'
import type { WebBackend } from './web.js'
import { RealWebBackend, WEB_LIMITS } from './web.js'
import type { ClipboardBackend } from './clipboard.js'
import { RealClipboardBackend } from './clipboardInput.js'
import type { AppCloseBackend } from './appClose.js'
import { RealAppCloseBackend } from './appClose.js'
import type { BrowserBackend } from './browser.js'
import { RealBrowserBackend } from './browserInput.js'

/**
 * Native Windows Agent — JSON-RPC over loopback HTTP (Phase 1.2 + 1.5).
 *
 * - Binds to 127.0.0.1 only (configurable, loopback by default).
 * - Optional bearer token (recommended; constant-time compared).
 * - Only methods in the NATIVE_METHODS allow-list are ever dispatched.
 * - Request bodies are size-capped; every request is time-bounded; every
 *   response echoes the request `id` (correlation).
 * - Logical failures are structured `NativeErrorCode` envelopes — never raw
 *   OS error strings.
 */
export interface AgentOptions {
  /** Resolved ABSOLUTE allowed roots the agent may operate inside. */
  roots: string[]
  /**
   * Curated ABSOLUTE folders that folder-capable applications (File Explorer)
   * may be opened ON, even though they live outside the file-system roots
   * (e.g. the current user's Downloads/Documents/Desktop). File-system
   * operations stay strictly root-bounded; this grant exists ONLY for the
   * "open a folder in Explorer" feature and is never executable text.
   */
  openFolders?: string[]
  host?: string
  port?: number
  /** Bearer token; empty string means no token is required. */
  token?: string
  /**
   * Browser origins allowed to reach the agent. Defaults to loopback
   * origins (http://localhost:*, http://127.0.0.1:*, http://[::1]:*) plus
   * `null` (file:// pages). Requests WITHOUT an Origin header (non-browser
   * clients such as the backend supervisor probe) are always allowed; the
   * gate closes the cross-site drive-by vector where an arbitrary website
   * would otherwise POST to the loopback agent.
   */
  allowedOrigins?: string[]
  requestTimeoutMs?: number
  maxBodyBytes?: number
  backend?: FsBackend
  /** Application backend (Phase 1.3); defaults to the real registry. */
  applications?: ApplicationBackend
  /** Observation backend (Phase 1.4); defaults to the real FFI bridge. */
  observation?: ObservationBackend
  /** Desktop input backend (Phase 1.5); defaults to the real FFI bridge. */
  desktop?: DesktopInteractionBackend
  /** Web backend (Phase 2.9); defaults to the real bounded public-web backend. */
  web?: WebBackend
  /** Clipboard backend (Phase 4.0); defaults to the real Win32 clipboard. */
  clipboard?: ClipboardBackend
  /** App-close backend (Phase 4.0); defaults to the real process termination. */
  appClose?: AppCloseBackend
  /** Browser backend (Phase 4.0); defaults to the real Playwright browser. */
  browser?: BrowserBackend
  log?: (line: string) => void
}

export interface RunningAgent {
  server: Server
  url: string
  baseUrl: string
  port: number
  close(): Promise<void>
}

const CORS_METHODS = 'POST, OPTIONS'

/** Normalized loopback origins that are always allowed by default (http only;
 * the loopback IIS/http.sys https boundary is not granted by default). */
const LOCAL_ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i
const IPV6_LOOPBACK_ORIGIN_RE = /^http:\/\/(?:\[::1\]|::1)(?::\d+)?$/i

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '').toLowerCase()
}

/** Is a browser `Origin` header allowed to reach the agent? */
export function isOriginAllowed(origin: string | undefined, explicit: readonly string[] | undefined): boolean {
  if (origin === undefined) return true
  const normalized = normalizeOrigin(origin)
  if (normalized === 'null') return true
  if (explicit !== undefined && explicit.length > 0) {
    const list = explicit.map(normalizeOrigin)
    if (list.includes('*')) return true
    if (list.includes(normalized)) return true
    return false
  }
  return LOCAL_ORIGIN_RE.test(normalized) || IPV6_LOOPBACK_ORIGIN_RE.test(normalized)
}

function envelope(id: string | number | null, payload: Omit<NativeSuccess, 'jsonrpc' | 'id'> | Omit<NativeFailure, 'jsonrpc' | 'id'>): NativeResponse {
  if ('error' in payload) {
    return { jsonrpc: '2.0', id: id === null ? null : id, error: payload.error } as NativeFailure
  }
  return { jsonrpc: '2.0', id: id === null ? null : id, result: payload.result } as NativeSuccess
}

function failure(id: string | number | null, code: NativeFailure['error']['code'], message: string, path?: string): NativeFailure {
  return {
    jsonrpc: '2.0',
    id: id === null ? null : id,
    error: { code, message, ...(path !== undefined ? { data: { path } } : {}) },
  }
}

function isBearerToken(expected: string, header: string | undefined): boolean {
  if (!expected) return true
  const given = header?.trim().startsWith('Bearer ') ? header.trim().slice('Bearer '.length).trim() : (header?.trim() ?? '')
  if (!given) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        // Reject once but keep draining the rest of the body so the client
        // still receives the structured `too_large` response.
        if (!rejected) {
          rejected = true
          reject(nativeError('too_large', 'Request body exceeds the size limit.'))
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(nativeError('timeout', 'The agent request timed out.')), ms)
    timer.unref()
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

function pickRoot(roots: string[], raw: unknown): string {
  // Missing/absent `root` selects the primary allowed root; an explicit index
  // must reference one of the granted roots — anything else is an escape.
  const index = raw === undefined || raw === null ? 0 : Number(raw)
  if (!Number.isInteger(index) || index < 0 || index >= roots.length) {
    throw nativeError('outside_allowed_root', 'Requested root is not in the allowed-root list.')
  }
  return roots[index]
}

function strParam(params: Record<string, unknown> | undefined, key: string): string {
  const value = params?.[key]
  if (typeof value !== 'string') {
    throw nativeError('malformed', `Missing or invalid "${key}" parameter.`)
  }
  return value
}

/**
 * Defense in depth: reject path escapes at the BROKER before any backend sees
 * them, so protocol behavior is identical regardless of backend. This runs on
 * every `path`, `source` and `destination` string passed to a filesystem call.
 */
function guardPath(raw: unknown, key: string): string {
  const value = strParam({ [key]: raw }, key)
  return normalizeRelPath(value)
}

function guardPaths(params: Record<string, unknown> | undefined): void {
  if (!params) return
  for (const key of ['path', 'source', 'destination', 'startPath']) {
    if (typeof params[key] === 'string') guardPath(params[key], key)
  }
}

function optStr(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key]
  return typeof value === 'string' ? value : undefined
}

function optBool(params: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = params?.[key]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * The ONLY parameter `app.*` accepts: a registered applicationId. It must be
 * a string that matches the id charset and length bound; anything else is
 * rejected as `malformed` before any backend is consulted.
 */
function appIdParam(params: Record<string, unknown> | undefined): string {
  const value = params?.applicationId
  if (typeof value !== 'string') {
    throw nativeError('malformed', 'Missing or invalid "applicationId" parameter.')
  }
  const id = value.trim()
  if (id.length === 0 || id.length > APP_LIMITS.MAX_APP_ID_LENGTH || !APP_ID_PATTERN.test(id)) {
    throw nativeError('malformed', 'Invalid "applicationId".')
  }
  return id
}

/**
 * Optional `folder` argument to `app.launch`. It must be an absolute, bounded
 * Windows path that sits INSIDE one of the allowed roots (case-insensitive
 * containment) or one of the curated open-folders (for Explorer folder-open).
 * Known tokens ({userprofile}/{workspace}/{temp}/{windir}) are expanded first
 * so the web layer never needs to know the real user home. A folder is never
 * executable text — it is passed as a single pre-validated argument to an
 * application that expressly allows folders (File Explorer).
 */
function expandKnownTokens(value: string): string {
  const tokens: Array<readonly [string, () => string]> = [
    ['{userprofile}', () => homedir()],
    ['{home}', () => homedir()],
    ['{temp}', () => tmpdir()],
    ['{workspace}', () => join(tmpdir(), 'jarvis', 'workspace')],
    ['{windir}', () => process.env.windir ?? process.env.SystemRoot ?? 'C:\\Windows'],
  ]
  let out = value
  for (const [token, resolve] of tokens) {
    if (out.includes(token)) out = out.split(token).join(resolve())
  }
  return out
}

function folderParam(params: Record<string, unknown> | undefined, roots: string[], openFolders: string[]): string | undefined {
  const raw = params?.folder
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw nativeError('malformed', 'Invalid "folder" parameter.')
  }
  const folder = expandKnownTokens(raw.trim())
  if (folder.length === 0 || folder.length > APP_LIMITS.MAX_FOLDER_ARG_LENGTH || !/^[A-Za-z]:[\\/]/.test(folder)) {
    throw nativeError('malformed', 'Invalid "folder": must be a bounded absolute Windows path.')
  }
  const normalized = folder.replace(/[\\/]+/g, '\\').replace(/\\+$/, '')
  const lower = normalized.toLowerCase()
  const allow = openFolders
    .map((f) => f.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase())
    .concat(roots.map((root) => root.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()))
  const inside = allow.some((a) => lower === a || lower.startsWith(`${a}\\`))
  if (!inside) {
    throw nativeError(
      'outside_allowed_root',
      'The "folder" must be inside a granted root or an allowed open-folder.',
    )
  }
  return normalized
}

/**
 * The ONLY parameter `window.*` accepts: a decimal window id. It must match
 * the opaque WINDOW_ID_PATTERN (1..10 digits, no path, no pointer, no command);
 * anything else is rejected as `malformed` before any backend is consulted.
 */
function windowIdParam(params: Record<string, unknown> | undefined): string {
  const value = params?.windowId
  if (typeof value !== 'string') {
    throw nativeError('malformed', 'Missing or invalid "windowId" parameter.')
  }
  const id = value.trim()
  if (id.length === 0 || id.length > MAX_WINDOW_ID_LENGTH || !WINDOW_ID_PATTERN.test(id)) {
    throw nativeError('malformed', 'Invalid "windowId".')
  }
  return id
}

/* ----------------------------------------------------------- web params */

/**
 * `web.compute` params are validated at the BROKER before any backend runs —
 * a caller can never push an unshaped query, a disallowed url form or an
 * unbounded limit past here. The backend enforces the same bounds again
 * (defense in depth) plus the real SSRF resolution gate.
 */
function webQueryParam(params: Record<string, unknown> | undefined): string {
  const value = strParam(params, 'query')
  const query = value.trim()
  if (query.length === 0 || query.length > WEB_LIMITS.MAX_QUERY_LENGTH) {
    throw nativeError('invalid_argument', 'Invalid "query": must be non-empty and bounded.')
  }
  return query
}

function webUrlParam(params: Record<string, unknown> | undefined): string {
  const value = strParam(params, 'url')
  const url = value.trim()
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw nativeError('invalid_argument', 'Invalid "url".')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw nativeError('invalid_argument', 'Only http:// and https:// URLs are allowed.')
  }
  if (parsed.username || parsed.password) {
    throw nativeError('invalid_argument', 'URLs with embedded credentials are not allowed.')
  }
  return url
}

/** Optional bounded numeric param: absent => undefined (backend default). */
function webBoundedNumber(
  params: Record<string, unknown> | undefined,
  key: string,
  cap: number,
): number | undefined {
  const raw = params?.[key]
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) {
    throw nativeError('invalid_argument', `Invalid "${key}".`)
  }
  return Math.min(Math.floor(n), cap)
}

function createHandler(options: AgentOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const backend: FsBackend = options.backend ?? new RealFsBackend()
  const applications: ApplicationBackend = options.applications ?? new RealAppBackend()
  const observation: ObservationBackend = options.observation ?? new RealObsBackend()
  const desktop: DesktopInteractionBackend = options.desktop ?? new RealDesktopInteractionBackend()
  const web: WebBackend = options.web ?? new RealWebBackend()
  const clipboard: ClipboardBackend = options.clipboard ?? new RealClipboardBackend()
  const appClose: AppCloseBackend = options.appClose ?? new RealAppCloseBackend()
  const browser: BrowserBackend = options.browser ?? new RealBrowserBackend()
  const token = options.token ?? ''
  const allowedOrigins = options.allowedOrigins
  const openFolders = options.openFolders ?? []
  const requestTimeoutMs = options.requestTimeoutMs ?? NATIVE_LIMITS.REQUEST_TIMEOUT_MS
  const maxBodyBytes = options.maxBodyBytes ?? NATIVE_LIMITS.MAX_BODY_BYTES
  const roots = options.roots
  const log = options.log ?? (() => undefined)

  const dispatch = async (method: string, id: string | number, params?: Record<string, unknown>): Promise<NativeResponse> => {
    if (!NATIVE_METHODS.includes(method as NativeMethod)) {
      return failure(id, 'unsupported', `Method "${method}" is not in the agent allow-list.`)
    }

    if (method === 'system.ping') {
      return envelope(id, { result: { pong: true } })
    }

    if (method === 'system.identity') {
      return envelope(id, {
        result: {
          protocol: NATIVE_PROTOCOL,
          version: NATIVE_AGENT_VERSION,
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          connected: true,
          roots,
          tokenRequired: token.length > 0,
        },
      })
    }

    try {
      switch (method) {
        case 'filesystem.list': {
          guardPaths(params)
          const root = pickRoot(roots, params?.root)
          const path = strParam(params, 'path')
          const depth = Number(params?.depth)
          const limit = Number(params?.limit)
          const result = await backend.list(root, path, {
            depth: Number.isFinite(depth) ? depth : 1,
            limit: Number.isFinite(limit) ? limit : NATIVE_LIMITS.MAX_LIST_RESULTS,
          })
          return envelope(id, { result })
        }
        case 'filesystem.search': {
          guardPaths(params)
          const root = pickRoot(roots, params?.root)
          const result = await backend.search(root, {
            query: optStr(params, 'query') ?? '',
            extension: optStr(params, 'extension') ?? '',
            startPath: optStr(params, 'startPath') ?? '',
            maxDepth: Number(params?.maxDepth),
            limit: Number(params?.limit),
          })
          return envelope(id, { result })
        }
        case 'filesystem.stat': {
          guardPaths(params)
          const root = pickRoot(roots, params?.root)
          const result = await backend.stat(root, strParam(params, 'path'))
          return envelope(id, { result })
        }
        case 'filesystem.read': {
          guardPaths(params)
          const root = pickRoot(roots, params?.root)
          const result = await backend.read(root, strParam(params, 'path'), { maxBytes: Number(params?.maxBytes) })
          return envelope(id, { result })
        }
        case 'filesystem.write': {
          guardPaths(params)
          const root = pickRoot(roots, params?.root)
          const result = await backend.write(root, strParam(params, 'path'), strParam(params, 'content'), {
            overwrite: optBool(params, 'overwrite') === true,
            maxChars: Number(params?.maxChars),
          })
          return envelope(id, { result })
        }
        case 'filesystem.mkdir': {
          guardPaths(params)
          const root = pickRoot(roots, params?.root)
          const result = await backend.mkdir(root, strParam(params, 'path'))
          return envelope(id, { result })
        }
        case 'filesystem.copy': {
          guardPaths(params)
          const root = pickRoot(roots, params?.root)
          await backend.copy(root, strParam(params, 'source'), strParam(params, 'destination'), {
            overwrite: optBool(params, 'overwrite') === true,
            maxBytes: Number(params?.maxBytes),
          })
          return envelope(id, { result: { ok: true } })
        }
        case 'filesystem.move': {
          guardPaths(params)
          const root = pickRoot(roots, params?.root)
          await backend.move(root, strParam(params, 'source'), strParam(params, 'destination'), {
            overwrite: optBool(params, 'overwrite') === true,
            maxBytes: Number(params?.maxBytes),
          })
          return envelope(id, { result: { ok: true } })
        }
        case 'filesystem.rename': {
          guardPaths(params)
          const root = pickRoot(roots, params?.root)
          const result = await backend.rename(root, strParam(params, 'path'), strParam(params, 'newName'))
          return envelope(id, { result })
        }
        case 'filesystem.delete': {
          guardPaths(params)
          const root = pickRoot(roots, params?.root)
          await backend.delete(root, strParam(params, 'path'), {
            recursive: optBool(params, 'recursive') === true,
          })
          return envelope(id, { result: { ok: true } })
        }
        case 'app.list': {
          const result = await applications.list()
          return envelope(id, { result: { applications: result } })
        }
        case 'app.refresh': {
          const result = await applications.refresh()
          return envelope(id, { result })
        }
        case 'app.status': {
          const result = await applications.status(appIdParam(params))
          return envelope(id, { result })
        }
        case 'app.launch': {
          const folder = folderParam(params, roots, openFolders)
          const result = await applications.launch(appIdParam(params), folder ? { folder } : undefined)
          return envelope(id, { result })
        }
        case 'window.list': {
          const windows = await observation.listWindows()
          return envelope(id, { result: { windows } })
        }
        case 'window.status': {
          const result = await observation.getWindowStatus(windowIdParam(params))
          return envelope(id, { result })
        }
        case 'desktop.screenshot': {
          const result = await observation.captureScreenshot()
          return envelope(id, { result })
        }
        case 'desktop.capabilities': {
          const result = await desktop.capabilities()
          return envelope(id, { result })
        }
        case 'desktop.cursor': {
          const result = await desktop.cursor()
          return envelope(id, { result })
        }
        case 'desktop.move': {
          const result = await desktop.moveMouse(screenCoordParam(params?.x, 'x'), screenCoordParam(params?.y, 'y'))
          return envelope(id, { result })
        }
        case 'desktop.click': {
          const result = await desktop.click(windowIdParam(params), coordParam(params?.x, 'x'), coordParam(params?.y, 'y'))
          return envelope(id, { result })
        }
        case 'desktop.doubleClick': {
          const result = await desktop.doubleClick(windowIdParam(params), coordParam(params?.x, 'x'), coordParam(params?.y, 'y'))
          return envelope(id, { result })
        }
        case 'desktop.rightClick': {
          const result = await desktop.rightClick(windowIdParam(params), coordParam(params?.x, 'x'), coordParam(params?.y, 'y'))
          return envelope(id, { result })
        }
        case 'desktop.scroll': {
          const result = await desktop.scroll(
            windowIdParam(params),
            coordParam(params?.x, 'x'),
            coordParam(params?.y, 'y'),
            scrollDeltaParam(params?.delta),
          )
          return envelope(id, { result })
        }
        case 'desktop.keyPress': {
          const result = await desktop.keyPress(desktopKeyParam(params?.key))
          return envelope(id, { result })
        }
        case 'desktop.hotkey': {
          const result = await desktop.hotkey(hotkeyParams(params?.keys))
          return envelope(id, { result })
        }
        case 'desktop.type': {
          const result = await desktop.typeText(typeTextParam(params?.text))
          return envelope(id, { result })
        }
        case 'window.focus': {
          const result = await desktop.focusWindow(windowIdParam(params))
          return envelope(id, { result })
        }
        case 'web.capabilities': {
          return envelope(id, { result: web.capabilities() })
        }
        case 'web.search': {
          const result = await web.search(webQueryParam(params), {
            maxResults: webBoundedNumber(params, 'maxResults', WEB_LIMITS.MAX_SEARCH_RESULTS),
            timeoutMs: webBoundedNumber(params, 'timeoutMs', WEB_LIMITS.MAX_REQUEST_TIMEOUT_MS),
          })
          return envelope(id, { result })
        }
        case 'web.fetch': {
          const result = await web.fetchDocument(webUrlParam(params), {
            maxBytes: webBoundedNumber(params, 'maxBytes', WEB_LIMITS.MAX_FETCH_MAX_BYTES),
            timeoutMs: webBoundedNumber(params, 'timeoutMs', WEB_LIMITS.MAX_REQUEST_TIMEOUT_MS),
          })
          return envelope(id, { result })
        }
        case 'web.download': {
          const result = await web.download(webUrlParam(params), {
            maxBytes: webBoundedNumber(params, 'maxBytes', WEB_LIMITS.MAX_DOWNLOAD_MAX_BYTES),
            timeoutMs: webBoundedNumber(params, 'timeoutMs', WEB_LIMITS.MAX_REQUEST_TIMEOUT_MS),
          })
          return envelope(id, { result })
        }
        /* ----------------------------------------------------------- clipboard */
        case 'clipboard.read': {
          const result = await clipboard.read()
          return envelope(id, { result })
        }
        case 'clipboard.write': {
          const text = strParam(params, 'text')
          const result = await clipboard.write(text)
          return envelope(id, { result })
        }
        /* ----------------------------------------------------------- app close */
        case 'app.close': {
          const applicationId = optStr(params, 'applicationId')
          const explicitProcessName = optStr(params, 'processName')
          // Prefer resolving a registered applicationId to its validated
          // process-image name; the literal `processName` form is kept for
          // backward compatibility but never preferred over the registry.
          const resolved = applicationId ? applications.resolveProcessName(applicationId) : ''
          const processName = resolved || explicitProcessName
          if (!processName) {
            throw nativeError('invalid_argument', 'app.close requires "applicationId" of a registered application.')
          }
          const result = await appClose.close(processName, applicationId || explicitProcessName)
          return envelope(id, { result })
        }
        /* ------------------------------------------------------------ browser */
        case 'browser.open': {
          const url = optStr(params, 'url')
          const result = await browser.open(url)
          return envelope(id, { result })
        }
        case 'browser.navigate': {
          const url = webUrlParam(params)
          const result = await browser.navigate(url)
          return envelope(id, { result })
        }
        case 'browser.back': {
          const result = await browser.back()
          return envelope(id, { result })
        }
        case 'browser.forward': {
          const result = await browser.forward()
          return envelope(id, { result })
        }
        case 'browser.refresh': {
          const result = await browser.refresh()
          return envelope(id, { result })
        }
        case 'browser.click': {
          const selector = strParam(params, 'selector')
          if (selector.length > 500) throw nativeError('invalid_argument', 'Selector too long.')
          const result = await browser.click(selector)
          return envelope(id, { result })
        }
        case 'browser.type': {
          const selector = strParam(params, 'selector')
          const text = strParam(params, 'text')
          if (selector.length > 500) throw nativeError('invalid_argument', 'Selector too long.')
          if (text.length > 10_000) throw nativeError('too_large', 'Text too long.')
          const result = await browser.type(selector, text)
          return envelope(id, { result })
        }
        case 'browser.readPage': {
          const result = await browser.readPage()
          return envelope(id, { result })
        }
        case 'browser.search': {
          const query = webQueryParam(params)
          const result = await browser.search(query)
          return envelope(id, { result })
        }
        case 'browser.screenshot': {
          const result = await browser.screenshot()
          return envelope(id, { result })
        }
        case 'browser.close': {
          const result = await browser.close()
          return envelope(id, { result })
        }
        default:
          return failure(id, 'unsupported', `Method "${method}" is not supported.`)
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'NativeError') {
        const n = error as NativeError
        return failure(id, n.code, n.message, n.wirePath)
      }
      log(`[agent] ${method} failed: ${error instanceof Error ? error.message : String(error)}`)
      return failure(id, 'io_error', 'The operation failed inside the native agent.')
    }
  }

  return (req, res) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    const setCors = (): boolean => {
      if (!isOriginAllowed(origin, allowedOrigins)) {
        // Never issue a permissive CORS header for a blocked origin — the
        // browser must not learn anything about the agent's presence.
        return false
      }
      res.setHeader('Access-Control-Allow-Origin', origin ?? '*')
      res.setHeader('Access-Control-Allow-Methods', CORS_METHODS)
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      return true
    }

    if (!setCors()) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify(failure(null, 'origin_denied', 'Request origin is not allowed to reach the native agent.')))
      return
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(JSON.stringify(failure(null, 'malformed', 'Only POST requests are accepted.')))
      return
    }

    res.setHeader('content-type', 'application/json')
    if (!isBearerToken(token, req.headers.authorization)) {
      const body = JSON.stringify(failure(null, 'permission_denied', 'Unauthorized: missing or invalid native agent token.'))
      res.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
      return
    }

    void readBody(req, maxBodyBytes)
      .then((body) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(body.length === 0 ? '{}' : body.toString('utf8'))
        } catch {
          res.end(JSON.stringify(failure(null, 'malformed', 'Request body is not valid JSON.')))
          return
        }
        const id = envelopeId(parsed)
        const raw =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as { jsonrpc?: unknown; method?: unknown; params?: Record<string, unknown> })
            : {}
        if (raw.jsonrpc !== '2.0') {
          res.end(JSON.stringify(failure(id, 'malformed', 'Envelope must declare "jsonrpc": "2.0".')))
          return
        }
        if (typeof raw.method !== 'string') {
          res.end(JSON.stringify(failure(id, 'malformed', 'Envelope is missing a method.')))
          return
        }
        const methodId: string | number = id === null ? 0 : id
        return withTimeout(dispatch(raw.method, methodId, raw.params), requestTimeoutMs).then((response) => {
          res.end(JSON.stringify(response))
        })
      })
      .catch((error) => {
        const n = isStructured(error) ? (error as NativeError) : undefined
        res.end(
          JSON.stringify(
            failure(null, n ? n.code : 'malformed', n ? n.message : 'Could not read the request body.'),
          ),
        )
      })
  }
}

function isStructured(error: unknown): boolean {
  return error instanceof Error && error.name === 'NativeError'
}

function envelopeId(parsed: unknown): string | number | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const id = (parsed as { id?: unknown }).id
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

export async function startAgent(options: AgentOptions): Promise<RunningAgent> {
  const token = options.token ?? ''
  const port = options.port ?? NATIVE_DEFAULT_PORT
  const host = options.host ?? NATIVE_DEFAULT_HOST
  const server = createServer(createHandler({ ...options, token, port, host }))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  const baseUrl = `http://${host}:${actualPort}`
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => resolve())
    })
  return { server, url: baseUrl, baseUrl, port: actualPort, close }
}