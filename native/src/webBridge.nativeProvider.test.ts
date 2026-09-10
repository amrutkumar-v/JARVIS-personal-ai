import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { startAgent } from './agent.js'
import { MemoryFsBackend } from './testingBackend.js'
import { NativeWindowsFileSystemProvider } from '../../src/native/NativeWindowsFileSystemProvider'
import type { NativeBridgeOptions } from '../../src/native/NativeWindowsFileSystemProvider'

/**
 * Phase 1.2 — the WEB bridge provider against a LIVE local agent.
 *
 * Lives under native/ (not src/) because it imports the agent runtime
 * (node:http); xs: it is excluded from `npx tsc -p native/tsconfig.json` and
 * still runs under vitest. The provider under test is the browser-side
 * `NativeWindowsFileSystemProvider`; the backend is the deterministic
 * in-memory one so nothing touches a real disk.
 */

const ROOT = 'C:\\JARVIS\\workspace'
const TOKEN = 'bridge-token'

describe('web bridge provider — live local agent (deterministic in-memory backend)', () => {
  let agent: Awaited<ReturnType<typeof startAgent>>
  let memory: MemoryFsBackend
  let provider: NativeWindowsFileSystemProvider

  beforeAll(async () => {
    memory = new MemoryFsBackend()
    agent = await startAgent({ roots: [ROOT], token: TOKEN, backend: memory, port: 0 })
    provider = new NativeWindowsFileSystemProvider({
      baseUrl: agent.baseUrl,
      token: TOKEN,
      requestTimeoutMs: 2000,
    })
    await provider.refreshNativeStatus()
  })

  afterAll(async () => {
    await agent.close()
  })

  it('probes the agent and reports identity status', async () => {
    const status = provider.nativeStatus()
    expect(status?.connected).toBe(true)
    expect(status?.version).toBeDefined()
    expect(status?.roots).toEqual([ROOT])
    expect(status?.platform).toBe('win32')
  })

  it('exposes reachable capabilities while connected', () => {
    const caps = provider.capabilities()
    expect(caps.available).toBe(true)
    expect(caps.hasApi).toBe(true)
    expect(caps.rootGranted).toBe(true)
    expect(caps.reason).toBeUndefined()
    for (const op of ['status', 'list', 'search', 'stat', 'read', 'mkdir', 'write', 'copy', 'move', 'rename', 'delete']) {
      expect(caps.ops[op as keyof typeof caps.ops]).toBe(true)
    }
  })

  it('performs a full FileSystemProvider round-trip through the live agent', async () => {
    await provider.mkdir('notes')
    const stats = await provider.writeText('notes/todo.txt', 'hello bridge')
    expect(stats).toMatchObject({ bytes: 12 })
    const read = await provider.readText('notes/todo.txt')
    expect(read.content).toBe('hello bridge')
    const list = await provider.list('notes')
    expect(list.map((n) => n.path)).toEqual(['notes/todo.txt'])
    const stat = await provider.stat('notes')
    expect(stat.kind).toBe('directory')
    await provider.move('notes/todo.txt', 'notes/done.txt')
    await provider.rename('notes/done.txt', 'final.txt')
    await provider.copy('notes/final.txt', 'notes/copy.txt')
    await provider.remove('notes/copy.txt')
    const left = (await provider.list('notes')).map((n) => n.path)
    expect(left).toEqual(['notes/final.txt'])
  })

  it('maps agent error envelopes to FileSystemError kinds', async () => {
    await expect(provider.readText('missing.txt')).rejects.toMatchObject({ name: 'FileSystemError', kind: 'not_found' })
    await provider.writeText('notes/exists.txt', 'x')
    await expect(provider.writeText('notes/exists.txt', 'y', { overwrite: false }))
      .rejects.toMatchObject({ name: 'FileSystemError', kind: 'exists' })
    await provider.mkdir('to-remove')
    await provider.writeText('to-remove/keep.txt', 'k')
    await expect(provider.remove('to-remove', { recursive: false })).rejects.toMatchObject({ name: 'FileSystemError', kind: 'io' })
  })

  it('reports failure honestly when the agent goes away, and reconnects', async () => {
    await agent.close()

    await provider.refreshNativeStatus()
    expect(provider.nativeStatus()?.connected).toBe(false)
    expect(provider.capabilities().available).toBe(false)
    expect(provider.capabilities().hasApi).toBe(false)
    await expect(provider.readText('missing.txt')).rejects.toMatchObject({ name: 'FileSystemError', kind: 'unavailable' })

    await new Promise<void>((resolve) => agent.server.listen(agent.port, '127.0.0.1', () => resolve()))
    await provider.refreshNativeStatus()
    expect(provider.nativeStatus()?.connected).toBe(true)
    expect(provider.capabilities().available).toBe(true)
  })
})

describe('web bridge provider — failure honesty with injected fetches', () => {
  it('degrades unreadable/malformed responses to a structured unavailable', async () => {
    const bogus = new ProviderForFetch(async () => new Response('not-json', { status: 200 }))
    const status = await bogus.refreshNativeStatus()
    expect(status.connected).toBe(false)
    await expect(bogus.readText('x.txt')).rejects.toMatchObject({ name: 'FileSystemError', kind: 'unavailable' })
  })

  it('sets timeout when the agent never answers', async () => {
    const hanging = new ProviderForFetch(async (_url, init) => {
      if (init.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }, { requestTimeoutMs: 60, probeTimeoutMs: 60 })
    await expect(hanging.readText('x.txt')).rejects.toMatchObject({ name: 'FileSystemError', kind: 'timeout' })
  })

  it('maps escape codes to permission_denied at the bridge', async () => {
    const mapped = new ProviderForFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { id: number }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: 'outside_allowed_root', message: 'Outside the allowed root.' } }), { status: 200 })
    })
    await expect(mapped.readText('x.txt')).rejects.toMatchObject({ name: 'FileSystemError', kind: 'permission_denied' })
  })
})

class ProviderForFetch extends NativeWindowsFileSystemProvider {
  constructor(fetchImpl: NonNullable<NativeBridgeOptions['fetchImpl']>, options: NativeBridgeOptions = {}) {
    super({ ...options, fetchImpl })
  }
}