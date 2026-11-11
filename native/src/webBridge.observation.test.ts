import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { startAgent } from './agent.js'
import { MemoryObsBackend } from './testingObs.js'
import { NativeWindowsObservationProvider } from '../../src/native/NativeWindowsObservationProvider'
import { NativeAgentRpc } from '../../src/native/nativeRpc'
import { FileSystemError } from '../../src/filesystem'
import { startNativeBroker } from '../test-support/startNativeBroker.js'

/**
 * Phase 1.4 — the WEB observation bridge provider against a LIVE local agent.
 *
 * Lives under native/ (not src/) because it imports the agent runtime
 * (node:http); it is excluded from `npx tsc -p native/tsconfig.json` and still
 * runs under vitest. The provider under test is the browser-side
 * `NativeWindowsObservationProvider`; the backend is the deterministic
 * `MemoryObsBackend` so nothing touches the real desktop. Same shared RPC
 * layer as the filesystem + application bridges.
 */

const ROOT = 'C:\\JARVIS\\workspace'
const TOKEN = 'observation-bridge-token'

describe('web bridge observation provider — live local agent (deterministic memory backend)', () => {
  let agent: Awaited<ReturnType<typeof startAgent>>
  let broker: Awaited<ReturnType<typeof startNativeBroker>>
  let memory: MemoryObsBackend
  let provider: NativeWindowsObservationProvider

  beforeAll(async () => {
    memory = new MemoryObsBackend([
      { windowId: '1003', title: 'Explorer', pid: 300, processName: 'explorer.exe', visible: true },
      { windowId: '1001', title: 'Notepad', pid: 401, processName: 'notepad.exe', visible: true, maximized: true, bounds: { left: 0, top: 0, right: 400, bottom: 300 }, clientBounds: { left: 0, top: 32, right: 400, bottom: 300 } },
      { windowId: '1002', title: 'Hidden Helper', pid: 500, processName: 'helper.exe', visible: false, minimized: true },
    ])
    agent = await startAgent({ roots: [ROOT], token: TOKEN, observation: memory, port: 0 })
    broker = await startNativeBroker(agent.baseUrl, TOKEN)
    provider = new NativeWindowsObservationProvider(new NativeAgentRpc({ baseUrl: broker.baseUrl, fetchImpl: broker.fetchImpl, requestTimeoutMs: 2000 }))
    await provider.refreshNativeStatus()
  })

  afterAll(async () => {
    await broker.close()
    await agent.close()
  })

  it('probes the agent and reports honest observation capabilities', () => {
    const caps = provider.capabilities()
    expect(caps.available).toBe(true)
    expect(caps.reason).toBeUndefined()
    expect(caps.hasApi).toBe(true)
    expect(caps.canListWindows).toBe(true)
    expect(caps.canInspectWindows).toBe(true)
    expect(caps.canCaptureScreenshots).toBe(true)
  })

  it('lists windows deterministically (visible first, then title), never exposing paths', async () => {
    const windows = await provider.listWindows()
    expect(windows.map((w) => w.windowId)).toEqual(['1003', '1001', '1002'])
    const notepad = windows.find((w) => w.windowId === '1001')!
    expect(notepad.title).toBe('Notepad')
    expect(notepad.pid).toBe(401)
    expect(notepad.processName).toBe('notepad.exe')
    expect(notepad.clientBounds).toEqual({ left: 0, top: 32, right: 400, bottom: 300 })
    expect(JSON.stringify(windows)).not.toMatch(/target|handle|hwnd|\\\\/i)
  })

  it('inspects one window and verifies it still exists', async () => {
    const status = await provider.getWindowStatus('1001')
    expect(status.exists).toBe(true)
    expect(status.visible).toBe(true)
    expect(status.maximized).toBe(true)
    expect(status.clientBounds).toEqual({ left: 0, top: 32, right: 400, bottom: 300 })
  })

  it('maps agent error envelopes onto structured FileSystemError kinds', async () => {
    await expect(provider.getWindowStatus('999999')).rejects.toMatchObject({ name: 'FileSystemError', kind: 'not_found' })
    // A stale/prefixed id never reaches the agent — blocked locally as invalid.
    await expect(provider.getWindowStatus('C:\\Windows\\explorer.exe')).rejects.toMatchObject({ name: 'FileSystemError', kind: 'invalid_path' })
    await expect(provider.getWindowStatus('0x1A2B')).rejects.toBeInstanceOf(FileSystemError)
  })

  it('captures a transient screenshot that verifies as a real bounded PNG', async () => {
    const shot = await provider.captureScreenshot()
    expect(shot.format).toBe('png')
    expect(shot.width).toBeGreaterThan(0)
    expect(shot.height).toBeGreaterThan(0)
    expect(shot.bytesLength).toBeGreaterThan(0)
    // bytesLength is the decoded PNG size; bytes carry the same data as base64.
    const pad = shot.bytes.endsWith('==') ? 2 : shot.bytes.endsWith('=') ? 1 : 0
    expect(Math.floor((shot.bytes.length * 3) / 4) - pad).toBe(shot.bytesLength)
    expect(shot.bytes.length).toBeLessThanOrEqual(6 * 1024 * 1024)
    // Transport-level structural check: it is a genuine PNG envelope.
    await expect(verifyLivePng(shot.bytes, shot.width, shot.height)).resolves.toBe(true)
  })

  it('reports failure honestly when the agent goes away, and reconnects', async () => {
    await agent.close()

    await provider.refreshNativeStatus()
    expect(provider.capabilities().available).toBe(false)
    expect(provider.capabilities().reason).toBeDefined()
    await expect(provider.listWindows()).rejects.toMatchObject({ name: 'FileSystemError', kind: 'unavailable' })

    await new Promise<void>((resolve) => agent.server.listen(agent.port, '127.0.0.1', () => resolve()))
    await provider.refreshNativeStatus()
    expect(provider.capabilities().available).toBe(true)
  })
})

/** Minimal structural PNG check (signature + header geometry) for the bridge test. */
async function verifyLivePng(base64: string, width: number, height: number): Promise<boolean> {
  const { verifyPngEnvelope } = await import('../../src/observation/pngVerify')
  const outcome = await verifyPngEnvelope(width, height, base64)
  return outcome.ok
}
