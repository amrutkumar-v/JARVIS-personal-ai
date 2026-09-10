import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { startAgent } from './agent.js'
import { MemoryDesktopBackend } from './testingDesktop.js'
import { NativeWindowsDesktopProvider } from '../../src/native/NativeWindowsDesktopProvider'
import { NativeAgentRpc } from '../../src/native/nativeRpc'
import { FileSystemError } from '../../src/filesystem'

/**
 * Phase 1.5 — the WEB desktop-interaction bridge provider against a LIVE local
 * agent.
 *
 * Lives under native/ (not src/) because it imports the agent runtime
 * (node:http); it is excluded from `npx tsc -p native/tsconfig.json` and still
 * runs under vitest. The provider under test is the browser-side
 * `NativeWindowsDesktopProvider`; the backend is the deterministic
 * `MemoryDesktopBackend` so nothing touches the real desktop. Same shared RPC
 * layer as the filesystem / application / observation bridges.
 */

const ROOT = 'C:\\JARVIS\\workspace'
const TOKEN = 'desktop-bridge-token'

describe('web bridge desktop provider — live local agent (deterministic memory backend)', () => {
  let agent: Awaited<ReturnType<typeof startAgent>>
  let desktop: MemoryDesktopBackend
  let provider: NativeWindowsDesktopProvider

  beforeAll(async () => {
    desktop = new MemoryDesktopBackend([
      { windowId: '1001', title: 'Notepad', visible: true, clientWidth: 640, clientHeight: 480 },
      { windowId: '1002', title: 'Hidden Helper', visible: false, minimized: true },
      { windowId: '1003', title: 'Denied Activation', visible: true, focusable: false },
    ])
    agent = await startAgent({ roots: [ROOT], token: TOKEN, desktop, port: 0 })
    provider = new NativeWindowsDesktopProvider(new NativeAgentRpc({ baseUrl: agent.baseUrl, token: TOKEN, requestTimeoutMs: 2000 }))
    await provider.refreshNativeStatus()
  })

  afterAll(async () => {
    await agent.close()
  })

  it('probes the agent and reports honest desktop capabilities + limits', () => {
    const caps = provider.capabilities()
    expect(caps.available).toBe(true)
    expect(caps.hasApi).toBe(true)
    expect(caps.reason).toBeUndefined()
    expect(caps.virtualScreen).toEqual({ left: 0, top: 0, width: 1920, height: 1080 })
    expect(caps.limits.maxHotkeyKeys).toBe(4)
    expect(caps.limits.maxTypeTextLength).toBe(2000)
    expect(caps.limits.maxScrollDelta).toBe(5000)
    expect(caps.ops.move).toBe(true)
    expect(caps.ops.type).toBe(true)
    expect(caps.ops.focus).toBe(true)
  })

  it('cursor reports a measured OS position', async () => {
    desktop.setCursor(120, 34)
    const cursor = await provider.cursor()
    expect(cursor).toEqual({ x: 120, y: 34, measured: true })
  })

  it('moveMouse uses ABSOLUTE screen coordinates and reports a verified position', async () => {
    const result = await provider.moveMouse(400, 300)
    expect(result).toMatchObject({ x: 400, y: 300, verified: true, cancelled: false })
    const cursor = await provider.cursor()
    expect(cursor).toMatchObject({ x: 400, y: 300 })
  })

  it('moveMouse outside the virtual desktop maps to invalid_path', async () => {
    await expect(provider.moveMouse(99999, 1)).rejects.toMatchObject({ name: 'FileSystemError', kind: 'invalid_path' })
  })

  it('click/double/right/scroll inject client-relative sequences into a target window', async () => {
    const before = desktop.interactionLog.length
    expect(await provider.click('1001', 100, 50)).toMatchObject({ windowId: '1001', x: 100, y: 50, injected: true })
    expect(await provider.doubleClick('1001', 2, 2)).toMatchObject({ windowId: '1001', injected: true })
    expect(await provider.rightClick('1001', 3, 3)).toMatchObject({ windowId: '1001', injected: true })
    const scroll = await provider.scroll('1001', 10, 10, 120)
    expect(scroll).toMatchObject({ windowId: '1001', delta: 120, injected: true })
    const names = desktop.interactionLog.slice(before).map((a) => a.name)
    expect(names).toEqual(['click', 'doubleClick', 'rightClick', 'scroll'])
  })

  it('maps agent errors onto structured FileSystemError kinds', async () => {
    // Vanished window.
    await expect(provider.click('999999', 1, 1)).rejects.toMatchObject({ name: 'FileSystemError', kind: 'not_found' })
    // Hidden / minimized window is not interactable.
    await expect(provider.click('1002', 1, 1)).rejects.toMatchObject({ name: 'FileSystemError', kind: 'unavailable' })
    // Client coordinate outside the ceiling.
    await expect(provider.click('1001', 6400000, 55)).rejects.toMatchObject({ name: 'FileSystemError', kind: 'invalid_path' })
    // A stale/prefixed id never reaches the agent — blocked locally as invalid.
    await expect(provider.click('C:\\Windows\\explorer.exe', 1, 1)).rejects.toBeInstanceOf(FileSystemError)
  })

  it('keyPress + hotkey inject allow-listed input; unsupported keys are structured', async () => {
    const press = await provider.keyPress('enter')
    expect(press).toMatchObject({ length: 1, injected: true })
    const combo = await provider.hotkey(['control', 'shift', 't'])
    expect(combo).toMatchObject({ length: 3, injected: true })
    await expect(provider.keyPress('win')).rejects.toMatchObject({ name: 'FileSystemError', kind: 'unsupported' })
  })

  it('typeText reports ONLY the injected length — the text never leaves the agent side', async () => {
    const secret = 'super-secret-handshake'
    const result = await provider.typeText(secret)
    expect(result).toMatchObject({ length: secret.length, injected: true, cancelled: false })
    // The web provider never echoes the text; JSON hygiene proves it.
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(provider.capabilities())).not.toContain(secret)
    // The memory backend log records the length only too.
    expect(JSON.stringify(desktop.interactionLog)).not.toContain(secret)
  })

  it('window.focus reflects the POST-attempt state honestly', async () => {
    const ok = await provider.focusWindow('1001')
    expect(ok).toMatchObject({ windowId: '1001', focused: true })
    expect(desktop.focusedWindowId).toBe('1001')

    const denied = await provider.focusWindow('1003')
    expect(denied).toMatchObject({ windowId: '1003', focused: false })
    expect(denied.detail.length).toBeGreaterThan(0)

    await expect(provider.focusWindow('999999')).rejects.toMatchObject({ name: 'FileSystemError', kind: 'not_found' })
  })

  it('reports failure honestly when the agent goes away, and reconnects', async () => {
    await agent.close()

    await provider.refreshNativeStatus()
    expect(provider.capabilities().available).toBe(false)
    expect(provider.capabilities().reason).toBeDefined()
    expect(provider.capabilities().ops.move).toBe(false)
    await expect(provider.cursor()).rejects.toMatchObject({ name: 'FileSystemError', kind: 'unavailable' })

    await new Promise<void>((resolve) => agent.server.listen(agent.port, '127.0.0.1', () => resolve()))
    await provider.refreshNativeStatus()
    expect(provider.capabilities().available).toBe(true)
    expect(provider.capabilities().ops.move).toBe(true)
  })
})