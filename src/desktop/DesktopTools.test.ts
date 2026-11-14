import { describe, expect, it } from 'vitest'
import type { Tool, ToolResult } from '../tools/Tool'
import { createDesktopTools } from './DesktopTools'
import { FakeDesktopInteractionProvider } from './testing'
import {
  isDesktopKey,
  normalizeDesktopKey,
  parseClientCoord,
  parseHotkeyKeys,
  parseScreenCoord,
  parseScrollDelta,
  parseTypeText,
  sanitizeDesktopPayload,
} from './provider'
import { DESKTOP_LIMITS } from './limits'
import {
  DESKTOP_BUDGET,
  desktopBudgetBucket,
  desktopBudgetExceeded,
  desktopBudgetLabel,
} from './budget'

/**
 * Phase 1.5 — desktop-interaction tools + validation against the
 * deterministic in-memory provider: registration, per-coordinate rules
 * (screen vs client never mixed), honest injection reporting (verified only
 * when the OS confirms), typed-text non-echo discipline, and the pure
 * validation/budget/redaction helpers.
 */
const asTools = (): { tools: Map<string, Tool>; desktop: FakeDesktopInteractionProvider } => {
  const desktop = new FakeDesktopInteractionProvider([
    { windowId: '1001', title: 'Notepad', visible: true },
    { windowId: '1002', title: 'Hidden Helper', visible: false, minimized: true },
    { windowId: '1003', title: 'Denied Activation', visible: true, focusable: false },
  ])
  const tools = new Map(createDesktopTools(desktop).map((t) => [t.id, t]))
  return { tools, desktop }
}

const run = async (tool: Tool, params: Record<string, unknown>): Promise<ToolResult> =>
  tool.execute({ query: 'test', params }, { requestId: 'r1' })

describe('desktop tools — registration + capability', () => {
  it('creates exactly the 13 desktop/window-focus tools (no other ids)', () => {
    const { tools } = asTools()
    expect([...tools.keys()].sort()).toEqual(
      [
        'desktop.click',
        'desktop.cursor',
        'desktop.double_click',
        'desktop.hotkey',
        'desktop.key_press',
        'desktop.move',
        'desktop.right_click',
        'desktop.scroll',
        'desktop.type',
        'window.focus',
        'window.maximize',
        'window.minimize',
        'window.restore',
      ].sort(),
    )
  })

  it('produces NO tools when the provider is undefined (browser mode)', () => {
    expect(createDesktopTools(undefined)).toEqual([])
  })

  it('marks every injectable tool not verifiable except move (cursor) and focus', () => {
    const { tools } = asTools()
    for (const id of ['desktop.move', 'window.focus']) {
      expect(tools.get(id)?.verifiable).toBe(true)
    }
    for (const id of ['desktop.click', 'desktop.double_click', 'desktop.right_click', 'desktop.scroll', 'desktop.key_press', 'desktop.hotkey', 'desktop.type']) {
      expect(tools.get(id)?.verifiable).toBe(false)
    }
  })

  it('marks all input tools low_risk and cursor read_only, none require permission', () => {
    const { tools } = asTools()
    expect(tools.get('desktop.cursor')?.permission).toBe('read_only')
    for (const id of ['desktop.move', 'desktop.click', 'desktop.double_click', 'desktop.right_click', 'desktop.scroll', 'desktop.key_press', 'desktop.hotkey', 'desktop.type', 'window.focus']) {
      expect(tools.get(id)?.permission).toBe('low_risk')
      expect(tools.get(id)?.requiresPermission).toBe(false)
    }
  })

  it('tools are honest about availability blockers', async () => {
    const { tools } = asTools()
    const blocked = tools.get('desktop.click')!
    const offline = new FakeDesktopInteractionProvider([])
    offline.setAvailable(false, 'Test offline.')
    const offlineTools = new Map(createDesktopTools(offline).map((t) => [t.id, t]))
    const result = await offlineTools.get('desktop.click')!.execute({ query: '', params: { window_id: '1', x: 0, y: 0 } }, { requestId: 'r' })
    expect(result.ok).toBe(false)
    expect(result.data).toMatchObject({ available: false, reason: 'Test offline.' })
    void blocked
  })
})

describe('desktop.cursor + desktop.move (screen coordinates, never mixed)', () => {
  it('cursor reports the measured position', async () => {
    const { tools, desktop } = asTools()
    desktop.setCursor(120, 34)
    const r = await run(tools.get('desktop.cursor')!, {})
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({ x: 120, y: 34, measured: true })
  })

  it('move uses ABSOLUTE screen coords and reports a verified OS position', async () => {
    const { tools, desktop } = asTools()
    const r = await run(tools.get('desktop.move')!, { x: 400, y: 300 })
    expect(r.ok).toBe(true)
    expect(desktop.calls.move).toBe(1)
    expect(r.data).toMatchObject({ x: 400, y: 300, verified: true })
    expect(await desktop.cursor()).toMatchObject({ x: 400, y: 300 })
  })

  it('move rejects a point outside the virtual desktop before any injection', async () => {
    const { tools, desktop } = asTools()
    desktop.setVirtualScreen({ left: 0, top: 0, width: 1920, height: 1080 })
    const r = await run(tools.get('desktop.move')!, { x: 99999, y: 1 })
    expect(r.ok).toBe(false)
    expect(r.data).toMatchObject({ kind: 'invalid_path' })
    expect(desktop.calls.move).toBe(0)
  })
})

describe('desktop click/double/right/scroll — client-relative, window-targeted', () => {
  it('click injects a single client-relative left click and reports not-confirmed', async () => {
    const { tools } = asTools()
    const r = await run(tools.get('desktop.click')!, { window_id: '1001', x: 100, y: 50 })
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/not confirmed/i)
    expect(r.data).toMatchObject({ windowId: '1001', x: 100, y: 50, injected: true, cancelled: false })
  })

  it('click requires a visible, non-minimized window', async () => {
    const { tools } = asTools()
    const hidden = await run(tools.get('desktop.click')!, { window_id: '1002', x: 1, y: 1 })
    expect(hidden.ok).toBe(false)
    expect(hidden.data).toMatchObject({ kind: 'unavailable' })
  })

  it('double_click and right_click inject their sequences', async () => {
    const { tools, desktop } = asTools()
    const dbl = await run(tools.get('desktop.double_click')!, { window_id: '1001', x: 2, y: 2 })
    expect(dbl.ok).toBe(true)
    expect(desktop.calls.doubleClick).toBe(1)
    const right = await run(tools.get('desktop.right_click')!, { window_id: '1001', x: 3, y: 3 })
    expect(right.ok).toBe(true)
    expect(desktop.calls.rightClick).toBe(1)
  })

  it('scroll echoes a bounded delta and never truncates', async () => {
    const { tools, desktop } = asTools()
    const r = await run(tools.get('desktop.scroll')!, { window_id: '1001', x: 10, y: 10, delta: -120 })
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({ delta: -120, injected: true })
    expect(desktop.interactionLog.at(-1)).toMatchObject({ name: 'scroll', delta: -120 })
  })

  it('a vanished window is reported honestly as not found', async () => {
    const { tools, desktop } = asTools()
    desktop.close('1001')
    const r = await run(tools.get('desktop.click')!, { window_id: '1001', x: 1, y: 1 })
    expect(r.ok).toBe(false)
    expect(r.data).toMatchObject({ kind: 'not_found' })
  })

  it('click outside the coordinate ceiling is rejected before injection', async () => {
    const { tools, desktop } = asTools()
    const r = await run(tools.get('desktop.click')!, { window_id: '1001', x: 6400000, y: 55 })
    expect(r.ok).toBe(false)
    expect(r.data).toMatchObject({ kind: 'invalid_input' })
    expect(desktop.calls.click).toBe(0)
  })
})

describe('desktop.key_press / hotkey / type', () => {
  it('key_press injects an allow-listed key and echoes the canonical name', async () => {
    const { tools } = asTools()
    const r = await run(tools.get('desktop.key_press')!, { key: 'enter' })
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({ key: 'enter' })
  })

  it('key_press rejects an unsupported key before injection', async () => {
    const { tools, desktop } = asTools()
    const r = await run(tools.get('desktop.key_press')!, { key: 'win' })
    expect(r.ok).toBe(false)
    expect(r.data).toMatchObject({ kind: 'invalid_input' })
    expect(desktop.calls.keyPress).toBe(0)
  })

  it('hotkey injects a bounded combination', async () => {
    const { tools } = asTools()
    const r = await run(tools.get('desktop.hotkey')!, { keys: ['control', 'shift', 't'] })
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({ keys: ['control', 'shift', 't'] })
  })

  it('hotkey rejects more than MAX_HOTKEY_KEYS and unsupported members', async () => {
    const { tools } = asTools()
    const tooMany = await run(tools.get('desktop.hotkey')!, { keys: ['control', 'shift', 'alt', 'a', 'b'] })
    expect(tooMany.ok).toBe(false)
    const bad = await run(tools.get('desktop.hotkey')!, { keys: ['control', 'win'] })
    expect(bad.ok).toBe(false)
  })
})

describe('desktop.type — text is bounded, validated, and never echoed', () => {
  it('injects bounded text and reports only the character COUNT', async () => {
    const { tools, desktop } = asTools()
    const r = await run(tools.get('desktop.type')!, { text: 'hello JARVIS' })
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({ length: 12 })
    // The typed text must NOT appear anywhere in the result/message/data/JSON.
    expect(JSON.stringify(r)).not.toContain('hello')
    // Nor in the provider interaction log (length only).
    expect(desktop.interactionLog.at(-1)).toMatchObject({ name: 'type', textLength: 12 })
    expect(JSON.stringify(desktop.interactionLog)).not.toContain('hello')
    expect(JSON.stringify(desktop.interactionLog)).not.toContain('JARVIS')
  })

  it('rejects control characters (other than tab/newline) and over-long text', async () => {
    const { tools } = asTools()
    const control = await run(tools.get('desktop.type')!, { text: 'a\x02b' })
    expect(control.ok).toBe(false)
    const tooLong = await run(tools.get('desktop.type')!, { text: 'x'.repeat(DESKTOP_LIMITS.MAX_TYPE_TEXT_LENGTH + 1) })
    expect(tooLong.ok).toBe(false)
  })

  it('sanitizeDesktopPayload redacts typed text but leaves other payloads intact', () => {
    expect(sanitizeDesktopPayload('desktop.type', { text: 'secret' })).toEqual({ text: '[redacted]' })
    expect(sanitizeDesktopPayload('desktop.move', { x: 1, y: 2 })).toEqual({ x: 1, y: 2 })
    expect(sanitizeDesktopPayload('desktop.type', { text: 42 } as unknown as Record<string, unknown>)).toEqual({ text: 42 } as unknown as Record<string, unknown>)
  })
})

describe('window.focus — verified, honest', () => {
  it('focus reports focused:false honestly when the OS denies activation', async () => {
    const { tools } = asTools()
    const r = await run(tools.get('window.focus')!, { window_id: '1003' })
    expect(r.ok).toBe(false)
    expect(r.data).toMatchObject({ focused: false })
    expect(r.data).toEqual(expect.objectContaining({ detail: expect.any(String) }))
  })

  it('focus of an OK window is reported verified', async () => {
    const { tools, desktop } = asTools()
    const r = await run(tools.get('window.focus')!, { window_id: '1001' })
    expect(r.ok).toBe(true)
    expect(desktop.focusedWindowId).toBe('1001')
    expect(r.data).toMatchObject({ focused: true })
  })
})

describe('desktop validation + budget helpers (pure)', () => {
  it('key allow-list matches the native set (normalize/isDesktopKey)', () => {
    expect(isDesktopKey('enter')).toBe(true)
    expect(isDesktopKey('ctrl')).toBe(true) // alias
    expect(normalizeDesktopKey('ctrl')).toBe('control')
    expect(isDesktopKey('WIN')).toBe(false)
    expect(isDesktopKey(42)).toBe(false)
  })

  it('parseHotkeyKeys caps at MAX_HOTKEY_KEYS and validates members', () => {
    expect('keys' in parseHotkeyKeys(['control', 'a'])).toBe(true)
    expect('error' in parseHotkeyKeys(['control', 'shift', 'alt', 'a', 'b'])).toBe(true)
    expect(parseHotkeyKeys([] as unknown[], DESKTOP_LIMITS.MAX_HOTKEY_KEYS)).toMatchObject({ error: expect.stringMatching(/at least one/i) })
  })

  it('parseTypeText bounds length and rejects invalid control chars', () => {
    expect('text' in parseTypeText('ok', 2000)).toBe(true)
    expect(parseTypeText('x'.repeat(2001), 2000)).toMatchObject({ error: expect.stringMatching(/limited to/i) })
    expect(parseTypeText('a\x01b', 2000)).toMatchObject({ error: expect.stringMatching(/control/i) })
    // tab and newline are allowed.
    expect('text' in parseTypeText('a\tb\nc', 2000)).toBe(true)
  })

  it('parseClientCoord / parseScreenCoord / parseScrollDelta enforce their ceilings', () => {
    expect(parseClientCoord(5, 'x')).toEqual({ value: 5 })
    expect('error' in parseClientCoord(10_001, 'x', DESKTOP_LIMITS.MAX_CLIENT_COORDINATE)).toBe(true)
    expect(parseScreenCoord(-100, 'y')).toEqual({ value: -100 })
    expect('error' in parseScreenCoord(1_000_001, 'y', DESKTOP_LIMITS.MAX_SCREEN_COORDINATE)).toBe(true)
    expect(parseScrollDelta(120)).toEqual({ value: 120 })
    expect('error' in parseScrollDelta(0)).toBe(true)
    expect('error' in parseScrollDelta(5001, DESKTOP_LIMITS.MAX_SCROLL_DELTA)).toBe(true)
  })

  it('budget helpers classify, cap and label buckets', () => {
    expect(desktopBudgetBucket('desktop.move')).toBe('mouse')
    expect(desktopBudgetBucket('desktop.scroll')).toBe('mouse')
    expect(desktopBudgetBucket('desktop.key_press')).toBe('keys')
    expect(desktopBudgetBucket('desktop.type')).toBe('keys')
    expect(desktopBudgetBucket('desktop.cursor')).toBeUndefined()
    expect(desktopBudgetBucket('window.focus')).toBeUndefined()
    expect(desktopBudgetBucket('app.list')).toBeUndefined()
    expect(DESKTOP_BUDGET).toEqual({ mouse: 50, keys: 100 })
    expect(desktopBudgetExceeded('mouse', DESKTOP_BUDGET.mouse, 0)).toBe(true)
    expect(desktopBudgetExceeded('mouse', DESKTOP_BUDGET.mouse - 1, 0)).toBe(false)
    expect(desktopBudgetExceeded('keys', 0, DESKTOP_BUDGET.keys)).toBe(true)
    expect(desktopBudgetLabel('mouse')).toBe('mouse')
    expect(desktopBudgetLabel('keys')).toBe('keyboard')
  })

  it('window.minimize, window.maximize, and window.restore alter window state', async () => {
    const { tools } = asTools()
    const minTool = tools.get('window.minimize')!
    const maxTool = tools.get('window.maximize')!
    const resTool = tools.get('window.restore')!

    const minRes = await run(minTool, { window_id: '1001' })
    expect(minRes.ok).toBe(true)

    const maxRes = await run(maxTool, { window_id: '1001' })
    expect(maxRes.ok).toBe(true)

    const restoreRes = await run(resTool, { window_id: '1001' })
    expect(restoreRes.ok).toBe(true)
  })
})