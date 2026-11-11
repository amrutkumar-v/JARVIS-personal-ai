import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceRegistry } from './registry.js'
import { EventBus } from './events.js'
import { FileStore } from './files.js'
import { buildHealth } from './health.js'
import { startHttpServer, type RuntimeContext, type RunningHttp } from './http.js'
import { BACKEND_NAME, BACKEND_PROTOCOL, BACKEND_VERSION } from './version.js'

const TEST_TOKEN = 'backend-test-token'

/** Minimal SSE test client (parses `event:` / `data:` blocks over node:http). */
class SseClient {
  private buffer = ''
  private waiting: Array<{ name: string; resolve: (data: unknown) => void; timer: ReturnType<typeof setTimeout> }> = []
  private req: ReturnType<typeof request> | null = null
  ready: Promise<void>

  constructor(port: number, token = TEST_TOKEN) {
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/events',
          method: 'GET',
          headers: token ? { authorization: `Bearer ${token}` } : {},
        },
        (res) => {
          if (res.statusCode !== 200) {
            rejectReady(new Error(`SSE status ${res.statusCode ?? 'unknown'}`))
            return
          }
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => this.ingest(chunk))
          res.on('error', rejectReady)
          resolveReady()
        },
      )
      this.req.on('error', rejectReady)
      this.req.end()
    })
  }

  private ingest(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 2)
      const eventLine = block.split('\n').find((l) => l.startsWith('event: '))
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
      const name = eventLine?.slice('event: '.length)
      const data = dataLine ? dataLine.slice('data: '.length) : ''
      if (!name) continue
      let payload: unknown = data
      try {
        payload = JSON.parse(data)
      } catch {
        // keep raw text
      }
      const pending = this.waiting.findIndex((w) => w.name === name)
      if (pending >= 0) {
        const entry = this.waiting.splice(pending, 1)[0]!
        clearTimeout(entry.timer)
        entry.resolve(payload)
      }
    }
  }

  waitEvent(name: string, timeoutMs = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w.timer !== timer)
        reject(new Error(`timed out waiting for SSE event "${name}"`))
      }, timeoutMs)
      this.waiting.push({ name, resolve, timer })
    })
  }

  close(): void {
    this.req?.destroy()
  }
}

async function jsonPost(port: number, path: string, body: unknown, token: string | null = TEST_TOKEN): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as unknown }
}

describe('JARVIS Core HTTP server', () => {
  let dir: string
  let running: RunningHttp
  let registry: DeviceRegistry
  let bus: EventBus
  let files: FileStore
  let dataDir: string
  let nowValue: number
  let nativeForwarded: Array<{ url: string; init: RequestInit }> = []
  let nativeFetchError: Error | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jarvis-http-'))
    dataDir = join(dir, 'data')
    nowValue = 1000
    nativeForwarded = []
    nativeFetchError = undefined
    registry = new DeviceRegistry({ now: () => nowValue })
    bus = new EventBus()
    files = new FileStore({ dir: join(dir, 'files'), now: () => nowValue, generateId: () => `f-1` })
    const assistant: Record<string, unknown> = {}
    const wake = { browserOnly: true as const }
    const context: RuntimeContext = {
      name: BACKEND_NAME,
      version: BACKEND_VERSION,
      protocol: BACKEND_PROTOCOL,
      pid: 1234,
      startedAt: nowValue - 500,
      dataDir,
      lockFile: join(dataDir, 'backend.pid'),
      logFile: join(dataDir, 'logs', 'test.log'),
      registry,
      bus,
      files,
      nativeStatus: () => ({
        supervising: true,
        connected: true,
        reachable: true,
        childRunning: true,
        childPid: 777,
        protocol: 'jarvis-native-1',
        version: '2.8.0',
        restarts: 0,
        lastProbeAt: nowValue,
      }),
      assistant,
      wake,
      now: () => nowValue,
      health: () =>
        buildHealth({
          name: BACKEND_NAME,
          version: BACKEND_VERSION,
          protocol: BACKEND_PROTOCOL,
          pid: 1234,
          startedAt: nowValue - 500,
          now: nowValue,
          native: {
            supervising: true,
            connected: true,
            reachable: true,
            childRunning: true,
            childPid: 777,
            protocol: 'jarvis-native-1',
            version: '2.8.0',
            restarts: 0,
            lastProbeAt: nowValue,
          },
          registry,
          assistant,
          wake,
          filesCount: files.count(),
          dataDir,
          lockFile: join(dataDir, 'backend.pid'),
          logFile: join(dataDir, 'logs', 'test.log'),
        }),
    }
    running = await startHttpServer({
      host: '127.0.0.1',
      port: 0,
      context,
      staticDir: undefined,
      publicDir: join(dir, 'public'),
      token: TEST_TOKEN,
      trustedOrigins: ['http://jarvis.local', 'http://127.0.0.1:3000'],
      nativeAgent: {
        baseUrl: 'http://127.0.0.1:8765',
        token: 'native-server-test-token',
        fetchImpl: (async (input: string | URL, init?: RequestInit) => {
          nativeForwarded.push({ url: String(input), init: init ?? {} })
          if (nativeFetchError) throw nativeFetchError
          const payload = JSON.parse(String(init?.body ?? '{}')) as { id?: unknown; method?: unknown }
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { method: payload.method, connected: true } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }) as typeof fetch,
      },
    })
    const { writeFile } = await import('node:fs/promises')
    await (await import('node:fs/promises')).mkdir(join(dir, 'public'), { recursive: true })
    await writeFile(join(dir, 'public', 'phone.html'), '<script>fetch("/api/session")</script>')
  })

  afterEach(async () => {
    await running?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('public GET /health exposes only a safe summary; authenticated /api/health reports full state', async () => {
    const res = await fetch(`http://127.0.0.1:${running.port}/health`)
    expect(res.status).toBe(200)
    const publicHealth = (await res.json()) as Record<string, unknown>
    expect(publicHealth).toMatchObject({ name: BACKEND_NAME, version: BACKEND_VERSION, protocol: BACKEND_PROTOCOL, status: 'degraded' })
    expect(publicHealth).not.toHaveProperty('pid')
    expect(publicHealth).not.toHaveProperty('devices')
    expect(publicHealth).not.toHaveProperty('paths')

    const detailsResponse = await fetch(`http://127.0.0.1:${running.port}/api/health`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    })
    expect(detailsResponse.status).toBe(200)
    const health = (await detailsResponse.json()) as Record<string, unknown>
    expect(health.name).toBe(BACKEND_NAME)
    expect(health.version).toBe(BACKEND_VERSION)
    expect(health.protocol).toBe(BACKEND_PROTOCOL)
    expect(health.status).toBe('degraded') // assistant has not reported in yet
    const native = health.native as Record<string, unknown>
    expect(native.connected).toBe(true)
    expect(native.version).toBe('2.8.0')
    // The registry always contains exactly the four trusted devices; only the
    // host PC (victus) can be online before any phone/Dell bridge reports in.
    expect((health.devices as Record<string, unknown>).count).toBe(4)
    expect((health.devices as { online: number }).online).toBe(1)
    expect(health).not.toHaveProperty('secretsFabricated')
  })

  it('claim (pairing) → heartbeat → registry round trip for a trusted phone', async () => {
    const claim = await jsonPost(running.port, '/api/device/claim', {
      device: 's26-ultra',
      meta: { name: "Amrut's S26 Ultra", version: '2.8.0', battery: 82, charging: true, network: 'wifi' },
    })
    expect(claim.status).toBe(200)
    const device = (claim.body as { device: { id: string; online: boolean; platform: string; battery: number } }).device
    expect(device.id).toBe('s26-ultra')
    expect(device.online).toBe(true)
    expect(device.platform).toBe('android')
    expect(device.battery).toBe(82)

    const hb = await jsonPost(running.port, '/api/device/heartbeat', { id: 's26-ultra', meta: { battery: 81 } })
    expect(hb.status).toBe(200)
    expect((hb.body as { ok: boolean }).ok).toBe(true)

    const unknown = await jsonPost(running.port, '/api/device/heartbeat', { id: 'ghost' })
    expect((unknown.body as { ok: boolean }).ok).toBe(false)

    const registryList = (await (await fetch(`http://127.0.0.1:${running.port}/api/device/registry`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    })).json()) as {
      devices: Array<{ id: string; online: boolean }>
      count: number
    }
    expect(registryList.count).toBe(4)
    expect(registryList.devices.map((d) => d.id)).toEqual(['victus-5050', 'dell-laptop', 's26-ultra', 's23-fe'])
    expect(registryList.devices.find((d) => d.id === 's26-ultra')?.online).toBe(true)
  })

  it('REFUSES to pair unknown devices — they are never added to the trusted registry', async () => {
    const claim = await jsonPost(running.port, '/api/device/claim', { device: 'some-randon-phone', meta: { name: 'Unknown' } })
    expect(claim.status).toBe(403)
    expect((claim.body as { error: string }).error).toBe('untrusted_device')
    const list = (await (await fetch(`http://127.0.0.1:${running.port}/api/device/list`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    })).json()) as { devices: Array<{ id: string }> }
    expect(list.devices.some((d) => d.id === 'some-randon-phone')).toBe(false)
    expect(list.devices.length).toBe(4)
  })

  it('notify delivers to ONE trusted device over SSE and never lies about delivery', async () => {
    await jsonPost(running.port, '/api/device/claim', { device: 's26-ultra', meta: { name: "Amrut's S26 Ultra" } })

    const sse = new SseClient(running.port)
    await sse.ready
    const eventP = sse.waitEvent('notify')

    const notify = await jsonPost(running.port, '/api/device/notify', { device: 's26-ultra', title: 'Demo', message: 'Hello phone' })
    expect((notify.body as { delivered: boolean; deliveredTo: string[] }).delivered).toBe(true)
    expect((notify.body as { deliveredTo: string[] }).deliveredTo).toEqual(['s26-ultra'])

    const received = (await eventP) as { deviceId: string; title: string; message: string }
    expect(received.title).toBe('Demo')
    expect(received.deviceId).toBe('s26-ultra')
    sse.close()
  })

  it('notify rejects unknown targets and reports honest failure for an offline trusted device', async () => {
    await jsonPost(running.port, '/api/device/claim', { device: 's23-fe', meta: { name: "Amrut's S23 FE" } })

    const invalid = await jsonPost(running.port, '/api/device/notify', { device: 'unknown-phone', title: 'T', message: 'M' })
    expect(invalid.status).toBe(400)
    expect((invalid.body as { error: string }).error).toBe('invalid_target')

    nowValue = nowValue + 100_000 // heartbeat lapses → s23 offline
    const notify = await jsonPost(running.port, '/api/device/notify', { device: 's23-fe', title: 'T', message: 'M' })
    const body = notify.body as { delivered: boolean; reason?: string }
    expect(body.delivered).toBe(false)
    expect(body.reason).toContain('offline')
  })

  it('open-url delivers to ONE online trusted device over SSE (http/https only)', async () => {
    await jsonPost(running.port, '/api/device/claim', { device: 's26-ultra', meta: { name: "Amrut's S26 Ultra" } })

    const sse = new SseClient(running.port)
    await sse.ready
    const eventP = sse.waitEvent('open-url')

    const open = await jsonPost(running.port, '/api/device/open-url', {
      deviceId: 's26-ultra',
      url: 'https://example.com/watch',
    })
    expect(open.status).toBe(200)
    expect((open.body as { delivered: boolean; deliveredTo: string[] }).delivered).toBe(true)
    expect((open.body as { deliveredTo: string[] }).deliveredTo).toEqual(['s26-ultra'])

    const received = (await eventP) as { deviceId: string; deviceName: string; url: string }
    expect(received.deviceId).toBe('s26-ultra')
    expect(received.url).toBe('https://example.com/watch')
    sse.close()
  })

  it('open-url rejects non-http schemes, unknown targets, and honestly fails offline', async () => {
    await jsonPost(running.port, '/api/device/claim', { device: 's23-fe', meta: { name: "Amrut's S23 FE" } })

    const badScheme = await jsonPost(running.port, '/api/device/open-url', {
      deviceId: 's23-fe',
      url: 'file:///etc/passwd',
    })
    expect(badScheme.status).toBe(400)
    expect((badScheme.body as { error: string }).error).toBe('invalid_url')

    const unknown = await jsonPost(running.port, '/api/device/open-url', {
      deviceId: 'unknown-phone',
      url: 'https://example.com',
    })
    expect(unknown.status).toBe(400)
    expect((unknown.body as { error: string }).error).toBe('invalid_target')

    nowValue = nowValue + 100_000 // heartbeat lapses → s23 offline
    const offline = await jsonPost(running.port, '/api/device/open-url', {
      deviceId: 's23-fe',
      url: 'https://example.com',
    })
    const body = offline.body as { ok: boolean; delivered: boolean; error?: string; reason?: string }
    expect(body.ok).toBe(false)
    expect(body.delivered).toBe(false)
    expect(body.error).toBe('device_offline')
    expect(body.reason).toContain('offline')
  })

  it('protects protected POST endpoints when a token is configured', async () => {
    await running.close()
    const dir2 = await mkdtemp(join(tmpdir(), 'jarvis-http2-'))
    try {
      const running2 = await startHttpServer({
        host: '127.0.0.1',
        port: 0,
        context: {
          name: BACKEND_NAME,
          version: BACKEND_VERSION,
          protocol: BACKEND_PROTOCOL,
          pid: 1,
          startedAt: 1,
          dataDir,
          registry,
          bus,
          files,
          nativeStatus: () => ({ supervising: false, connected: false, reachable: false, childRunning: false, restarts: 0 }),
          assistant: {},
          wake: { browserOnly: true },
          now: () => nowValue,
          health: () =>
            buildHealth({
              name: BACKEND_NAME,
              version: BACKEND_VERSION,
              protocol: BACKEND_PROTOCOL,
              pid: 1,
              startedAt: 1,
              now: nowValue,
              native: { supervising: false, connected: false, reachable: false, childRunning: false, restarts: 0 },
              registry,
              assistant: {},
              wake: { browserOnly: true },
              filesCount: files.count(),
              dataDir,
            }),
        },
        token: 's3cret',
        publicDir: join(dir, 'public'),
      })
    const bad = await jsonPost(running2.port, '/api/device/notify', { title: 'T', message: 'M' }, null)
      expect(bad.status).toBe(401)
      const good = await jsonPost(running2.port, '/api/device/notify', { title: 'T', message: 'M' }, 's3cret')
      expect(good.status).toBe(200)
      // pairing claim + heartbeat are protected too (no unrestricted endpoints).
      const unauthedClaim = await jsonPost(running2.port, '/api/device/claim', { device: 's26-ultra' }, null)
      expect(unauthedClaim.status).toBe(401)
      const claim = await jsonPost(running2.port, '/api/device/claim', { device: 's26-ultra', meta: { name: "Amrut's S26 Ultra" } }, 's3cret')
      expect(claim.status).toBe(200)
      await running2.close()
    } finally {
      await rm(dir2, { recursive: true, force: true })
    }
  })

  it('requires a bearer or HttpOnly browser session on privileged APIs and enforces exact origins', async () => {
    const url = `http://127.0.0.1:${running.port}`
    const missing = await fetch(`${url}/api/device/registry`)
    expect(missing.status).toBe(401)

    const wrong = await fetch(`${url}/api/device/registry`, { headers: { authorization: 'Bearer wrong' } })
    expect(wrong.status).toBe(401)

    const wrongOrigin = await fetch(`${url}/api/device/registry`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}`, origin: 'https://untrusted.example' },
    })
    expect(wrongOrigin.status).toBe(403)
    expect(wrongOrigin.headers.get('access-control-allow-origin')).toBeNull()

    const session = await fetch(`${url}/api/session`, { headers: { origin: 'http://jarvis.local' } })
    expect(session.status).toBe(200)
    expect(session.headers.get('access-control-allow-origin')).toBe('http://jarvis.local')
    expect(session.headers.get('access-control-allow-credentials')).toBe('true')
    const cookie = session.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toMatch(/^jarvis_session=/)

    const withSession = await fetch(`${url}/api/device/registry`, {
      headers: { origin: 'http://jarvis.local', cookie: cookie! },
    })
    expect(withSession.status).toBe(200)

    const allowedPreflight = await fetch(`${url}/api/native/rpc`, {
      method: 'OPTIONS',
      headers: { origin: 'http://jarvis.local', 'access-control-request-method': 'POST' },
    })
    expect(allowedPreflight.status).toBe(204)
    expect(allowedPreflight.headers.get('access-control-allow-origin')).toBe('http://jarvis.local')
    expect(allowedPreflight.headers.get('access-control-allow-credentials')).toBe('true')

    const deniedPreflight = await fetch(`${url}/api/native/rpc`, {
      method: 'OPTIONS',
      headers: { origin: 'https://untrusted.example', 'access-control-request-method': 'POST' },
    })
    expect(deniedPreflight.status).toBe(403)
    expect(deniedPreflight.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('brokers only allow-listed native RPC methods and keeps the agent token server-side', async () => {
    const url = `http://127.0.0.1:${running.port}/api/native/rpc`
    const good = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'system.ping', params: {} }),
    })
    expect(good.status).toBe(200)
    expect(await good.json()).toMatchObject({ result: { method: 'system.ping', connected: true } })
    expect(nativeForwarded).toHaveLength(1)
    expect(nativeForwarded[0]!.url).toBe('http://127.0.0.1:8765/')
    expect(nativeForwarded[0]!.init.headers).toMatchObject({ authorization: 'Bearer native-server-test-token' })

    for (const method of ['exec', 'shell', 'cmd', 'powershell', 'command.run']) {
      const denied = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 8, method, params: {} }),
      })
      expect(denied.status).toBe(400)
    }
    expect(nativeForwarded).toHaveLength(1)

    nativeFetchError = new Error('connection refused')
    const unavailable = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'offline', method: 'system.ping', params: {} }),
    })
    expect(unavailable.status).toBe(502)
    expect(await unavailable.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 'offline',
      error: { code: 'native_unavailable' },
    })

    nativeFetchError = new DOMException('The native agent timed out.', 'AbortError')
    const timedOut = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'timeout', method: 'system.ping', params: {} }),
    })
    expect(timedOut.status).toBe(504)
    expect(await timedOut.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 'timeout',
      error: { code: 'timeout' },
    })
  })

  it('file upload → list → download round trip', async () => {
    const upload = await jsonPost(running.port, '/api/device/file', {
      name: 'note.txt',
      content: Buffer.from('hello').toString('base64'),
    })
    expect(upload.status).toBe(200)
    const file = (upload.body as { file: { id: string; url: string; size: number } }).file
    expect(file.size).toBe(5)

    const list = (await (await fetch(`http://127.0.0.1:${running.port}/api/files`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    })).json()) as { files: Array<{ id: string }> }
    expect(list.files.some((f) => f.id === file.id)).toBe(true)

    const download = await fetch(`http://127.0.0.1:${running.port}${file.url}`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    })
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('hello')
  })

  it('inbound device message reaches the SSE hub', async () => {
    await jsonPost(running.port, '/api/device/claim', { device: 's26-ultra', meta: { name: "Amrut's S26 Ultra" } })
    const sse = new SseClient(running.port)
    await sse.ready
    const eventP = sse.waitEvent('inbound')
    const inbound = await jsonPost(running.port, '/api/inbound', { deviceId: 's26-ultra', text: 'Can you open Chrome?' })
    const received = (await eventP) as { deviceName: string; text: string }
    expect(received.text).toBe('Can you open Chrome?')
    expect(received.deviceName).toBe("Amrut's S26 Ultra")
    expect((inbound.body as { ok: boolean }).ok).toBe(true)
    sse.close()
  })

  it('assistant/state mirror updates /health and flips it to ok', async () => {
    const res1 = await fetch(`http://127.0.0.1:${running.port}/health`)
    expect((await res1.json()) as { status: string }).toMatchObject({ status: 'degraded' })

    await jsonPost(running.port, '/api/assistant/state', { status: 'idle', isSpeaking: false, cameraActive: true })
    const res2 = (await (await fetch(`http://127.0.0.1:${running.port}/api/health`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    })).json()) as {
      status: string
      assistant: { status: string; cameraActive: boolean; lastSeenAt: number }
    }
    expect(res2.status).toBe('ok')
    expect(res2.assistant.status).toBe('idle')
    expect(res2.assistant.cameraActive).toBe(true)
  })

  it('wake events register in /health', async () => {
    await jsonPost(running.port, '/api/wake', { event: 'arm' })
    const health = (await (await fetch(`http://127.0.0.1:${running.port}/api/health`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    })).json()) as { wake: { armAt?: number; browserOnly: true } }
    expect(health.wake.browserOnly).toBe(true)
    expect(health.wake.armAt).toBe(nowValue)
  })

  it('serves the companion page without embedding a bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${running.port}/phone`)
    expect(res.status).toBe(200)
    const text = (await res.text()) as string
    expect(text).not.toContain(TEST_TOKEN)
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/)
  })
})
