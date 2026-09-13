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
import type {
  BackendEventType,
  BackendHealth,
  ClaimMeta,
  DeviceRecord,
  InboundMessage,
  NotifyRequest,
  NotifyResult,
  OutboundFile,
} from './types'

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

const EVENT_NAMES: BackendEventType[] = ['device', 'notify', 'open-url', 'file', 'inbound', 'assistant', 'wake']

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
  private listener: ((event: { data: string }) => void) | null = null
  private readyHandler: ((event: { data: string }) => void) | null = null

  constructor(deps: BackendClientDeps = {}) {
    this.config = deps.config ?? getBackendConfig()
    this.fetchImpl = deps.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : async () => { throw new Error('fetch unavailable') })
    this.makeEventSource = deps.makeEventSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike)
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
    const source = this.makeEventSource(`${this.config.baseUrl}/events`)
    this.source = source
    this.listener = (event: { data: string }): void => this.dispatchMessage(event.data)
    for (const name of EVENT_NAMES) {
      source.addEventListener(name, this.listener)
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
    if (this.listener) {
      for (const name of EVENT_NAMES) {
        this.source.removeEventListener(name, this.listener)
      }
    }
    if (this.readyHandler) {
      this.source.removeEventListener('ready', this.readyHandler)
    }
    this.source.close()
    this.source = null
    this.listener = null
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

  private dispatchMessage(data: string): void {
    try {
      const envelope = JSON.parse(data) as { type?: BackendEventType; data?: unknown }
      switch (envelope.type) {
        case 'notify':
          this.handlers.onNotify?.(envelope.data as { deviceId: string; title: string; message: string; at: number })
          break
        case 'open-url':
          this.handlers.onOpenUrl?.(envelope.data as { deviceId: string; deviceName?: string; url: string; at: number })
          break
        case 'file':
          this.handlers.onFile?.(envelope.data as OutboundFile)
          break
        case 'inbound':
          this.handlers.onInbound?.(envelope.data as InboundMessage)
          break
        case 'device':
          this.handlers.onDevice?.(envelope.data as { event: string; device: DeviceRecord })
          break
        case 'wake':
          this.handlers.onWake?.(envelope.data as { event: string; at: number })
          break
        case 'assistant':
          break
      }
    } catch {
      // A malformed frame is dropped; the stream stays alive.
    }
  }

  /* --------------------------------------------------- fetch helpers */

  private async postJson(
    path: string,
    body: unknown,
  ): Promise<{ status: number; ok: boolean; error?: string; body: Record<string, unknown> }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.config.token) headers.authorization = `Bearer ${this.config.token}`
    try {
      const res = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
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
      const res = await this.fetchImpl(`${this.config.baseUrl}/api/device/registry`)
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
      const res = await this.fetchImpl(`${this.config.baseUrl}/api/files`)
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
}