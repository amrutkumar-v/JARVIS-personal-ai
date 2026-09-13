import { FileSystemError, fsError } from '../filesystem'
import type { NativePlatformStatus } from '../filesystem'
import type { NativeIdentity, NativeResponse } from '../../native/src/protocol'
import type { NativeErrorCode } from '../../native/src/protocol'

/**
 * Web-side RPC client for the native Windows agent (Phase 1.2/1.3).
 *
 * One shared transport + connectivity probe is used by BOTH the filesystem
 * bridge and the application bridge: HTTP JSON-RPC to the local agent, bearer
 * token auth, per-request timeout via AbortController, structured error
 * mapping into `FileSystemError` kinds, and an honest known-state that both
 * providers expose through their capability reports. Nothing here ever reaches
 * beyond the agent's `NATIVE_METHODS` allow-list.
 */
export interface NativeBridgeOptions {
  /** Base URL of the local native agent (default http://127.0.0.1:8765). */
  baseUrl?: string
  /** Bearer token the agent requires (empty = none configured). */
  token?: string
  /** Wall time a single operation may take (ms). */
  requestTimeoutMs?: number
  /** Wall time for the connectivity probe (ms). */
  probeTimeoutMs?: number
  /** Injectable fetch (tests/alt environments). */
  fetchImpl?: typeof fetch
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8765'

/** Map a structured native error code onto the web FileSystemError kind set. */
export function mapNativeCode(code: NativeErrorCode, message: string, path: string | undefined): FileSystemError {
  switch (code) {
    case 'outside_allowed_root':
      return fsError('permission_denied', message, path)
    case 'permission_denied':
      return fsError('permission_denied', message, path)
    case 'not_found':
      return fsError('not_found', message, path)
    case 'ambiguous':
      return fsError('unavailable', `Multiple matching applications found — be more specific: ${message}`, path)
    case 'already_exists':
      return fsError('exists', message, path)
    case 'invalid_path':
      return fsError('invalid_path', message, path)
    case 'unsupported':
      return fsError('unsupported', message, path)
    case 'window_not_found':
      return fsError('not_found', message, path)
    case 'window_not_interactable':
      return fsError('unavailable', message, path)
    case 'coordinate_out_of_bounds':
      return fsError('invalid_path', message, path)
    case 'unsupported_key':
      return fsError('unsupported', message, path)
    case 'invalid_argument':
      return fsError('invalid_path', message, path)
    case 'cancelled':
      return fsError('unavailable', message, path)
    case 'too_large':
      return fsError('too_large', message, path)
    case 'timeout':
      return fsError('timeout', message, path)
    case 'malformed':
      return fsError('unavailable', `The native agent rejected the request: ${message}`, path)
    case 'native_unavailable':
      return fsError('unavailable', message, path)
    case 'verification_failed':
    case 'io_error':
      return fsError('io', message, path)
    default:
      return fsError('io', message, path)
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { name?: unknown }).name === 'AbortError' || (error as { name?: unknown }).name === 'TimeoutError')
  )
}

export class NativeAgentRpc {
  private readonly baseUrl: string
  private readonly token: string
  private readonly requestTimeoutMs: number
  private readonly probeTimeoutMs: number
  private readonly fetchImpl: typeof fetch
  private idCounter = 0
  private known: NativePlatformStatus = { connected: false, reason: 'The native agent has not been probed yet.' }

  constructor(options: NativeBridgeOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.token = options.token ?? ''
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1500
    this.fetchImpl =
      options.fetchImpl ??
      (typeof fetch === 'function' ? fetch.bind(globalThis) : async () => { throw new Error('fetch unavailable') })
  }

  /** Current honest connectivity state (immutable snapshot). */
  get knownStatus(): NativePlatformStatus {
    return { ...this.known }
  }

  /** Bounded connectivity probe; records the result and returns it. */
  async probe(): Promise<NativePlatformStatus> {
    try {
      const identity = await this.callRaw<NativeIdentity>('system.identity', {}, this.probeTimeoutMs)
      if (identity.connected !== true) {
        const status: NativePlatformStatus = { connected: false, reason: 'The native agent is not connected.' }
        this.known = status
        return status
      }
      const status: NativePlatformStatus = {
        connected: true,
        platform: identity.platform,
        version: identity.version,
        roots: identity.roots,
      }
      this.known = status
      return status
    } catch (error) {
      const reason =
        error instanceof FileSystemError
          ? error.message
          : 'The native Windows agent is not reachable. Start it with `npm run native:agent`.'
      const status: NativePlatformStatus = { connected: false, reason }
      this.known = status
      return status
    }
  }

  private nextId(): number {
    this.idCounter += 1
    return this.idCounter
  }

  private async callRaw<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.requestTimeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId(), method, params }),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      if (isAbortError(error)) {
        this.known = { connected: false, reason: 'The native agent did not answer in time.' }
        throw fsError('timeout', 'The native agent did not answer in time.')
      }
      this.known = { connected: false, reason: 'The native agent is not reachable.' }
      throw fsError('unavailable', 'The native Windows agent is not reachable. Start it with `npm run native:agent`.')
    } finally {
      clearTimeout(timer)
    }

    let envelope: NativeResponse
    try {
      envelope = (await response.json()) as NativeResponse
    } catch {
      this.known = { connected: false, reason: 'The native agent returned an unreadable response.' }
      throw fsError('unavailable', 'The native agent returned an unreadable response.')
    }

    if ('error' in envelope && envelope.error) {
      const path =
        envelope.error.data && typeof envelope.error.data === 'object' && 'path' in envelope.error.data
          ? String((envelope.error.data as { path?: unknown }).path ?? undefined)
          : undefined
      throw mapNativeCode(envelope.error.code, envelope.error.message, path)
    }
    if (!('result' in envelope)) {
      this.known = { connected: false, reason: 'The native agent returned a malformed response.' }
      throw fsError('unavailable', 'The native agent returned a malformed response.')
    }
    return envelope.result as T
  }

  /** Normal call: a successful round-trip proves connectivity. */
  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const value = await this.callRaw<T>(method, params)
    this.known = { ...this.known, connected: true, reason: undefined }
    return value
  }
}