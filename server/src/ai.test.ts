import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { AI_PROXY_SUBPATHS, proxyAiRequest } from './ai.js'

/** Raw POST using node:http (bypasses globalThis.fetch so mocks don't interfere). */
function rawPost(
  port: number,
  path: string,
  body: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { ...headers, 'content-length': body.length.toString() } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          const h: Record<string, string> = {}
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            h[res.rawHeaders[i]!.toLowerCase()] = res.rawHeaders[i + 1]!
          }
          resolve({ status: res.statusCode ?? 0, headers: h, body: raw })
        })
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function fakeContext(dir: string): RuntimeContext {
  const bus = new EventBus()
  const registry = new DeviceRegistry({ now: () => nowValue })
  const files = new FileStore({ dir: join(dir, 'files'), now: () => nowValue, generateId: () => 'f-ai' })
  const dataDir = join(dir, 'data')
  const assistant: Record<string, unknown> = {}
  const wake = { browserOnly: true as const }
  const native = {
    supervising: true,
    connected: true,
    reachable: true,
    childRunning: true,
    childPid: 777,
    protocol: 'jarvis-native-1',
    version: '2.8.0',
    restarts: 0,
    lastProbeAt: nowValue,
  }
  return {
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
    nativeStatus: () => native,
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
        native,
        registry,
        assistant,
        wake,
        filesCount: files.count(),
        dataDir,
        lockFile: join(dataDir, 'backend.pid'),
        logFile: join(dataDir, 'logs', 'test.log'),
      }),
  }
}

const nowValue = 1000
const TOKEN = 'proxy-test-token'
const UPSTREAM_URL = 'https://upstream.example.com/v1'
const UPSTREAM_KEY = 'sk-proxy-test-key'

describe('AI proxy forwarder (unit)', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
  })

  it('forwards the raw body to the resolved upstream path with the key injected', async () => {
    const bodyJson = '{"model":"gpt","messages":[]}'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        arrayBuffer: async () => new TextEncoder().encode(bodyJson),
      })),
    )
    const result = await proxyAiRequest({ baseUrl: UPSTREAM_URL, key: UPSTREAM_KEY, timeoutMs: 5000 }, '/chat/completions', Buffer.from(bodyJson))
    expect(result.status).toBe(200)
    expect(result.body.toString()).toBe(bodyJson)
    expect((globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${UPSTREAM_URL}/chat/completions`)
    const headers = new Headers(init.headers as RequestInit['headers'])
    expect(headers.get('authorization')).toBe(`Bearer ${UPSTREAM_KEY}`)
  })

  it('routes through the proxy path WITHOUT shipping the key (keyless upstream)', async () => {
    const bodyJson = '{"input":"hi"}'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        arrayBuffer: async () => new TextEncoder().encode('[]'),
      })),
    )
    const result = await proxyAiRequest({ baseUrl: '/api/ai', key: '', timeoutMs: 5000 }, '/embeddings', Buffer.from(bodyJson))
    expect(result.status).toBe(200)
    const headers = new Headers((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.headers as RequestInit['headers'])
    expect(headers.has('authorization')).toBe(false)
  })

  it('rejects misconfigured proxy options immediately', async () => {
    await expect(proxyAiRequest({ baseUrl: '', key: '', timeoutMs: 1000 }, '/chat/completions', Buffer.from('{}'))).rejects.toThrow(/misconfigured/)
  })

  it('throws AbortError on timeout so the HTTP layer can map to 504', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () => new Promise((_resolve, reject) => { setTimeout(() => reject(new DOMException('The operation was aborted.', 'AbortError')), 20) }),
      ),
    )
    await expect(proxyAiRequest({ baseUrl: UPSTREAM_URL, key: UPSTREAM_KEY, timeoutMs: 1 }, '/chat/completions', Buffer.from('{}'))).rejects.toThrow(/abort|AbortError/i)
  })

  it('only allows exactly the two allow-listed subpaths', () => {
    expect(AI_PROXY_SUBPATHS).toEqual(['/chat/completions', '/embeddings'])
  })
})

describe('POST /api/ai routes (integration)', () => {
  const originalFetch = globalThis.fetch
  let running: RunningHttp
  let tmpDir: string
  const token = TOKEN

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'jarvis-ai-proxy-test'))
    const context = fakeContext(tmpDir)
    running = await startHttpServer({
      host: '127.0.0.1',
      port: 0,
      context,
      staticDir: tmpDir,
      token,
      ai: { baseUrl: UPSTREAM_URL, key: UPSTREAM_KEY, timeoutMs: 10000 },
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
    if (running) await running.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('is refused honestly with 503 when the backend AI proxy is not configured', async () => {
    const unconfiguredDir = join(await mkdtemp(join(tmpdir(), 'jarvis-ai-proxy-test')), 'unconfigured')
    const unconfigured = await startHttpServer({
      host: '127.0.0.1',
      port: 0,
      context: fakeContext(unconfiguredDir),
      staticDir: tmpDir,
      token,
      ai: undefined,
    })
    try {
      const res = await rawPost(unconfigured.port, '/api/ai/chat/completions', Buffer.from('{}'), { authorization: `Bearer ${token}` })
      expect(res.status).toBe(503)
      expect(JSON.parse(res.body).error).toBe('ai_not_configured')
    } finally {
      await unconfigured.close()
    }
  })

  it('404s on unknown AI subpaths', async () => {
    const res = await rawPost(running.port, '/api/ai/unknown/path', Buffer.from('{}'), { authorization: `Bearer ${token}` })
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body).error).toBe('not_found')
  })

  it('forwards the upstream response verbatim and injects the key server-side', async () => {
    const upstreamBody = JSON.stringify({ choices: [{ message: { content: 'hi from upstream' } }] })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.startsWith(UPSTREAM_URL)) {
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            arrayBuffer: async () => new TextEncoder().encode(upstreamBody),
          }
        }
        return globalThis.fetch(url)
      }),
    )
    const res = await rawPost(running.port, '/api/ai/chat/completions', Buffer.from('{"model":"gpt"}'), { authorization: `Bearer ${token}` })
    expect(res.status).toBe(200)
    expect(res.body).toBe(upstreamBody)
    expect(res.headers['content-type']).toContain('application/json')
    expect((globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${UPSTREAM_URL}/chat/completions`)
    const headers = new Headers(init.headers as RequestInit['headers'])
    expect(headers.get('authorization')).toBe(`Bearer ${UPSTREAM_KEY}`)
  })

  it('returns 502 honestly when the upstream is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')))
    const res = await rawPost(running.port, '/api/ai/chat/completions', Buffer.from('{}'), { authorization: `Bearer ${token}` })
    expect(res.status).toBe(502)
    expect(JSON.parse(res.body).error).toBe('ai_upstream_unreachable')
  })
})