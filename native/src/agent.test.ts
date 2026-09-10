import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { startAgent } from './agent.js'
import { RealFsBackend } from './backend.js'
import type { NativeResponse } from './protocol.js'
import { NATIVE_LIMITS } from './limits.js'
import { MemoryFsBackend } from './testingBackend.js'
import type { FsBackend } from './backend.js'
import { MemoryAppBackend } from './testingApps.js'
import { RealAppBackend } from './appBackend.js'
import { AppRegistry } from './appRegistry.js'
import type { ApplicationBackend } from './applications.js'
import type { AppCloseBackend } from './appClose.js'
import { MemoryObsBackend } from './testingObs.js'
import { RealObsBackend } from './obsWin32.js'
import type { ObservationBackend } from './observation.js'

const ROOT = 'C:\\JARVIS\\workspace'
const TOKEN = 'test-token-123'

async function rpc(baseUrl: string, method: string, params?: Record<string, unknown>, token?: string, raw?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  return fetch(`${baseUrl}/rpc`, {
    method: 'POST',
    headers,
    body: raw ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

async function asJson(res: Response): Promise<NativeResponse> {
  return (await res.json()) as NativeResponse
}

const errorCode = (body: NativeResponse): string | undefined =>
  'error' in body ? body.error.code : undefined

// Stub backend that hangs forever on `read` — exercises the server-side timeout.
const hangingBackend: FsBackend = {
  id: 'hang-native-fs',
  testsOnly: true,
  list: async () => [],
  search: async () => [],
  stat: async () => ({ name: 'x', path: 'x', kind: 'file', size: 1 }),
  read: async () => new Promise(() => undefined) as Promise<{ content: string; bytes: number }>,
  write: async () => ({ bytes: 0 }),
  mkdir: async () => ({ name: 'x', path: 'x', kind: 'directory' }),
  copy: async () => undefined,
  move: async () => undefined,
  rename: async () => ({ name: 'x', path: 'x', kind: 'file', size: 1 }),
  delete: async () => undefined,
}

describe('native agent protocol — JSON-RPC over loopback HTTP (in-memory backend)', () => {
  let agent: Awaited<ReturnType<typeof startAgent>>
  const memory = new MemoryFsBackend()

  beforeAll(async () => {
    agent = await startAgent({ roots: [ROOT], token: TOKEN, backend: memory, port: 0 })
  })

  afterAll(async () => {
    await agent.close()
  })

  beforeEach(() => {
    memory.overrideSeed({})
  })

  it('pings and echoes the request id', async () => {
    const res = await rpc(agent.baseUrl, 'system.ping', undefined, TOKEN)
    await expect(asJson(res)).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: { pong: true } })
  })

  it('reports identity: protocol, version, platform, roots, token requirement', async () => {
    const res = await rpc(agent.baseUrl, 'system.identity', undefined, TOKEN)
    const body = await asJson(res)
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocol: 'jarvis-native-1',
        connected: true,
        roots: [ROOT],
        tokenRequired: true,
      },
    })
  })

  it('rejects requests without the bearer token (401 permission_denied)', async () => {
    const res = await rpc(agent.baseUrl, 'system.ping')
    expect(res.status).toBe(401)
    expect(errorCode(await asJson(res))).toBe('permission_denied')
  })

  it('rejects a wrong token (401)', async () => {
    const res = await rpc(agent.baseUrl, 'system.ping', undefined, 'wrong')
    expect(res.status).toBe(401)
  })

  it('sets CORS headers on responses and answers preflight', async () => {
    const res = await rpc(agent.baseUrl, 'system.ping', undefined, TOKEN)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const opts = await fetch(`${agent.baseUrl}/rpc`, { method: 'OPTIONS' })
    expect(opts.status).toBe(204)
    expect(opts.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('rejects non-POST requests', async () => {
    const get = await fetch(`${agent.baseUrl}/rpc`, { method: 'GET' })
    expect(get.status).toBe(405)
  })

  it('rejects methods outside the allow-list as unsupported — no shell endpoint', async () => {
    const res = await rpc(agent.baseUrl, 'system.execute', { command: 'rm -rf /' }, TOKEN)
    expect(errorCode(await asJson(res))).toBe('unsupported')
  })

  it('answers malformed payloads with the malformed code', async () => {
    const bad = await rpc(agent.baseUrl, 'system.ping', undefined, TOKEN, '{not json')
    expect(errorCode(await asJson(bad))).toBe('malformed')
    const noMethod = await rpc(agent.baseUrl, '', undefined, TOKEN, JSON.stringify({ jsonrpc: '2.0', id: 2 }))
    expect(errorCode(await asJson(noMethod))).toBe('malformed')
    const noEnvelope = await rpc(agent.baseUrl, 'system.ping', undefined, TOKEN, JSON.stringify({ pokemon: true }))
    expect(errorCode(await asJson(noEnvelope))).toBe('malformed')
  })

  it('performs a full filesystem round-trip through the broker', async () => {
    const mk = await rpc(agent.baseUrl, 'filesystem.mkdir', { root: 0, path: 'notes' }, TOKEN)
    expect(await asJson(mk)).toMatchObject({ result: { kind: 'directory', path: 'notes' } })
    const wr = await rpc(agent.baseUrl, 'filesystem.write', { path: 'notes/todo.txt', content: 'hello agent' }, TOKEN)
    expect(await asJson(wr)).toMatchObject({ result: { bytes: 11 } })
    const rd = await rpc(agent.baseUrl, 'filesystem.read', { path: 'notes/todo.txt' }, TOKEN)
    expect(await asJson(rd)).toMatchObject({ result: { content: 'hello agent', bytes: 11 } })
    const ls = await rpc(agent.baseUrl, 'filesystem.list', { path: 'notes', depth: 2 }, TOKEN)
    expect(await asJson(ls)).toMatchObject({ result: [{ name: 'todo.txt', path: 'notes/todo.txt', kind: 'file' }] })
    const st = await rpc(agent.baseUrl, 'filesystem.stat', { path: 'notes' }, TOKEN)
    expect(await asJson(st)).toMatchObject({ result: { kind: 'directory' } })
    const mv = await rpc(agent.baseUrl, 'filesystem.move', { source: 'notes/todo.txt', destination: 'notes/done.txt' }, TOKEN)
    expect(await asJson(mv)).toMatchObject({ result: { ok: true } })
    const rn = await rpc(agent.baseUrl, 'filesystem.rename', { path: 'notes/done.txt', newName: 'final.txt' }, TOKEN)
    expect(await asJson(rn)).toMatchObject({ result: { name: 'final.txt' } })
    const cp = await rpc(agent.baseUrl, 'filesystem.copy', { source: 'notes/final.txt', destination: 'notes/copy.txt' }, TOKEN)
    expect(await asJson(cp)).toMatchObject({ result: { ok: true } })
    const dl = await rpc(agent.baseUrl, 'filesystem.delete', { path: 'notes/copy.txt', recursive: false }, TOKEN)
    expect(await asJson(dl)).toMatchObject({ result: { ok: true } })
  })

  it('rejects traversal and out-of-range roots with the escape code', async () => {
    const trav = await rpc(agent.baseUrl, 'filesystem.stat', { path: '../../outside' }, TOKEN)
    expect(errorCode(await asJson(trav))).toBe('invalid_path')
    const badRoot = await rpc(agent.baseUrl, 'filesystem.list', { root: 7, path: '' }, TOKEN)
    expect(errorCode(await asJson(badRoot))).toBe('outside_allowed_root')
  })

  it('enforces the write size cap', async () => {
    const big = 'x'.repeat(NATIVE_LIMITS.MAX_WRITE_CHARS + 1)
    const res = await rpc(agent.baseUrl, 'filesystem.write', { path: 'big.txt', content: big }, TOKEN)
    expect(errorCode(await asJson(res))).toBe('too_large')
  })

  it('enforces the request body size cap', async () => {
    const huge = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'filesystem.write',
      params: { path: 'x.txt', content: 'x'.repeat(NATIVE_LIMITS.MAX_BODY_BYTES + 1_000_000) },
    })
    const res = await rpc(agent.baseUrl, '', undefined, TOKEN, huge)
    expect(errorCode(await asJson(res))).toBe('too_large')
  })

  it('times out requests that exceed the agent request cap', async () => {
    const hung = await startAgent({
      roots: [ROOT],
      token: TOKEN,
      backend: hangingBackend,
      port: 0,
      requestTimeoutMs: 40,
    })
    try {
      const res = await rpc(hung.baseUrl, 'filesystem.read', { path: 'forever.txt' }, TOKEN)
      expect(errorCode(await asJson(res))).toBe('timeout')
    } finally {
      await hung.close()
    }
  })
})

describe('agent backend defaults', () => {
  it('production wires the REAL Windows filesystem backend, memory is tests-only', () => {
    expect(new MemoryFsBackend().testsOnly).toBe(true)
    expect(new RealFsBackend().id).toBe('real-native-fs')
    expect((new RealFsBackend() as FsBackend).testsOnly).toBeUndefined()
  })

  it('a blank token accepts un-authenticated calls on loopback (explicit opt-out)', async () => {
    const noToken = await startAgent({ roots: [ROOT], token: '', port: 0 })
    try {
      const res = await rpc(noToken.baseUrl, 'system.ping')
      expect(res.status).toBe(200)
      expect(await asJson(res)).toMatchObject({ result: { pong: true } })
      const id = await asJson(await rpc(noToken.baseUrl, 'system.identity', undefined, TOKEN))
      expect('result' in id ? id.result : undefined).toMatchObject({ tokenRequired: false })
    } finally {
      await noToken.close()
    }
  })
})

describe('app.* — application control protocol (Phase 1.3)', () => {
  let agent: Awaited<ReturnType<typeof startAgent>>
  const apps = new MemoryAppBackend([
    { applicationId: 'notepad', name: 'Notepad', launchRule: 'verified' },
    { applicationId: 'calculator', name: 'Calculator', processName: 'calc', launchRule: 'verified' },
    { applicationId: 'slowapp', name: 'Slow App', launchRule: 'unverified' },
    { applicationId: 'vanisher', name: 'Vanisher', launchRule: 'refute' },
    { applicationId: 'locked', name: 'Locked', enabled: false },
    { applicationId: 'weird', name: 'Not Launchable', launchable: false },
  ])

  let closeCalls: Array<{ processName: string; applicationId: string | undefined }> = []
  const closeBackend: AppCloseBackend = {
    id: 'test-app-close',
    testsOnly: true,
    close: async (processName, applicationId) => {
      closeCalls.push({ processName, applicationId })
      return {
        applicationId: applicationId ?? processName,
        terminated: true,
        verified: true,
        detail: `Terminated "${processName}".`,
      }
    },
  }

  beforeAll(async () => {
    agent = await startAgent({ roots: [ROOT], token: TOKEN, applications: apps, appClose: closeBackend, port: 0 })
  })

  afterAll(async () => {
    await agent.close()
  })

  it('app.list returns wire specs and NEVER leaks target paths', async () => {
    const res = await rpc(agent.baseUrl, 'app.list', undefined, TOKEN)
    const body = await asJson(res)
    expect('error' in body).toBe(false)
    if ('error' in body) return
    const { applications } = body.result as { applications: Array<Record<string, unknown>> }
    expect(applications.map((a) => a.applicationId).sort()).toEqual([
      'calculator',
      'locked',
      'notepad',
      'slowapp',
      'vanisher',
      'weird',
    ])
    for (const app of applications) {
      expect(app.target).toBeUndefined()
      expect(Object.keys(app).sort()).toEqual([
        'applicationId',
        'displayName',
        'enabled',
        'launchable',
        'name',
        'source',
      ])
    }
  })

  it('app.status observes a launchable app honestly (not running yet)', async () => {
    const res = await rpc(agent.baseUrl, 'app.status', { applicationId: 'notepad' }, TOKEN)
    const body = await asJson(res)
    expect('error' in body).toBe(false)
    if ('error' in body) return
    expect(body.result).toMatchObject({
      applicationId: 'notepad',
      source: 'configured',
      enabled: true,
      launchable: true,
      running: false,
      runningVerified: false,
    })
  })

  it('app.status for an unregistered app → not_found with path = applicationId', async () => {
    const res = await rpc(agent.baseUrl, 'app.status', { applicationId: 'ghost' }, TOKEN)
    const body = await asJson(res)
    expect(errorCode(body)).toBe('not_found')
    if ('error' in body) {
      expect((body.error.data as { path?: string } | undefined)?.path).toBe('ghost')
    }
  })

  it('app.launch verified round-trip reports started + verified + pid', async () => {
    const before = apps.launchCount('notepad')
    const res = await rpc(agent.baseUrl, 'app.launch', { applicationId: 'notepad' }, TOKEN)
    const body = await asJson(res)
    expect('error' in body).toBe(false)
    if ('error' in body) return
    expect(body.result).toMatchObject({ applicationId: 'notepad', started: true, verified: true })
    expect((body.result as { pid: number }).pid).toBeGreaterThan(0)
    expect(apps.launchCount('notepad')).toBe(before + 1)
  })

  it('app.launch reports started-but-unverified honestly for slow/vanishing apps', async () => {
    const slowBody = await asJson(await rpc(agent.baseUrl, 'app.launch', { applicationId: 'slowapp' }, TOKEN))
    if ('error' in slowBody) throw new Error('unexpected error')
    expect((slowBody.result as { verified: boolean }).verified).toBe(false)

    const vanishBody = await asJson(await rpc(agent.baseUrl, 'app.launch', { applicationId: 'vanisher' }, TOKEN))
    if ('error' in vanishBody) throw new Error('unexpected error')
    expect((vanishBody.result as { verified: boolean }).verified).toBe(false)
  })

  it('app.launch for a disabled app → permission_denied', async () => {
    const res = await rpc(agent.baseUrl, 'app.launch', { applicationId: 'locked' }, TOKEN)
    expect(errorCode(await asJson(res))).toBe('permission_denied')
  })

  it('app.launch for a non-launchable app → invalid_path', async () => {
    const res = await rpc(agent.baseUrl, 'app.launch', { applicationId: 'weird' }, TOKEN)
    expect(errorCode(await asJson(res))).toBe('invalid_path')
  })

  it('app.launch for an unregistered app → not_found', async () => {
    const res = await rpc(agent.baseUrl, 'app.launch', { applicationId: 'ghost' }, TOKEN)
    expect(errorCode(await asJson(res))).toBe('not_found')
  })

  it.each([
    ['missing param', undefined, 'missing'],
    ['non-string', { applicationId: 42 }, 'type'],
    ['oversize', { applicationId: 'a'.repeat(65) }, 'length'],
    ['illegal chars', { applicationId: 'a/b.exe' }, 'pattern'],
    ['unicode char', { applicationId: 'café' }, 'pattern'],
    ['empty', { applicationId: '' }, 'empty'],
  ])('rejects an invalid applicationId (%s) as malformed', async (_label, params, _reason) => {
    const res = await rpc(agent.baseUrl, 'app.status', params, TOKEN)
    expect(errorCode(await asJson(res))).toBe('malformed')
  })

  it('has NO arbitrary execution endpoint — app.execute and system.shell are unsupported', async () => {
    const exe = await rpc(agent.baseUrl, 'app.execute', { applicationId: 'notepad' }, TOKEN)
    expect(errorCode(await asJson(exe))).toBe('unsupported')
    const shell = await rpc(agent.baseUrl, 'system.shell', { command: 'calc' }, TOKEN)
    expect(errorCode(await asJson(shell))).toBe('unsupported')
  })

  it('launch incrementally changes status to running', async () => {
    await rpc(agent.baseUrl, 'app.launch', { applicationId: 'notepad' }, TOKEN)
    const res = await rpc(agent.baseUrl, 'app.status', { applicationId: 'notepad' }, TOKEN)
    const body = await asJson(res)
    if ('error' in body) throw new Error('unexpected error')
    expect(body.result).toMatchObject({ running: true, runningVerified: true })
  })

  // Phase 4.1: app.close must target the registry-resolved process image of
  // a registered applicationId — "close Calculator" (id "calculator") has to
  // terminate the "calc" process, never a literal "calculator" lookup.
  it('app.close resolves a registered applicationId to its process image name', async () => {
    closeCalls = []
    const res = await rpc(agent.baseUrl, 'app.close', { applicationId: 'calculator' }, TOKEN)
    const body = await asJson(res)
    expect('error' in body).toBe(false)
    if ('error' in body) return
    expect(body.result).toMatchObject({ applicationId: 'calculator', terminated: true, verified: true })
    expect(closeCalls).toEqual([{ processName: 'calc', applicationId: 'calculator' }])
  })

  it('app.close without a registered id → invalid_argument (never kills by arbitrary name)', async () => {
    const res = await rpc(agent.baseUrl, 'app.close', { applicationId: 'ghost' }, TOKEN)
    expect(errorCode(await asJson(res))).toBe('invalid_argument')
  })

  it('app.close still accepts an explicit literal processName (backward compatibility)', async () => {
    closeCalls = []
    const res = await rpc(agent.baseUrl, 'app.close', { processName: 'calc' }, TOKEN)
    const body = await asJson(res)
    expect('error' in body).toBe(false)
    if ('error' in body) return
    expect(closeCalls).toEqual([{ processName: 'calc', applicationId: 'calc' }])
  })
})

describe('agent application backend plumbing (Phase 1.3)', () => {
  it('production wires the REAL application backend, memory is tests-only', () => {
    expect(new MemoryAppBackend().testsOnly).toBe(true)
    expect(new MemoryAppBackend().id).toBe('memory-app')
    const real = new RealAppBackend(new AppRegistry({ discover: false }))
    expect(real.id).toBe('real-app')
    expect((real as ApplicationBackend).testsOnly).toBeUndefined()
  })
})

describe('window.* — observation protocol (Phase 1.4)', () => {
  let agent: Awaited<ReturnType<typeof startAgent>>
  const obs = new MemoryObsBackend([
    { windowId: '1001', title: 'Notepad', pid: 401, processName: 'notepad.exe', visible: true, minimized: false, maximized: false, bounds: { left: 0, top: 0, right: 400, bottom: 300 }, clientBounds: { left: 0, top: 32, right: 400, bottom: 300 } },
    { windowId: '1002', title: 'Hidden Helper', pid: 402, processName: 'helper.exe', visible: false, minimized: true, maximized: false },
    { windowId: '1003', title: 'Explorer', pid: 403, processName: 'explorer.exe', visible: true, minimized: false, maximized: true },
  ])

  beforeAll(async () => {
    agent = await startAgent({ roots: [ROOT], token: TOKEN, observation: obs, port: 0 })
  })

  afterAll(async () => {
    await agent.close()
  })

  it('window.list returns bound, deterministically ordered windows (visible first)', async () => {
    const res = await rpc(agent.baseUrl, 'window.list', undefined, TOKEN)
    const body = await asJson(res)
    expect('error' in body).toBe(false)
    if ('error' in body) return
    const { windows } = body.result as { windows: Array<Record<string, unknown>> }
    // Visible first (Explorer, Notepad by title), then hidden windows.
    expect(windows.map((w) => w.windowId)).toEqual(['1003', '1001', '1002'])
    const notepad = windows.find((w) => w.windowId === '1001')!
    expect(notepad.title).toBe('Notepad')
    expect((notepad as { pid: number }).pid).toBe(401)
    expect((notepad as { processName: string }).processName).toBe('notepad.exe')
    // clientBounds (the measured client area) round-trips from the backend.
    expect((notepad as { clientBounds: { left: number; top: number } }).clientBounds).toEqual({ left: 0, top: 32, right: 400, bottom: 300 })
    for (const w of windows) {
      // Observation records are struct-of-metadata only — never paths.
      expect(w.target).toBeUndefined()
      expect(JSON.stringify(w)).not.toMatch(/\\/)
    }
  })

  it('window.status inspects one window and reports bounds + state', async () => {
    const res = await rpc(agent.baseUrl, 'window.status', { windowId: '1003' }, TOKEN)
    const body = await asJson(res)
    expect('error' in body).toBe(false)
    if ('error' in body) return
    expect(body.result).toMatchObject({
      windowId: '1003',
      exists: true,
      title: 'Explorer',
      pid: 403,
      processName: 'explorer.exe',
      visible: true,
      minimized: false,
      maximized: true,
    })
  })

  it('window.status carries the measured clientBounds for a window that has them', async () => {
    const res = await rpc(agent.baseUrl, 'window.status', { windowId: '1001' }, TOKEN)
    const body = await asJson(res)
    expect('error' in body).toBe(false)
    if ('error' in body) return
    expect((body.result as { clientBounds: unknown }).clientBounds).toEqual({
      left: 0,
      top: 32,
      right: 400,
      bottom: 300,
    })
  })

  it('window.status for a disappeared window → not_found (never fabricated)', async () => {
    obs.close('1002')
    const res = await rpc(agent.baseUrl, 'window.status', { windowId: '1002' }, TOKEN)
    const body = await asJson(res)
    expect(errorCode(body)).toBe('not_found')
    if ('error' in body) expect((body.error.data as { path?: string } | undefined)?.path).toBe('1002')
  })

  it('desktop.screenshot returns a bounded PNG envelope with real bytes', async () => {
    const res = await rpc(agent.baseUrl, 'desktop.screenshot', undefined, TOKEN)
    const body = await asJson(res)
    expect('error' in body).toBe(false)
    if ('error' in body) return
    const shot = body.result as { width: number; height: number; format: string; bytesLength: number; bytes: string }
    expect(shot.format).toBe('png')
    expect(shot.width).toBe(2)
    expect(shot.height).toBe(2)
    expect(shot.bytesLength).toBeGreaterThan(0)
    expect(Buffer.from(shot.bytes, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  it.each([
    ['missing param', undefined, 'missing'],
    ['non-string', { windowId: 42 }, 'type'],
    ['oversize', { windowId: '1'.repeat(11) }, 'length'],
    ['pointer-ish', { windowId: '0x1A2B' }, 'pattern'],
    ['path-ish', { windowId: 'C:\\windows' }, 'pattern'],
    ['empty', { windowId: '' }, 'empty'],
  ])('rejects an invalid windowId (%s) as malformed', async (_label, params, _reason) => {
    const res = await rpc(agent.baseUrl, 'window.status', params, TOKEN)
    expect(errorCode(await asJson(res))).toBe('malformed')
  })

  it('rejects observation EXECUTION verbs as unsupported — observation only', async () => {
    const moves = await rpc(agent.baseUrl, 'window.move', { windowId: '1001', x: 1 }, TOKEN)
    expect(errorCode(await asJson(moves))).toBe('unsupported')
    const minimize = await rpc(agent.baseUrl, 'window.minimize', { windowId: '1001' }, TOKEN)
    expect(errorCode(await asJson(minimize))).toBe('unsupported')
    const press = await rpc(agent.baseUrl, 'desktop.press', { key: 'A' }, TOKEN)
    expect(errorCode(await asJson(press))).toBe('unsupported')
  })
})

describe('agent observation backend plumbing (Phase 1.4)', () => {
  it('production wires the REAL FFI observation backend, memory is tests-only', () => {
    expect(new MemoryObsBackend().testsOnly).toBe(true)
    expect(new MemoryObsBackend().id).toBe('memory-obs')
    const real = new RealObsBackend()
    expect(real.id).toBe('real-obs')
    expect((real as ObservationBackend).testsOnly).toBeUndefined()
  })
})