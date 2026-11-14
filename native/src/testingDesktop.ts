import { nativeError } from './errors.js'
import { desktopKeyParam, hotkeyParams, typeTextParam } from './desktop.js'
import type { DesktopCancellationSignal, DesktopInteractionBackend } from './desktop.js'
import { DESKTOP_LIMITS } from './desktopLimits.js'
import type {
  NativeCursorResult,
  NativeDesktopActionResult,
  NativeDesktopCapabilitiesResult,
  NativeDesktopClickResult,
  NativeDesktopFocusResult,
  NativeDesktopMoveResult,
  NativeDesktopScrollResult,
  NativeDesktopWindowStateResult,
} from './protocol.js'

/**
 * Native Windows Agent — memory desktop input backend (Phase 1.5).
 *
 * `testsOnly: true`. Drives the protocol / web-bridge tests deterministically
 * WITHOUT touching the Win32 API — it simulates a virtual desktop, a cursor,
 * window registries and foreground-window semantics in memory. It applies the
 * SAME parameter validation as the real backend (key allow-list, type length,
 * scroll delta, coordinate ceilings), records every action in an
 * `interactionLog` (typed text is recorded ONLY as a length — the text itself
 * never exists in the log), and honors cancellation signals before acting.
 * It can never be bound by production wiring.
 */

export interface MemoryDesktopSeed {
  windowId: string
  title?: string
  visible?: boolean
  minimized?: boolean
  clientWidth?: number
  clientHeight?: number
  /** Whether `focusWindow` may succeed (default true). */
  focusable?: boolean
}

export interface MemoryDesktopActionRecord {
  name: 'move' | 'click' | 'doubleClick' | 'rightClick' | 'scroll' | 'keyPress' | 'hotkey' | 'type' | 'focus'
  windowId?: string
  injected?: boolean
  cancelled?: boolean
  /** For `type` actions only the LENGTH is recorded — the text never is. */
  textLength?: number
}

interface MemoryWindowState {
  windowId: string
  title: string
  visible: boolean
  minimized: boolean
  clientWidth: number
  clientHeight: number
  focusable: boolean
}

const DEFAULT_CLIENT_WIDTH = 640
const DEFAULT_CLIENT_HEIGHT = 480

function defaultWindow(windowId: string): MemoryWindowState {
  return {
    windowId,
    title: `Window ${windowId}`,
    visible: true,
    minimized: false,
    clientWidth: DEFAULT_CLIENT_WIDTH,
    clientHeight: DEFAULT_CLIENT_HEIGHT,
    focusable: true,
  }
}

export class MemoryDesktopBackend implements DesktopInteractionBackend {
  readonly id = 'memory-desktop'
  readonly testsOnly = true

  private readonly windows = new Map<string, MemoryWindowState>()
  private readonly actions: MemoryDesktopActionRecord[] = []

  private cursorX = 0
  private cursorY = 0
  private foreground: string | null = null
  private virtualScreen = { left: 0, top: 0, width: 1920, height: 1080 }

  constructor(seeds: MemoryDesktopSeed[] = [], virtualScreen?: { left: number; top: number; width: number; height: number }) {
    for (const seed of seeds) this.seed(seed)
    if (virtualScreen) this.virtualScreen = virtualScreen
  }

  /** Replace/insert a window seed. */
  seed(seed: MemoryDesktopSeed): void {
    this.windows.set(seed.windowId, {
      ...defaultWindow(seed.windowId),
      ...seed,
    })
  }

  /** Remove a window seed (simulates a window that disappeared). */
  close(windowId: string): void {
    this.windows.delete(windowId)
  }

  setCursor(x: number, y: number): void {
    this.cursorX = x
    this.cursorY = y
  }

  /** Ordered record of every action the backend performed/skipped. */
  get interactionLog(): readonly MemoryDesktopActionRecord[] {
    return this.actions
  }

  get focusedWindowId(): string | null {
    return this.foreground ?? null
  }

  private record(entry: MemoryDesktopActionRecord): void {
    this.actions.push(entry)
  }

  private windowOf(windowId: string): MemoryWindowState {
    const w = this.windows.get(windowId)
    if (!w) throw nativeError('window_not_found', `Window "${windowId}" no longer exists.`, windowId)
    if (!w.visible || w.minimized) {
      throw nativeError('window_not_interactable', `Window "${windowId}" is not visible or is minimized.`, windowId)
    }
    return w
  }

  private clientPoint(windowId: string, x: number, y: number): void {
    const w = this.windowOf(windowId)
    if (x < 0 || y < 0 || x >= w.clientWidth || y >= w.clientHeight) {
      throw nativeError('coordinate_out_of_bounds', `Point (${x}, ${y}) is outside the client area of window "${windowId}".`, windowId)
    }
  }

  private cancelled(signal?: DesktopCancellationSignal): boolean {
    return signal?.cancelled === true
  }

  async capabilities(): Promise<NativeDesktopCapabilitiesResult> {
    return {
      available: true,
      hasApi: true,
      virtualScreen: { ...this.virtualScreen },
      limits: {
        maxHotkeyKeys: DESKTOP_LIMITS.MAX_HOTKEY_KEYS,
        maxTypeTextLength: DESKTOP_LIMITS.MAX_TYPE_TEXT_LENGTH,
        maxScrollDelta: DESKTOP_LIMITS.MAX_SCROLL_DELTA,
        maxDesktopActionTimeMs: DESKTOP_LIMITS.MAX_DESKTOP_ACTION_TIME_MS,
        maxClientCoordinate: DESKTOP_LIMITS.MAX_CLIENT_COORDINATE,
        maxScreenCoordinate: DESKTOP_LIMITS.MAX_SCREEN_COORDINATE,
      },
    }
  }

  async cursor(): Promise<NativeCursorResult> {
    return { x: this.cursorX, y: this.cursorY, measured: true }
  }

  async moveMouse(x: number, y: number, signal?: DesktopCancellationSignal): Promise<NativeDesktopMoveResult> {
    const vs = this.virtualScreen
    if (x < vs.left || y < vs.top || x >= vs.left + vs.width || y >= vs.top + vs.height) {
      throw nativeError('coordinate_out_of_bounds', `Screen point (${x}, ${y}) is outside the virtual desktop.`)
    }
    if (this.cancelled(signal)) {
      this.record({ name: 'move', injected: false, cancelled: true })
      return { x: this.cursorX, y: this.cursorY, verified: false, cancelled: true }
    }
    this.cursorX = x
    this.cursorY = y
    this.record({ name: 'move', injected: true })
    return { x, y, verified: true, cancelled: false }
  }

  async click(windowId: string, x: number, y: number, signal?: DesktopCancellationSignal): Promise<NativeDesktopClickResult> {
    if (this.cancelled(signal)) {
      this.record({ name: 'click', windowId, injected: false, cancelled: true })
      return { windowId, x, y, injected: false, cancelled: true }
    }
    this.clientPoint(windowId, x, y)
    this.record({ name: 'click', windowId, injected: true })
    return { windowId, x, y, injected: true, cancelled: false }
  }

  async doubleClick(windowId: string, x: number, y: number, signal?: DesktopCancellationSignal): Promise<NativeDesktopClickResult> {
    if (this.cancelled(signal)) {
      this.record({ name: 'doubleClick', windowId, injected: false, cancelled: true })
      return { windowId, x, y, injected: false, cancelled: true }
    }
    this.clientPoint(windowId, x, y)
    this.record({ name: 'doubleClick', windowId, injected: true })
    return { windowId, x, y, injected: true, cancelled: false }
  }

  async rightClick(windowId: string, x: number, y: number, signal?: DesktopCancellationSignal): Promise<NativeDesktopClickResult> {
    if (this.cancelled(signal)) {
      this.record({ name: 'rightClick', windowId, injected: false, cancelled: true })
      return { windowId, x, y, injected: false, cancelled: true }
    }
    this.clientPoint(windowId, x, y)
    this.record({ name: 'rightClick', windowId, injected: true })
    return { windowId, x, y, injected: true, cancelled: false }
  }

  async scroll(
    windowId: string,
    x: number,
    y: number,
    delta: number,
    signal?: DesktopCancellationSignal,
  ): Promise<NativeDesktopScrollResult> {
    this.clientPoint(windowId, x, y)
    if (this.cancelled(signal)) {
      this.record({ name: 'scroll', windowId, injected: false, cancelled: true })
      return { windowId, x, y, delta, injected: false, cancelled: true }
    }
    this.record({ name: 'scroll', windowId, injected: true })
    return { windowId, x, y, delta, injected: true, cancelled: false }
  }

  async keyPress(key: string, signal?: DesktopCancellationSignal): Promise<NativeDesktopActionResult> {
    desktopKeyParam(key)
    if (this.cancelled(signal)) {
      this.record({ name: 'keyPress', injected: false, cancelled: true })
      return { injected: false, cancelled: true }
    }
    this.record({ name: 'keyPress', injected: true })
    return { injected: true, cancelled: false }
  }

  async hotkey(keys: string[], signal?: DesktopCancellationSignal): Promise<NativeDesktopActionResult> {
    hotkeyParams(keys)
    if (this.cancelled(signal)) {
      this.record({ name: 'hotkey', injected: false, cancelled: true })
      return { injected: false, cancelled: true }
    }
    this.record({ name: 'hotkey', injected: true })
    return { injected: true, cancelled: false }
  }

  async typeText(text: string, signal?: DesktopCancellationSignal): Promise<NativeDesktopActionResult> {
    typeTextParam(text)
    if (this.cancelled(signal)) {
      this.record({ name: 'type', textLength: text.length, injected: false, cancelled: true })
      return { injected: false, cancelled: true }
    }
    this.record({ name: 'type', textLength: text.length, injected: true })
    return { injected: true, cancelled: false }
  }

  async focusWindow(windowId: string): Promise<NativeDesktopFocusResult> {
    const w = this.windows.get(windowId)
    if (!w) throw nativeError('window_not_found', `Window "${windowId}" no longer exists.`, windowId)
    if (w.focusable) {
      this.foreground = windowId
      this.record({ name: 'focus', windowId, injected: true })
      return { windowId, focused: true, detail: 'The target window is the active foreground window.' }
    }
    this.record({ name: 'focus', windowId, injected: false })
    return { windowId, focused: false, detail: 'The target window could not be made foreground (simulated denial).' }
  }

  async minimizeWindow(windowId: string): Promise<NativeDesktopWindowStateResult> {
    const w = this.windows.get(windowId)
    if (!w) throw nativeError('window_not_found', `Window "${windowId}" no longer exists.`, windowId)
    w.minimized = true
    return { windowId, action: 'minimize', success: true, detail: 'Window was minimized.' }
  }

  async maximizeWindow(windowId: string): Promise<NativeDesktopWindowStateResult> {
    const w = this.windows.get(windowId)
    if (!w) throw nativeError('window_not_found', `Window "${windowId}" no longer exists.`, windowId)
    w.minimized = false
    return { windowId, action: 'maximize', success: true, detail: 'Window was maximized.' }
  }

  async restoreWindow(windowId: string): Promise<NativeDesktopWindowStateResult> {
    const w = this.windows.get(windowId)
    if (!w) throw nativeError('window_not_found', `Window "${windowId}" no longer exists.`, windowId)
    w.minimized = false
    return { windowId, action: 'restore', success: true, detail: 'Window was restored.' }
  }
}