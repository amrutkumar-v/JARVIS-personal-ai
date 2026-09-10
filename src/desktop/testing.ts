import { fsError } from '../filesystem'
import type {
  DesktopClickResult,
  DesktopCursorResult,
  DesktopFocusResult,
  DesktopKeyResult,
  DesktopMoveResult,
  DesktopScrollResult,
  VirtualScreen,
} from './provider'
import { isDesktopKey } from './provider'
import type { DesktopProvider } from './provider'
import { DESKTOP_LIMITS } from './limits'

/**
 * Deterministic in-memory desktop-interaction provider — TESTS ONLY.
 *
 * Never imported or constructed by production code (src/desktop/index.ts
 * deliberately does not export it); production default is the native bridge
 * (or `undefined` in browser mode) and an engine test proves the production
 * path never swaps in a fake. It exists so the desktop tools and the engine
 * seam can be exercised quickly and deterministically.
 *
 * Semantics mirror the native MemoryDesktopBackend wire behaviour:
 *   - moveMouse validates against the virtual desktop (invalid_path outside)
 *   - click/double/right/scroll require a live, visible, non-minimized window
 *   - keyPress/hotkey enforce the allow-list (unsupported otherwise)
 *   - typeText records ONLY textLength — the text never leaves this provider
 *   - focusWindow reports focused:false honestly when the target isn't
 *     focusable, and not_found for a vanished window
 *   - available=false → every op throws unavailable
 */
export interface DesktopSeed {
  windowId: string
  title?: string
  visible?: boolean
  minimized?: boolean
  maximized?: boolean
  bounds?: { left: number; top: number; right: number; bottom: number }
  /** False → focusWindow reports focused:false (OS-denied activation). */
  focusable?: boolean
  fail?: { op: string; code: 'io' | 'unavailable' | 'not_found' | 'invalid_path' | 'unsupported'; message?: string }
}

interface DesktopSeedState {
  title: string
  visible: boolean
  minimized: boolean
  maximized: boolean
  bounds?: { left: number; top: number; right: number; bottom: number }
  focusable: boolean
}

export interface InteractionLogEntry {
  name: string
  windowId?: string
  key?: string
  keys?: string[]
  x?: number
  y?: number
  delta?: number
  /** Length ONLY — typed text never appears in the log. */
  textLength?: number
  injected: boolean
  cancelled?: boolean
}

export class FakeDesktopInteractionProvider implements DesktopProvider {
  readonly id = 'fake-desktop'
  /** Positive marker so tests can assert production never swaps this in. */
  readonly testsOnly = true

  private readonly store = new Map<string, DesktopSeedState>()
  private readonly failures = new Map<string, NonNullable<DesktopSeed['fail']>>()
  private available = true
  private failureReason = 'Desktop interaction disabled for this test.'
  private cursorPos = { x: 0, y: 0 }
  private virtualScreen: VirtualScreen = { left: 0, top: 0, width: 1920, height: 1080 }
  private foregroundId: string | null = null

  /** Chronological record of every injected action (counts; never content). */
  readonly interactionLog: InteractionLogEntry[] = []
  /** Op counters so tests can prove a malformed call never ran. */
  readonly calls = { cursor: 0, move: 0, click: 0, doubleClick: 0, rightClick: 0, scroll: 0, keyPress: 0, hotkey: 0, type: 0, focus: 0 }

  constructor(seeds: DesktopSeed[] = [], virtualScreen?: VirtualScreen) {
    for (const seed of seeds) this.add(seed)
    this.setVirtualScreen(virtualScreen)
  }

  add(seed: DesktopSeed): void {
    this.store.set(seed.windowId, {
      title: seed.title ?? `Window ${seed.windowId}`,
      visible: seed.visible ?? true,
      minimized: seed.minimized ?? false,
      maximized: seed.maximized ?? false,
      bounds: seed.bounds,
      focusable: seed.focusable ?? true,
    })
    if (seed.fail) this.failures.set(seed.windowId, seed.fail)
  }

  /** Drop a window (tests the vanished-window path). */
  close(windowId: string): void {
    this.store.delete(windowId)
  }

  setVirtualScreen(screen?: VirtualScreen): void {
    if (screen) this.virtualScreen = { ...screen }
  }

  setCursor(x: number, y: number): void {
    this.cursorPos = { x, y }
  }

  /** The window most recently focused (or null). */
  get focusedWindowId(): string | null {
    return this.foregroundId
  }

  setAvailable(on: boolean, reason?: string): void {
    this.available = on
    if (!on) this.failureReason = reason ?? this.failureReason
  }

  capabilities() {
    const ops = {
      cursor: this.available,
      move: this.available,
      click: this.available,
      double_click: this.available,
      right_click: this.available,
      scroll: this.available,
      key_press: this.available,
      hotkey: this.available,
      type: this.available,
      focus: this.available,
    }
    const limits = {
      maxHotkeyKeys: DESKTOP_LIMITS.MAX_HOTKEY_KEYS,
      maxTypeTextLength: DESKTOP_LIMITS.MAX_TYPE_TEXT_LENGTH,
      maxScrollDelta: DESKTOP_LIMITS.MAX_SCROLL_DELTA,
      maxDesktopActionTimeMs: DESKTOP_LIMITS.MAX_DESKTOP_ACTION_TIME_MS,
      maxClientCoordinate: DESKTOP_LIMITS.MAX_CLIENT_COORDINATE,
      maxScreenCoordinate: DESKTOP_LIMITS.MAX_SCREEN_COORDINATE,
    }
    if (!this.available) {
      return { available: false, hasApi: false, reason: this.failureReason, limits, ops }
    }
    return { available: true, hasApi: true, virtualScreen: { ...this.virtualScreen }, limits, ops }
  }

  private throwIfClosed(): void {
    if (!this.available) throw fsError('unavailable', this.failureReason)
  }

  private requireWindow(windowId: string, windowKey: string): { id: string; state: DesktopSeedState } {
    this.throwIfClosed()
    const parsed = /^\d{1,10}$/.test(windowId) ? windowId : ''
    if (!parsed) throw fsError('invalid_path', 'windowId must be a plain decimal number.', windowId)
    const fail = this.failures.get(parsed)
    if (fail && fail.op === windowKey) {
      throw fsError(fail.code, fail.message ?? `Forced ${windowKey} failure for ${parsed}.`, parsed)
    }
    const state = this.store.get(parsed)
    if (!state) throw fsError('not_found', `Window ${parsed} does not exist.`, parsed)
    return { id: parsed, state }
  }

  private requireClickable(windowId: string, op: string, label: string): { id: string } {
    const win = this.requireWindow(windowId, 'pointer')
    if (!win.state.visible || win.state.minimized) {
      throw fsError('unavailable', `Window ${win.id} is not ${label} (it is not visible or is minimized).`, win.id)
    }
    void op
    return { id: win.id }
  }

  async cursor(): Promise<DesktopCursorResult> {
    this.throwIfClosed()
    this.calls.cursor += 1
    return { x: this.cursorPos.x, y: this.cursorPos.y, measured: true }
  }

  async moveMouse(x: number, y: number): Promise<DesktopMoveResult> {
    this.throwIfClosed()
    const vs = this.virtualScreen
    if (x < vs.left || y < vs.top || x >= vs.left + vs.width || y >= vs.top + vs.height) {
      throw fsError('invalid_path', `Screen point (${x}, ${y}) is outside the virtual desktop.`)
    }
    this.calls.move += 1
    this.cursorPos = { x, y }
    this.interactionLog.push({ name: 'move', x, y, injected: true })
    return { x, y, verified: true, cancelled: false }
  }

  async click(windowId: string, x: number, y: number): Promise<DesktopClickResult> {
    this.throwIfClosed()
    const win = this.requireClickable(windowId, 'click', 'interactable')
    this.calls.click += 1
    this.interactionLog.push({ name: 'click', windowId: win.id, x, y, injected: true })
    return { windowId: win.id, x, y, injected: true, cancelled: false }
  }

  async doubleClick(windowId: string, x: number, y: number): Promise<DesktopClickResult> {
    this.throwIfClosed()
    const win = this.requireClickable(windowId, 'doubleClick', 'interactable')
    this.calls.doubleClick += 1
    this.interactionLog.push({ name: 'doubleClick', windowId: win.id, x, y, injected: true })
    return { windowId: win.id, x, y, injected: true, cancelled: false }
  }

  async rightClick(windowId: string, x: number, y: number): Promise<DesktopClickResult> {
    this.throwIfClosed()
    const win = this.requireClickable(windowId, 'rightClick', 'interactable')
    this.calls.rightClick += 1
    this.interactionLog.push({ name: 'rightClick', windowId: win.id, x, y, injected: true })
    return { windowId: win.id, x, y, injected: true, cancelled: false }
  }

  async scroll(windowId: string, x: number, y: number, delta: number): Promise<DesktopScrollResult> {
    this.throwIfClosed()
    const win = this.requireClickable(windowId, 'scroll', 'interactable')
    this.calls.scroll += 1
    this.interactionLog.push({ name: 'scroll', windowId: win.id, x, y, delta, injected: true })
    return { windowId: win.id, x, y, delta, injected: true, cancelled: false }
  }

  async keyPress(key: string): Promise<DesktopKeyResult> {
    this.throwIfClosed()
    this.calls.keyPress += 1
    this.interactionLog.push({ name: 'key', key, injected: true })
    return { length: 1, injected: true, cancelled: false }
  }

  async hotkey(keys: string[]): Promise<DesktopKeyResult> {
    this.throwIfClosed()
    for (const key of keys) {
      if (!isDesktopKey(key)) throw fsError('unsupported', `The requested key "${key}" is not in the supported key allow-list.`)
    }
    this.calls.hotkey += 1
    this.interactionLog.push({ name: 'hotkey', keys, injected: true })
    return { length: keys.length, injected: true, cancelled: false }
  }

  async typeText(text: string): Promise<DesktopKeyResult> {
    this.throwIfClosed()
    this.calls.type += 1
    // Length ONLY — the text never appears in the log, a result or anywhere
    // a trace/plan could read it.
    this.interactionLog.push({ name: 'type', textLength: text.length, injected: true })
    return { length: text.length, injected: true, cancelled: false }
  }

  async focusWindow(windowId: string): Promise<DesktopFocusResult> {
    this.throwIfClosed()
    const win = this.requireWindow(windowId, 'focus')
    this.calls.focus += 1
    if (!win.state.focusable) {
      this.interactionLog.push({ name: 'focus', windowId: win.id, injected: false })
      return { windowId: win.id, focused: false, detail: 'The window is not focusable right now (activation was denied).' }
    }
    this.foregroundId = win.id
    this.interactionLog.push({ name: 'focus', windowId: win.id, injected: true })
    return { windowId: win.id, focused: true, detail: 'Confirmed as the foreground window.' }
  }
}