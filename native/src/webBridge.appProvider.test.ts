import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { startAgent } from './agent.js'
import { MemoryAppBackend } from './testingApps.js'
import { NativeWindowsApplicationProvider } from '../../src/native/NativeWindowsApplicationProvider'
import { NativeAgentRpc } from '../../src/native/nativeRpc'
import { FileSystemError } from '../../src/filesystem'
import { startNativeBroker } from '../test-support/startNativeBroker.js'

/**
 * Phase 1.3 — the WEB application bridge provider against a LIVE local agent.
 *
 * Lives under native/ (not src/) because it imports the agent runtime
 * (node:http); it is excluded from `npx tsc -p native/tsconfig.json` and still
 * runs under vitest. The provider under test is the browser-side
 * `NativeWindowsApplicationProvider`; the backend is the deterministic
 * `MemoryAppBackend` so nothing spawns a real process. Same shared RPC layer
 * as the filesystem bridge.
 */

const ROOT = 'C:\\JARVIS\\workspace'
const TOKEN = 'app-bridge-token'

describe('web bridge application provider — live local agent (deterministic memory backend)', () => {
  let agent: Awaited<ReturnType<typeof startAgent>>
  let broker: Awaited<ReturnType<typeof startNativeBroker>>
  let memory: MemoryAppBackend
  let provider: NativeWindowsApplicationProvider

  beforeAll(async () => {
    memory = new MemoryAppBackend([
      { applicationId: 'notepad', name: 'Notepad', source: 'configured' },
      { applicationId: 'calculator', name: 'Calculator', source: 'discovered', launchRule: 'unverified' },
      { applicationId: 'disabled-app', name: 'Disabled', enabled: false },
      { applicationId: 'unlaunchable', name: 'Unlaunchable', launchable: false },
    ])
    agent = await startAgent({ roots: [ROOT], token: TOKEN, applications: memory, port: 0 })
    broker = await startNativeBroker(agent.baseUrl, TOKEN)
    provider = new NativeWindowsApplicationProvider(new NativeAgentRpc({ baseUrl: broker.baseUrl, fetchImpl: broker.fetchImpl, requestTimeoutMs: 2000 }))
    await provider.refreshNativeStatus()
  })

  afterAll(async () => {
    await broker.close()
    await agent.close()
  })

  it('probes the agent and reports honest capabilities', () => {
    const caps = provider.capabilities()
    expect(caps.available).toBe(true)
    expect(caps.reason).toBeUndefined()
    expect(caps.ops.list).toBe(true)
    expect(caps.ops.status).toBe(true)
    expect(caps.ops.launch).toBe(true)
  })

  it('lists approved apps with metadata, never exposing target paths', async () => {
    const apps = await provider.list()
    expect(apps.map((a) => a.applicationId).sort()).toEqual(['calculator', 'disabled-app', 'notepad', 'unlaunchable'])
    const notepad = apps.find((a) => a.applicationId === 'notepad')!
    expect(notepad.source).toBe('configured')
    expect(notepad.launchable).toBe(true)
    const calculator = apps.find((a) => a.applicationId === 'calculator')!
    expect(calculator.source).toBe('discovered')
    expect(JSON.stringify(apps)).not.toMatch(/\.exe|target|C:\\|System32/i)
  })

  it('reports honest running state before any launch (memory backend verbatim)', async () => {
    const status = await provider.status('notepad')
    expect(status.running).toBe(false)
    expect(status.runningVerified).toBe(false)
    expect(status.applicationId).toBe('notepad')
  })

  it('launches a verified app, observes the pid, and reflects running status', async () => {
    const result = await provider.launch('notepad')
    expect(result.started).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.pid).toBeGreaterThan(0)
    expect(result.detail).toMatch(/verified running/)
    expect(memory.launchCount('notepad')).toBe(1)

    const status = await provider.status('notepad')
    expect(status.running).toBe(true)
    expect(status.runningVerified).toBe(true)
  })

  it('never claims confirmation when observation was unverified', async () => {
    const result = await provider.launch('calculator')
    expect(result.started).toBe(true)
    expect(result.verified).toBe(false)
    expect(result.detail).toMatch(/could not be verified/)
    const status = await provider.status('calculator')
    expect(status.running).toBe(true)
    expect(status.runningVerified).toBe(false)
  })

  it('maps agent error envelopes onto structured FileSystemError kinds', async () => {
    await expect(provider.status('unknown')).rejects.toMatchObject({ name: 'FileSystemError', kind: 'not_found' })
    await expect(provider.launch('disabled-app')).rejects.toMatchObject({ name: 'FileSystemError', kind: 'permission_denied' })
    await expect(provider.launch('unlaunchable')).rejects.toMatchObject({ name: 'FileSystemError', kind: 'invalid_path' })
    // Invalid ids are rejected by the agent (malformed) before any backend is touched.
    await expect(provider.status('a/b.exe')).rejects.toBeInstanceOf(FileSystemError)
  })

  it('accepts ids the agent trims just like the tool layer does', async () => {
    const status = await provider.status('  notepad  ')
    expect(status.applicationId).toBe('notepad')
  })

  it('reports failure honestly when the agent goes away, and reconnects', async () => {
    await agent.close()

    await provider.refreshNativeStatus()
    expect(provider.capabilities().available).toBe(false)
    expect(provider.capabilities().reason).toBeDefined()
    await expect(provider.list()).rejects.toMatchObject({ name: 'FileSystemError', kind: 'unavailable' })

    await new Promise<void>((resolve) => agent.server.listen(agent.port, '127.0.0.1', () => resolve()))
    await provider.refreshNativeStatus()
    expect(provider.capabilities().available).toBe(true)
  })
})
