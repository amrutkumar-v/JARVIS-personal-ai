import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendClient } from './BackendClient'
import type { EventSourceLike } from './BackendClient'
import type { BackendHealth } from './types'

/**
 * Deterministic EventSource stub: the test controls what the server "pushes".
 * Kept as honest as the real stream — a real event only lands when an
 * addEventListener callback is invoked with a real frame.
 */
class FakeEventSource implements EventSourceLike {
  listeners = new Map<string, Array<(event: { data: string }) => void>>()
  onerror: (() => void) | null = null
  closed = false
  nextUrl: string

  constructor(url: string) {
    this.nextUrl = url
  }

  addEventListener(event: string, handler: (event: { data: string }) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(handler)
    this.listeners.set(event, list)
  }

  removeEventListener(event: string, handler: (event: { data: string }) => void): void {
    const list = (this.listeners.get(event) ?? []).filter((h) => h !== handler)
    this.listeners.set(event, list)
  }

  close(): void {
    this.closed = true
  }

  push(event: string, data: unknown): void {
    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    for (const handler of this.listeners.get(event) ?? []) handler({ data: payload })
  }

  drop(): void {
    this.onerror?.()
  }
}

const HEALTH: BackendHealth = {
  name: 'JARVIS Core',
  version: '0.9.0',
  protocol: 'jarvis-backend-2',
  status: 'ok',
  pid: 1,
  startedAt: '2026-01-01T00:00:00.000Z',
  uptimeMs: 5,
  now: 5,
  native: { supervising: false, connected: false, reachable: false, childRunning: false, restarts: 0 },
  devices: { count: 0, online: 0, list: [] },
  assistant: {},
  wake: { browserOnly: true },
  files: { count: 0 },
  paths: { dataDir: 'x' },
}

function makeClient(events: FakeEventSource, fetchImpl: typeof fetch = fetch) {
  return new BackendClient({
    config: { baseUrl: 'http://test:8787', maxReconnectAttempts: 2, reconnectBaseMs: 5, mirrorThrottleMs: 10 },
    makeEventSource: (url) => {
      events.nextUrl = url
      return events
    },
    fetchImpl,
  })
}

describe('BackendClient', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('connects, becomes connected on ready, and stops cleanly', () => {
    const es = new FakeEventSource('')
    const client = makeClient(es)
    const ready = vi.fn()
    client.on('onReady', ready)
    client.start()
    expect(es.nextUrl).toContain('/events')
    expect(client.phase).toBe('idle')
    es.push('ready', HEALTH)
    expect(client.phase).toBe('connected')
    expect(client.hasConnected).toBe(true)
    expect(ready).toHaveBeenCalledWith(HEALTH)
    expect(client.lastHealth()).toEqual(HEALTH)
    client.stop()
    expect(es.closed).toBe(true)
  })

  it('routes named events to handlers', () => {
    const es = new FakeEventSource('')
    const client = makeClient(es)
    const notify = vi.fn()
    const inbound = vi.fn()
    client.on('onNotify', notify)
    client.on('onInbound', inbound)
    client.start()
    es.push('ready', HEALTH)
    // The real server writes `event: <type>` + `data: <BARE payload>` — the
    // payload is NOT wrapped in a {type,data} envelope.
    es.push('notify', { deviceId: 'p', title: 'T', message: 'M', at: 1 })
    es.push('inbound', '{"deviceId":"p","deviceName":"Pixel","text":"hi","at":2}')
    expect(notify).toHaveBeenCalledWith({ deviceId: 'p', title: 'T', message: 'M', at: 1 })
    expect(inbound).toHaveBeenCalledWith({ deviceId: 'p', deviceName: 'Pixel', text: 'hi', at: 2 })
    client.stop()
  })

  it('routes a real call-state frame pushed by the backend', () => {
    const es = new FakeEventSource('')
    const client = makeClient(es)
    const call = vi.fn()
    client.on('onCall', call)
    client.start()
    es.push('ready', HEALTH)
    es.push('call', { deviceId: 's26-ultra', state: 'CONNECTED', direction: 'outgoing', at: 7 })
    expect(call).toHaveBeenCalledWith({ deviceId: 's26-ultra', state: 'CONNECTED', direction: 'outgoing', at: 7 })
    client.stop()
  })

  it('delivers the frame body verbatim — it never unwraps a {type,data} envelope', () => {
    const es = new FakeEventSource('')
    const client = makeClient(es)
    const notify = vi.fn()
    client.on('onNotify', notify)
    client.start()
    es.push('ready', HEALTH)
    // The name routes the frame; the body is handed over as-is. An
    // envelope-shaped body is therefore delivered whole, never unwrapped.
    es.push('notify', { type: 'notify', data: { deviceId: 'p', title: 'T', message: 'M', at: 1 } })
    expect(notify).toHaveBeenCalledWith({ type: 'notify', data: { deviceId: 'p', title: 'T', message: 'M', at: 1 } })
    client.stop()
  })

  it('fires onDisconnected once per drop episode and clears it on a real recovery', () => {
    vi.useFakeTimers()
    const es = new FakeEventSource('')
    const client = makeClient(es)
    const lost = vi.fn()
    const recovered = vi.fn()
    client.on('onDisconnected', lost)
    client.on('onReady', recovered)
    client.start()
    es.push('ready', HEALTH)
    expect(recovered).toHaveBeenCalledTimes(1)

    // Episode 1: a drop announces disconnection exactly once (5ms backoff ->
    // connecting attempt -> the next drop is still the same episode).
    es.drop()
    expect(lost).toHaveBeenCalledTimes(1)
    expect(client.phase).toBe('waiting')
    vi.advanceTimersByTime(5) // reconnect attempt connects
    es.drop() // same episode fails again
    expect(lost).toHaveBeenCalledTimes(1)

    // A genuine recovery clears the flag.
    vi.advanceTimersByTime(10) // next attempt
    es.push('ready', HEALTH)
    expect(recovered).toHaveBeenCalledTimes(2)
    expect(client.phase).toBe('connected')

    // Episode 2 announces disconnection again.
    es.drop()
    expect(lost).toHaveBeenCalledTimes(2)
    client.stop()
    es.push('ready', HEALTH)
    expect(recovered).toHaveBeenCalledTimes(2) // stop() silences events
  })

  it('reconnects (waiting → connected) after the stream drops, then gives up within the limit', async () => {
    vi.useFakeTimers()
    const es = new FakeEventSource('')
    const client = makeClient(es)
    const gaveUp = vi.fn()
    client.on('onGaveUp', gaveUp)
    client.start()
    es.push('ready', HEALTH)
    expect(client.phase).toBe('connected')

    // Cycle 1 — the stream drops, waits the bounded delay, reconnects, and a
    // fresh ready frame restores the connection.
    es.drop()
    expect(client.phase).toBe('waiting')
    await vi.advanceTimersByTimeAsync(20)
    es.push('ready', HEALTH)
    expect(client.phase).toBe('connected')

    // Cycle 2 — drops again and the server never answers; the bounded attempts
    // run out and the client reports `giving_up` honestly instead of looping.
    es.drop()
    await vi.advanceTimersByTimeAsync(20)
    es.drop()
    await vi.advanceTimersByTimeAsync(20)
    es.drop()
    await vi.advanceTimersByTimeAsync(20)
    expect(client.phase).toBe('giving_up')
    expect(gaveUp).toHaveBeenCalled()
    client.stop()
  })

  it('reports backend unreachable honestly from fetch helpers', async () => {
    const es = new FakeEventSource('')
    const fetchImpl = (() => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const client = makeClient(es, fetchImpl)
    const notify = await client.notify({ title: 'T', message: 'M' })
    expect(notify.ok).toBe(false)
    expect(notify.delivered).toBe(false)
    expect(notify.error).toBe('backend unreachable')
  })

  it('POSTs JSON with an HttpOnly-session credential and never sends a bearer token', async () => {
    const es = new FakeEventSource('')
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ ok: true, delivered: true, deliveredTo: ['p'] }), { status: 200 })
    }) as typeof fetch
    const client = makeClient(es, fetchImpl)
    const result = await client.notify({ title: 'T', message: 'M' })
    expect(result.ok).toBe(true)
    expect(result.delivered).toBe(true)
    expect(calls[0]!.init.headers).not.toHaveProperty('authorization')
    expect(calls[0]!.init.credentials).toBe('include')
  })
})

describe('BackendClient default fetch binding (browser Illegal invocation regression)', () => {
  it('binds the default fetch to globalThis instead of keeping the bare global fetch', () => {
    // Same browser latent bug the native RPC had: `window.fetch` is a native method
    // that throws "Illegal invocation" when called with a foreign receiver. The
    // client calls its stored `fetchImpl` as a plain call, so the default must be
    // a bound copy of the global fetch, not the bare function.
    const client = new BackendClient()
    const impl: unknown = (client as unknown as { fetchImpl: unknown }).fetchImpl
    expect(typeof impl).toBe('function')
    expect(impl).not.toBe(globalThis.fetch)
  })
})
