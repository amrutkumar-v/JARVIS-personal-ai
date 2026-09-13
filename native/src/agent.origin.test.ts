import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { startAgent, isOriginAllowed } from './agent.js'
import { MemoryFsBackend } from './testingBackend.js'
import type { NativeResponse } from './protocol.js'

const ROOT = 'C:\\JARVIS\\workspace'
const TOKEN = 'origin-test-token'

async function rpc(baseUrl: string, origin: string | undefined, token: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (origin !== undefined) headers.origin = origin
  headers.authorization = `Bearer ${token}`
  return fetch(`${baseUrl}/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system.ping', params: {} }),
  })
}

async function asJson(res: Response): Promise<NativeResponse> {
  return (await res.json()) as NativeResponse
}

describe('native agent origin gate (Phase 11 — P0 convergence)', () => {
  let agent: Awaited<ReturnType<typeof startAgent>>
  const memory = new MemoryFsBackend()

  beforeAll(async () => {
    agent = await startAgent({ roots: [ROOT], token: TOKEN, backend: memory, port: 0 })
  })

  afterAll(async () => {
    await agent.close()
  })

  it('allows requests without an Origin header (server probes, curl)', async () => {
    const res = await rpc(agent.baseUrl, undefined, TOKEN)
    expect(res.status).toBe(200)
    expect(await asJson(res)).toMatchObject({ jsonrpc: '2.0', id: 1, result: { pong: true } })
  })

  it('allows loopback origins from the local browser frontend', async () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:8787']) {
      const res = await rpc(agent.baseUrl, origin, TOKEN)
      expect(res.status, origin).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBe(origin)
    }
  })

  it('allows file:// pages (Origin: null)', async () => {
    const res = await rpc(agent.baseUrl, 'null', TOKEN)
    expect(res.status).toBe(200)
  })

  it('denies a random website origin without leaking CORS permission', async () => {
    const res = await rpc(agent.baseUrl, 'https://evil.example', TOKEN)
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    const body = await asJson(res)
    expect('error' in body ? body.error.code : undefined).toBe('origin_denied')
  })

  it('denies cross-site preflight OPTIONS requests', async () => {
    expect(agent).toBeDefined()
    const res = await fetch(`${agent.baseUrl}/rpc`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('denies a different scheme on an otherwise-loopback host', async () => {
    const res = await rpc(agent.baseUrl, 'https://localhost:5173', TOKEN)
    expect(res.status).toBe(403)
  })
})

describe('isOriginAllowed', () => {
  it('honors an explicit allow-list and the wildcard', () => {
    expect(isOriginAllowed('https://jarvis.example', ['https://jarvis.example'])).toBe(true)
    expect(isOriginAllowed('https://jarvis.example', ['*'])).toBe(true)
    expect(isOriginAllowed('https://nope.example', ['https://jarvis.example'])).toBe(false)
  })

  it('defaults to loopback + null when no explicit list is given', () => {
    expect(isOriginAllowed('http://localhost:5173', undefined)).toBe(true)
    expect(isOriginAllowed('http://127.0.0.1:9999', undefined)).toBe(true)
    expect(isOriginAllowed('http://[::1]:8080', undefined)).toBe(true)
    expect(isOriginAllowed('null', undefined)).toBe(true)
    expect(isOriginAllowed('https://evil.example', undefined)).toBe(false)
    expect(isOriginAllowed(undefined, undefined)).toBe(true)
  })
})