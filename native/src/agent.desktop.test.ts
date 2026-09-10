import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { startAgent } from './agent.js'
import type { NativeResponse } from './protocol.js'
import { DESKTOP_LIMITS } from './desktopLimits.js'
import { MemoryDesktopBackend } from './testingDesktop.js'
import { RealDesktopInteractionBackend } from './desktopInput.js'
import type { DesktopInteractionBackend } from './desktop.js'

const ROOT = 'C:\\JARVIS\\workspace'
const TOKEN = 'desktop-test-token'

async function rpc(baseUrl: string, method: string, params?: Record<string, unknown>, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  return fetch(`${baseUrl}/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

async function asJson(res: Response): Promise<NativeResponse> {
  return (await res.json()) as NativeResponse
}

const errorCode = (body: NativeResponse): string | undefined => ('error' in body ? body.error.code : undefined)
const resultOf = (body: NativeResponse): Record<string, unknown> => ('result' in body ? (body.result as Record<string, unknown>) : {})

describe('desktop.* — bounded input injection protocol (Phase 1.5)', () => {
  let agent: Awaited<ReturnType<typeof startAgent>>
  const desktop = new MemoryDesktopBackend([
    { windowId: '1001', title: 'Notepad', visible: true, minimized: false, clientWidth: 640, clientHeight: 480, focusable: true },
    { windowId: '1002', title: 'Hidden Helper', visible: false, minimized: true, clientWidth: 640, clientHeight: 480 },
    { windowId: '1003', title: 'Denied Window', visible: true, minimized: false, clientWidth: 640, clientHeight: 480, focusable: false },
  ])

  beforeAll(async () => {
    agent = await startAgent({ roots: [ROOT], token: TOKEN, desktop, port: 0 })
  })

  afterAll(async () => {
    await agent.close()
  })

  it('desktop.capabilities reports availability, the virtual desktop and the enforced limits', async () => {
    const res = await rpc(agent.baseUrl, 'desktop.capabilities', undefined, TOKEN)
    const body = await asJson(res)
    expect('error' in body).toBe(false)
    const caps = resultOf(body)
    expect(caps).toMatchObject({ available: true, hasApi: true })
    expect(caps.virtualScreen).toEqual({ left: 0, top: 0, width: 1920, height: 1080 })
    expect(caps.limits).toEqual({
      maxHotkeyKeys: DESKTOP_LIMITS.MAX_HOTKEY_KEYS,
      maxTypeTextLength: DESKTOP_LIMITS.MAX_TYPE_TEXT_LENGTH,
      maxScrollDelta: DESKTOP_LIMITS.MAX_SCROLL_DELTA,
      maxDesktopActionTimeMs: DESKTOP_LIMITS.MAX_DESKTOP_ACTION_TIME_MS,
      maxClientCoordinate: DESKTOP_LIMITS.MAX_CLIENT_COORDINATE,
      maxScreenCoordinate: DESKTOP_LIMITS.MAX_SCREEN_COORDINATE,
    })
  })

  it('desktop.cursor reports the measured cursor position', async () => {
    desktop.setCursor(120, 34)
    const res = await rpc(agent.baseUrl, 'desktop.cursor', undefined, TOKEN)
    const body = await asJson(res)
    expect('error' in body).toBe(false)
    expect(resultOf(body)).toEqual({ x: 120, y: 34, measured: true })
  })

  it('desktop.move moves to absolute SCREEN coordinates and verifies the position', async () => {
    const res = await rpc(agent.baseUrl, 'desktop.move', { x: 400, y: 300 }, TOKEN)
    const body = await asJson(res)
    expect('error' in body).toBe(false)
    expect(resultOf(body)).toEqual({ x: 400, y: 300, verified: true, cancelled: false })
    const cursor = desktop.cursor()
    expect(await cursor).toMatchObject({ x: 400, y: 300 })
  })

  it('desktop.move outside the virtual desktop is rejected as coordinate_out_of_bounds', async () => {
    const res = await rpc(agent.baseUrl, 'desktop.move', { x: 99999, y: 1 }, TOKEN)
    expect(errorCode(await asJson(res))).toBe('coordinate_out_of_bounds')
  })

  it('desktop.click injects a single left click at client-relative coordinates', async () => {
    const before = desktop.interactionLog.length
    const res = await rpc(agent.baseUrl, 'desktop.click', { windowId: '1001', x: 100, y: 50 }, TOKEN)
    const body = await asJson(res)
    expect('error' in body).toBe(false)
    expect(resultOf(body)).toEqual({ windowId: '1001', x: 100, y: 50, injected: true, cancelled: false })
    expect(desktop.interactionLog.slice(before)).toEqual([{ name: 'click', windowId: '1001', injected: true }])
  })

  it('desktop.doubleClick and desktop.rightClick inject their sequences', async () => {
    const dbl = await asJson(await rpc(agent.baseUrl, 'desktop.doubleClick', { windowId: '1001', x: 1, y: 1 }, TOKEN))
    expect(resultOf(dbl)).toMatchObject({ injected: true })
    const right = await asJson(await rpc(agent.baseUrl, 'desktop.rightClick', { windowId: '1001', x: 2, y: 2 }, TOKEN))
    expect(resultOf(right)).toMatchObject({ injected: true })
  })

  it('desktop.scroll injects bounded wheel units and echoes the delta', async () => {
    const res = await asJson(await rpc(agent.baseUrl, 'desktop.scroll', { windowId: '1001', x: 10, y: 10, delta: 120 }, TOKEN))
    expect('error' in res).toBe(false)
    expect(resultOf(res)).toMatchObject({ windowId: '1001', delta: 120, injected: true })
  })

  it.each([
    ['delta beyond the bound', { windowId: '1001', x: 1, y: 1, delta: DESKTOP_LIMITS.MAX_SCROLL_DELTA + 1 }, 'too_large'],
    ['zero delta', { windowId: '1001', x: 1, y: 1, delta: 0 }, 'invalid_argument'],
    ['non-numeric delta', { windowId: '1001', x: 1, y: 1, delta: 'fast' }, 'invalid_argument'],
  ])('desktop.scroll rejects %s', async (_label, params, expected) => {
    const res = await rpc(agent.baseUrl, 'desktop.scroll', params, TOKEN)
    expect(errorCode(await asJson(res))).toBe(expected)
  })

  it('window-targeted actions reject vanished/minimized/invisible windows structurally', async () => {
    const gone = await asJson(await rpc(agent.baseUrl, 'desktop.click', { windowId: '999999', x: 1, y: 1 }, TOKEN))
    expect(errorCode(gone)).toBe('window_not_found')

    // 1002 was seeded invisible + minimized → structurally un-interactable.
    const hidden = await asJson(await rpc(agent.baseUrl, 'desktop.rightClick', { windowId: '1002', x: 1, y: 1 }, TOKEN))
    expect(errorCode(hidden)).toBe('window_not_interactable')
    const minimized = await asJson(await rpc(agent.baseUrl, 'desktop.click', { windowId: '1002', x: 1, y: 1 }, TOKEN))
    expect(errorCode(minimized)).toBe('window_not_interactable')
  })

  it('window-targeted actions reject points outside the client area', async () => {
    const res = await rpc(agent.baseUrl, 'desktop.click', { windowId: '1001', x: 640, y: 480 }, TOKEN)
    expect(errorCode(await asJson(res))).toBe('coordinate_out_of_bounds')
    const negative = await rpc(agent.baseUrl, 'desktop.scroll', { windowId: '1001', x: -1, y: 50, delta: 120 }, TOKEN)
    expect(errorCode(await asJson(negative))).toBe('coordinate_out_of_bounds')
  })

  it('desktop.keyPress injects allow-listed keys and rejects everything else', async () => {
    const res = await asJson(await rpc(agent.baseUrl, 'desktop.keyPress', { key: 'enter' }, TOKEN))
    expect('error' in res).toBe(false)
    expect(resultOf(res)).toMatchObject({ injected: true })

    for (const bad of ['win', 'windows', 'super', 'meta', 'fn', ''] as const) {
      const rejected = await rpc(agent.baseUrl, 'desktop.keyPress', { key: bad }, TOKEN)
      expect(errorCode(await asJson(rejected))).toBe('unsupported_key')
    }
    const nonString = await rpc(agent.baseUrl, 'desktop.keyPress', { key: 42 }, TOKEN)
    expect(errorCode(await asJson(nonString))).toBe('unsupported_key')
  })

  it('desktop.hotkey injects a bounded combination and validates every member', async () => {
    const ok = await asJson(await rpc(agent.baseUrl, 'desktop.hotkey', { keys: ['control', 'a'] }, TOKEN))
    expect('error' in ok).toBe(false)
    expect(resultOf(ok)).toMatchObject({ injected: true })

    const tooMany = await rpc(agent.baseUrl, 'desktop.hotkey', { keys: ['control', 'shift', 'alt', 'a', 'b'] }, TOKEN)
    expect(errorCode(await asJson(tooMany))).toBe('too_large')

    const badKey = await rpc(agent.baseUrl, 'desktop.hotkey', { keys: ['control', 'win'] }, TOKEN)
    expect(errorCode(await asJson(badKey))).toBe('unsupported_key')

    const empty = await rpc(agent.baseUrl, 'desktop.hotkey', { keys: [] }, TOKEN)
    expect(errorCode(await asJson(empty))).toBe('invalid_argument')
  })

  it('desktop.type injects bounded UNICODE text and the agent never echoes the text itself', async () => {
    const res = await asJson(await rpc(agent.baseUrl, 'desktop.type', { text: 'hello JARVIS' }, TOKEN))
    expect('error' in res).toBe(false)
    expect(resultOf(res)).toMatchObject({ injected: true, cancelled: false })
    expect(JSON.stringify(res)).not.toContain('hello JARVIS')
    // The interaction log records ONLY the length — the text itself never
    // exists in the agent, the log or the response.
    const log = desktop.interactionLog.filter((entry) => entry.name === 'type')
    expect(log.at(-1)).toMatchObject({ textLength: 12, injected: true })
    expect(JSON.stringify(log)).not.toContain('hello JARVIS')
  })

  it.each([
    ['oversize text', { text: 'x'.repeat(DESKTOP_LIMITS.MAX_TYPE_TEXT_LENGTH + 1) }, 'too_large'],
    ['empty text', { text: '' }, 'invalid_argument'],
    ['non-string text', { text: 42 }, 'invalid_argument'],
    ['control characters', { text: 'a\u0001b' }, 'invalid_argument'],
  ])('desktop.type rejects %s', async (_label, params, expected) => {
    const res = await rpc(agent.baseUrl, 'desktop.type', params, TOKEN)
    expect(errorCode(await asJson(res))).toBe(expected)
  })

  it('window.focus brings a focusable window to the foreground', async () => {
    const res = await asJson(await rpc(agent.baseUrl, 'window.focus', { windowId: '1001' }, TOKEN))
    expect('error' in res).toBe(false)
    expect(resultOf(res)).toMatchObject({ windowId: '1001', focused: true })
    expect(desktop.focusedWindowId).toBe('1001')
  })

  it('window.focus reports focused:false honestly when the OS denies activation', async () => {
    const res = await asJson(await rpc(agent.baseUrl, 'window.focus', { windowId: '1003' }, TOKEN))
    expect('error' in res).toBe(false)
    expect(resultOf(res)).toMatchObject({ windowId: '1003', focused: false })
    expect(typeof resultOf(res).detail).toBe('string')
  })

  it('window.focus for a vanished window → window_not_found', async () => {
    const res = await rpc(agent.baseUrl, 'window.focus', { windowId: '999999' }, TOKEN)
    expect(errorCode(await asJson(res))).toBe('window_not_found')
  })

  it.each([
    ['missing param', undefined, 'missing'],
    ['non-string', { windowId: 42 }, 'type'],
    ['oversize', { windowId: '1'.repeat(11) }, 'length'],
    ['pointer-ish', { windowId: '0x1A2B' }, 'pattern'],
    ['path-ish', { windowId: 'C:\\windows' }, 'pattern'],
    ['empty', { windowId: '' }, 'empty'],
  ])('rejects an invalid windowId (%s) as malformed on window-targeted verbs too', async (_label, params, _reason) => {
    const res = await rpc(agent.baseUrl, 'desktop.click', { ...params, x: 1, y: 1 }, TOKEN)
    expect(errorCode(await asJson(res))).toBe('malformed')
  })

  it('rejects input verbs never granted — no raw injection and no input capture', async () => {
    const press = await rpc(agent.baseUrl, 'desktop.input', { type: 'key', key: 'a' }, TOKEN)
    expect(errorCode(await asJson(press))).toBe('unsupported')
    const capture = await rpc(agent.baseUrl, 'desktop.world', {}, TOKEN)
    expect(errorCode(await asJson(capture))).toBe('unsupported')
  })
})

describe('desktop cancellation signal (backend seam, no wire exposure)', () => {
  const desktop = new MemoryDesktopBackend([{ windowId: '1', clientWidth: 100, clientHeight: 100 }])

  it('a cancelled action is recorded but produces NO input', async () => {
    expect(await desktop.moveMouse(10, 10, { cancelled: true })).toMatchObject({ cancelled: true, verified: false })
    expect(await desktop.click('1', 5, 5, { cancelled: true })).toMatchObject({ cancelled: true, injected: false })
    expect(await desktop.typeText('never typed', { cancelled: true })).toMatchObject({ cancelled: true, injected: false })
    expect(await desktop.hotkey(['control', 'a'], { cancelled: true })).toMatchObject({ cancelled: true, injected: false })
    expect(desktop.interactionLog).toEqual([
      { name: 'move', injected: false, cancelled: true },
      { name: 'click', windowId: '1', injected: false, cancelled: true },
      { name: 'type', textLength: 11, injected: false, cancelled: true },
      { name: 'hotkey', injected: false, cancelled: true },
    ])
  })

  it('a cancellation signal never mutates MECHANICAL-parameter validation in the backend', async () => {
    await expect(desktop.keyPress('win', { cancelled: true })).rejects.toMatchObject({ code: 'unsupported_key' })
    await expect(desktop.typeText('x'.repeat(DESKTOP_LIMITS.MAX_TYPE_TEXT_LENGTH + 1), { cancelled: true })).rejects.toMatchObject({
      code: 'too_large',
    })
    await expect(desktop.scroll('1', -5, 0, 120, { cancelled: true })).rejects.toMatchObject({ code: 'coordinate_out_of_bounds' })
  })
})

describe('desktop backend plumbing (Phase 1.5)', () => {
  it('production wires the REAL FFI input backend, memory is tests-only', () => {
    expect(new MemoryDesktopBackend().testsOnly).toBe(true)
    expect(new MemoryDesktopBackend().id).toBe('memory-desktop')
    const real = new RealDesktopInteractionBackend()
    expect(real.id).toBe('real-desktop')
    expect((real as unknown as DesktopInteractionBackend).testsOnly).toBeUndefined()
  })
})