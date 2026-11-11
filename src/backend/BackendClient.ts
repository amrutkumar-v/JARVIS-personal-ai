/**
 * BackendClient — realtime connection to the JARVIS Core persistent backend
 * (Phase 2.8).
 *
 * Simple honest transport:
 *   - SSE `GET /events` for server→browser named events (ready/notify/file/
 *     inbound/device/assistant/wake) with bounded reconnect handled by the
 *     pure ReconnectController;
 *   - JSON `POST`/`GET` fetch helpers for the JSON endpoints.
 *
 * The client only reports what actually happened: `phase === 'connected'`
 * means a live SSE stream answered with a `ready` frame; anything else surfaces
 * in the UI as a real disconnected state. No fabricated liveness.
 */

import { getBackendConfig, type BackendConfig } from './config'
import { ReconnectController, type ReconnectPhase } from './reconnect'
import { ensureBackendSession } from './session'
import type {
  BackendEventType,
  BackendHealth,
  CallAction,
  CallDispatchResult,
  CallEventData,
  CallResultLookup,
  ClaimMeta,
  DeviceRecord,
  InboundMessage,
  NotifyRequest,
  NotifyResult,
  OutboundFile,
} from './types'
import type { PersistentTask } from '../engine/tasks/types'

export type BackendListener<T = unknown> = (data: T) => void

export interface BackendEventHandlers {
  onReady?: BackendListener<BackendHealth>
  onDisconnected?: BackendListener<void>
  onGaveUp?: BackendListener<void>
  onNotify?: BackendListener<{ deviceId: string; title: string; message: string; at: number }>
  onOpenUrl?: BackendListener<{ deviceId: string; deviceName?: string; url: string; at: number }>
  onFile?: BackendListener<OutboundFile>
  onInbound?: BackendListener<InboundMessage>
  onDevice?: BackendListener<{ event: string; device: DeviceRecord }>
  onWake?: BackendListener<{ event: string; at: number }>
  /** Real telephony call-state observations pushed by the phone. */
  onCall?: BackendListener<CallEventData>
  /** Real-time durable task updates pushed by the task service. */
  onTask?: BackendListener<PersistentTask>
}

export interface BackendClientDeps {
  config?: BackendConfig
  makeEventSource?: (url: string) => EventSourceLike
  fetchImpl?: typeof fetch
}

/** Minimal EventSource surface so tests can inject a deterministic stub. */
export interface EventSourceLike {
  addEventListener(event: string, handler: (event: { data: string }) => void): void
  removeEventListener(event: string, handler: (event: { data: string }) => void): void
  close(): void
  onerror: (() => void) | null
}

const EVENT_NAMES: BackendEventType[] = ['device', 'notify', 'open-url', 'file', 'inbound', 'assistant', 'wake', 'call', 'task']

/** Fallback bound for a single backend HTTP request when none is configured. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

export class BackendClient {
  private readonly config: BackendConfig
  private readonly fetchImpl: typeof fetch
  private readonly makeEventSource: (url: string) => EventSourceLike
  private readonly handlers: BackendEventHandlers
  private readonly reconnect: ReconnectController

  private source: EventSourceLike | null = null
  private started = false
  private disconnected = false
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private healthSnapshot: BackendHealth | null = null
  /** One listener per SSE event name, so the NAME is what routes the frame. */
  private listeners = new Map<string, (event: { data: string }) => void>()
  private readyHandler: ((event: { data: string }) => void) | null = null

  constructor(deps: BackendClientDeps = {}) {
    this.config = deps.config ?? getBackendConfig()
    this.fetchImpl = deps.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : async () => { throw new Error('fetch unavailable') })
    this.makeEventSource = deps.makeEventSource ?? ((url: string) => new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike)
    this.handlers = {}
    this.reconnect = new ReconnectController(
      { maxAttempts: this.config.maxReconnectAttempts, baseMs: this.config.reconnectBaseMs },
      () => undefined,
    )
  }

  get phase(): ReconnectPhase {
    return this.reconnect.phase
  }

  get hasConnected(): boolean {
    return this.phase === 'connected'
  }

  lastHealth(): BackendHealth | null {
    return this.healthSnapshot
  }

  on<T extends keyof BackendEventHandlers>(event: T, handler: NonNullable<BackendEventHandlers[T]>): () => void {
    this.handlers[event] = handler
    return () => {
      if (this.handlers[event] === handler) {
        delete this.handlers[event]
      }
    }
  }

  /* --------------------------------------------------- lifecycle */

  start(): void {
    if (this.started) return
    this.started = true
    this.reconnect.reset()
    this.connect()
  }

  stop(): void {
    this.started = false
    this.disconnected = false
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    this.closeSource()
    this.reconnect.reset()
  }

  private connect(): void {
    if (!this.started) return
    this.closeSource()
    if (typeof window === 'undefined') {
      this.connectWithSession()
      return
    }
    void ensureBackendSession(this.config.baseUrl, this.fetchImpl)
      .then(() => {
        if (this.started) this.connectWithSession()
      })
      .catch(() => {
        if (!this.started) return
        if (!this.disconnected) {
          this.disconnected = true
          this.handlers.onDisconnected?.()
        }
        this.scheduleReconnect()
      })
  }

  private connectWithSession(): void {
    const source = this.makeEventSource(`${this.config.baseUrl}/events`)
    this.source = source
    // The server writes `event: <type>` + `data: <payload>` — the payload is the
    // BARE event body, NOT an envelope. The SSE event NAME is therefore the
    // only reliable type discriminator, so each name gets its own listener.
    for (const name of EVENT_NAMES) {
      const handler = (event: { data: string }): void => this.dispatchMessage(name, event.data)
      this.listeners.set(name, handler)
      source.addEventListener(name, handler)
    }
    this.readyHandler = (event: { data: string }) => {
      try {
        this.healthSnapshot = JSON.parse(event.data) as BackendHealth
      } catch {
        this.healthSnapshot = null
      }
      this.reconnect.markConnected()
      this.disconnected = false
      this.handlers.onReady?.(this.healthSnapshot as BackendHealth)
    }
    source.addEventListener('ready', this.readyHandler)
    source.onerror = (): void => {
      if (!this.started) return
      // Fire onDisconnected ONCE per drop episode (honest "stream is gone")
      // rather than once per reconnect attempt; onReady clears the flag.
      if (!this.disconnected) {
        this.disconnected = true
        this.handlers.onDisconnected?.()
      }
      this.scheduleReconnect()
    }
  }

  private closeSource(): void {
    if (!this.source) return
    for (const [name, handler] of this.listeners) {
      this.source.removeEventListener(name, handler)
    }
    this.listeners.clear()
    if (this.readyHandler) {
      this.source.removeEventListener('ready', this.readyHandler)
    }
    this.source.close()
    this.source = null
    this.readyHandler = null
  }

  private scheduleReconnect(): void {
    if (this.connectTimer) return
    const delay = this.reconnect.nextDelay()
    if (delay < 0) {
      this.handlers.onGaveUp?.()
      return
    }
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      this.connect()
    }, delay)
  }

  /**
   * Route one SSE frame to its handler.
   *
   * `name` is the SSE event name the server wrote (`event: notify`), and
   * `data` is the BARE payload the server wrote next to it. The server never
   * wraps the payload in an envelope, so the name — not a field inside the
   * JSON — decides which handler runs.
   */
  private dispatchMessage(name: string, data: string): void {
    try {
      const payload = JSON.parse(data) as unknown
      switch (name) {
        case 'notify':
          this.handlers.onNotify?.(payload as { deviceId: string; title: string; message: string; at: number })
          break
        case 'open-url':
          this.handlers.onOpenUrl?.(payload as { deviceId: string; deviceName?: string; url: string; at: number })
          break
        case 'file':
          this.handlers.onFile?.(payload as OutboundFile)
          break
        case 'inbound':
          this.handlers.onInbound?.(payload as InboundMessage)
          break
        case 'device':
          this.handlers.onDevice?.(payload as { event: string; device: DeviceRecord })
          break
        case 'wake':
          this.handlers.onWake?.(payload as { event: string; at: number })
          break
        case 'call':
          this.handlers.onCall?.(payload as CallEventData)
          break
        case 'task':
          this.handlers.onTask?.(payload as PersistentTask)
          break
        case 'assistant':
          break
      }
    } catch {
      // A malformed frame is dropped; the stream stays alive.
    }
  }

  /* --------------------------------------------------- fetch helpers */

  /**
   * Every request is BOUNDED.
   *
   * Without a timeout a half-open socket (a wedged backend, a suspended
   * laptop) leaves the promise pending forever: the tool call never resolves,
   * its verification never runs, and the assistant hangs with no error. The
   * abort turns that into an ordinary, reportable failure.
   */
  private requestSignal(): AbortSignal | undefined {
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined
    try {
      return AbortSignal.timeout(timeoutMs)
    } catch {
      return undefined
    }
  }

  private async postJson(
    path: string,
    body: unknown,
  ): Promise<{ status: number; ok: boolean; error?: string; body: Record<string, unknown> }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    try {
      await ensureBackendSession(this.config.baseUrl, this.fetchImpl)
      const res = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        credentials: 'include',
        signal: this.requestSignal(),
      })
      const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>
      return { status: res.status, ok: res.ok, error: typeof parsed.error === 'string' ? parsed.error : undefined, body: parsed }
    } catch {
      return { status: 0, ok: false, error: 'backend unreachable', body: {} }
    }
  }

  /* --------------------------------------------------- endpoints */

  async listDevices(): Promise<DeviceRecord[]> {
    try {
      await ensureBackendSession(this.config.baseUrl, this.fetchImpl)
      const res = await this.fetchImpl(`${this.config.baseUrl}/api/device/registry`, {
        credentials: 'include',
        signal: this.requestSignal(),
      })
      const body = (await res.json().catch(() => ({}))) as { devices?: DeviceRecord[] }
      return body.devices ?? []
    } catch {
      return []
    }
  }

  /** Pair a companion bridge as one of the backend's trusted devices. */
  claimDevice(device: string, meta: ClaimMeta): Promise<{ ok: boolean; device: DeviceRecord | null; error?: string }> {
    return this.postJson('/api/device/claim', { device, meta }).then((res) => {
      const deviceRecord = res.ok ? (res.body.device as DeviceRecord | undefined) : null
      return { ok: res.ok, device: deviceRecord ?? null, error: res.error }
    })
  }

  heartbeatDevice(id: string, meta: ClaimMeta = {}): Promise<{ ok: boolean; error?: string }> {
    return this.postJson('/api/device/heartbeat', { id, meta }).then((res) => ({ ok: res.ok, error: res.error }))
  }

  notify(req: NotifyRequest): Promise<NotifyResult & { ok: boolean; error?: string }> {
    return this.postJson('/api/device/notify', req).then((res) => ({
      ok: res.ok,
      delivered: res.ok === true && res.body.delivered === true,
      deliveredTo: Array.isArray(res.body.deliveredTo) ? (res.body.deliveredTo as string[]) : [],
      reason: typeof res.body.reason === 'string' ? res.body.reason : res.error,
      error: res.error,
    }))
  }

  sendFile(name: string, content: string, device?: string): Promise<{ ok: boolean; file?: OutboundFile; error?: string }> {
    const body: Record<string, unknown> = { name, content }
    if (device) body.device = device
    return this.postJson('/api/device/file', body).then((res) => ({
      ok: res.ok,
      file: res.ok ? (res.body.file as OutboundFile) : undefined,
      error: res.error,
    }))
  }

  sendOpenUrl(deviceId: string, url: string): Promise<{ ok: boolean; error?: string; reason?: string }> {
    return this.postJson('/api/device/open-url', { deviceId, url }).then((res) => ({
      ok: res.ok,
      error: res.error,
      reason: typeof res.body.reason === 'string' ? res.body.reason : res.error,
    }))
  }

  async listFiles(): Promise<OutboundFile[]> {
    try {
      await ensureBackendSession(this.config.baseUrl, this.fetchImpl)
      const res = await this.fetchImpl(`${this.config.baseUrl}/api/files`, {
        credentials: 'include',
        signal: this.requestSignal(),
      })
      const body = (await res.json().catch(() => ({}))) as { files?: OutboundFile[] }
      return body.files ?? []
    } catch {
      return []
    }
  }

  sendInbound(deviceId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    return this.postJson('/api/inbound', { deviceId, text }).then((res) => ({ ok: res.ok, error: res.error }))
  }

  mirrorAssistant(mirror: Record<string, unknown>): Promise<{ ok: boolean }> {
    return this.postJson('/api/assistant/state', mirror).then((res) => ({ ok: res.ok }))
  }

  wakeEvent(event: 'arm' | 'disarm' | 'wake'): Promise<{ ok: boolean }> {
    return this.postJson('/api/wake', { event }).then((res) => ({ ok: res.ok }))
  }

  /**
   * Queue a real telephony action for a paired phone. The backend refuses
   * honestly (device_offline / permission_required / not_supported) instead of
   * claiming a call started; `state` always carries the truthful outcome.
   */
  requestCall(input: {
    action: CallAction
    device?: string
    contact?: string
    number?: string
    reason?: string
    /** Text to speak on the phone during a live call (the `speak` action). */
    text?: string
  }): Promise<CallDispatchResult> {
    return this.postJson('/api/device/call', input).then((res) => {
      const state = typeof res.body.state === 'string' ? (res.body.state as CallDispatchResult['state']) : 'FAILED'
      return {
        ok: res.ok === true && res.body.ok !== false,
        state,
        action: input.action,
        commandId: typeof res.body.commandId === 'string' ? res.body.commandId : undefined,
        requestId: typeof res.body.requestId === 'string' ? res.body.requestId : undefined,
        device: typeof res.body.device === 'string' ? res.body.device : input.device,
        delivered: res.body.delivered === true,
        reason: typeof res.body.reason === 'string' ? res.body.reason : undefined,
        error: res.error,
      }
    })
  }

  /** Read the concrete result/ack of a previously queued call command. */
  callResult(input: { device: string; commandId?: string; requestId?: string }): Promise<CallResultLookup> {
    return this.postJson('/api/device/call/result', input).then((res) => ({
      ok: res.ok === true && res.body.ok !== false,
      device: typeof res.body.device === 'string' ? res.body.device : input.device,
      commandId: typeof res.body.commandId === 'string' ? res.body.commandId : input.commandId,
      kind: typeof res.body.kind === 'string' ? res.body.kind : undefined,
      pending: res.body.pending === true,
      acknowledged: res.body.acknowledged === true,
      ackedAt: typeof res.body.ackedAt === 'number' ? res.body.ackedAt : undefined,
      result: typeof res.body.result === 'boolean' ? res.body.result : null,
      detail: typeof res.body.detail === 'string' ? res.body.detail : null,
      deviceOnline: res.body.deviceOnline === true,
      error: res.error,
    }))
  }

  /* --------------------------------------------------- Persistent Task API */

  async getTasks(): Promise<PersistentTask[]> {
    try {
      await ensureBackendSession(this.config.baseUrl, this.fetchImpl)
      const res = await this.fetchImpl(`${this.config.baseUrl}/api/tasks`, {
        credentials: 'include',
        signal: this.requestSignal(),
      })
      const body = (await res.json().catch(() => ({}))) as { tasks?: PersistentTask[] }
      return body.tasks ?? []
    } catch {
      return []
    }
  }

  async pauseTask(taskId: string): Promise<boolean> {
    try {
      const res = await this.postJson(`/api/tasks/${encodeURIComponent(taskId)}/pause`, {})
      return res.ok
    } catch {
      return false
    }
  }

  async resumeTask(taskId: string): Promise<boolean> {
    try {
      const res = await this.postJson(`/api/tasks/${encodeURIComponent(taskId)}/resume`, {})
      return res.ok
    } catch {
      return false
    }
  }

  async cancelTask(taskId: string): Promise<boolean> {
    try {
      const res = await this.postJson(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {})
      return res.ok
    } catch {
      return false
    }
  }

  async approveTask(taskId: string, approvalId: string): Promise<boolean> {
    try {
      const res = await this.postJson(`/api/tasks/${encodeURIComponent(taskId)}/approve`, { approvalId })
      return res.ok
    } catch {
      return false
    }
  }

  async rejectTask(taskId: string, approvalId: string, reason?: string): Promise<boolean> {
    try {
      const res = await this.postJson(`/api/tasks/${encodeURIComponent(taskId)}/reject`, { approvalId, reason })
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Execute an autonomous development action via the backend DevEngine.
   */
  async executeDevAction(
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; message: string; data?: unknown; error?: string }> {
    const res = await this.postJson('/api/dev/execute', { action, params })
    const body = res.body || {}
    return {
      ok: res.ok && body.ok !== false,
      message: typeof body.message === 'string' ? body.message : (res.error ?? ''),
      data: body.data,
      error: res.error || (typeof body.error === 'string' ? body.error : undefined),
    }
  }
}
