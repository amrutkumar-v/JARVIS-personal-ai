import * as koffiNS from 'koffi'

const koffi = (koffiNS as unknown as { default?: typeof koffiNS }).default ?? koffiNS
import { nativeError } from './errors.js'
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
import type { DesktopCancellationSignal, DesktopInteractionBackend } from './desktop.js'

/**
 * Native Windows Agent — user32 input bridge (Phase 1.5).
 *
 * HANDS: this layer injects REAL input through the Win32 SendInput /
 * SetCursorPos / SetForegroundWindow family via koffi FFI. It CANNOT read or
 * intercept anything: keystrokes are delivered to whatever window owns the
 * keyboard focus, and there is no shell, no injectable command token and no
 * "run" verb. Every operation is a single, bounded, synchronous action:
 *
 *   - `moveMouse` / `cursor`  — ABSOLUTE virtual-desktop screen coordinates.
 *   - click/double/right/scroll — window-REQUIRED, CLIENT-RELATIVE (0..w/0..h
 *     of the target window); resolved with GetClientRect + ClientToScreen.
 *   - keyPress / hotkey / typeText — delivered to the focused window.
 *
 * Honesty over claim: after injecting, the bridge reports only what it can
 * VERIFY (cursor moved to the requested point; window is foreground now).
 * Clicks and typing carry no semantic confirmation — callers must read the
 * screen. The WIN key is never produced; typed text never leaves this bridge
 * (no buffers, no logs); actions check a cancellation signal before acting
 * and a wall-clock budget that keeps single actions bounded.
 */
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1

const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_RIGHTDOWN = 0x0008
const MOUSEEVENTF_RIGHTUP = 0x0010
const MOUSEEVENTF_WHEEL = 0x0800
const WHEEL_DELTA = 120

const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004

const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79

const SW_MAXIMIZE = 3
const SW_MINIMIZE = 6
const SW_RESTORE = 9

type Input = {
  type: number
  u: {
    mi?: { dx: number; dy: number; mouseData: number; dwFlags: number; time: number; dwExtraInfo: bigint }
    ki?: { wVk: number; wScan: number; dwFlags: number; time: number; dwExtraInfo: bigint }
  }
}

/** The tiny typed surface of the Win32 input/foreground calls this bridge needs. */
interface Win32Input {
  virtualScreen(): { left: number; top: number; width: number; height: number }
  getCursorPos(): { x: number; y: number }
  setCursorPos(x: number, y: number): boolean
  isWindow(hwnd: bigint): boolean
  isWindowVisible(hwnd: bigint): boolean
  isIconic(hwnd: bigint): boolean
  getClientRect(hwnd: bigint): { left: number; top: number; right: number; bottom: number } | null
  clientToScreenOrigin(hwnd: bigint): { x: number; y: number }
  getForegroundWindow(): bigint
  setForegroundWindow(hwnd: bigint): boolean
  showWindow(hwnd: bigint, nCmdShow: number): boolean
  inject(inputs: Input[]): boolean
}

let api: Win32Input | null = null
let apiFailure: Error | null = null

/** Load + declare once; cached. Failures are sticky and honest. */
function getApi(): Win32Input {
  if (api) return api
  if (apiFailure) throw apiFailure
  if (process.platform !== 'win32') {
    apiFailure = nativeError('unsupported', 'Desktop input injection is only available on Windows.')
    throw apiFailure
  }

  try {
    // Type names that could collide with other bridge modules (BOOL, HWND,
    // ...) are deliberately NOT aliased; every signature uses inline built-ins.
    koffi.struct('DESK_MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'int64' })
    koffi.struct('DESK_KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'int64' })
    koffi.struct('DESK_HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' })
    koffi.union('DESK_UIUNION', { mi: 'DESK_MOUSEINPUT', ki: 'DESK_KEYBDINPUT', hi: 'DESK_HARDWAREINPUT' })
    koffi.struct('DESK_INPUT', { type: 'uint32', u: 'DESK_UIUNION' })

    const user32 = koffi.load('user32.dll')
    const SendInputFn = user32.func('uint SendInput(uint cInputs, DESK_INPUT *pInputs, int cbSize)')
    const SetCursorPosFn = user32.func('int SetCursorPos(int X, int Y)')
    const GetCursorPosFn = user32.func('int GetCursorPos(int *pt)')
    const IsWindowFn = user32.func('int IsWindow(uint64 hwnd)')
    const IsWindowVisibleFn = user32.func('int IsWindowVisible(uint64 hwnd)')
    const IsIconicFn = user32.func('int IsIconic(uint64 hwnd)')
    const GetClientRectFn = user32.func('int GetClientRect(uint64 hwnd, int *rect)')
    const ClientToScreenFn = user32.func('int ClientToScreen(uint64 hwnd, int *pt)')
    const GetForegroundWindowFn = user32.func('uint64 GetForegroundWindow()')
    const SetForegroundWindowFn = user32.func('int SetForegroundWindow(uint64 hwnd)')
    const ShowWindowFn = user32.func('int ShowWindow(uint64 hwnd, int nCmdShow)')
    const GetSystemMetricsFn = user32.func('int GetSystemMetrics(int nIndex)')

    const clientToScreenOrigin = (hwnd: bigint): { x: number; y: number } => {
      const pt = new Int32Array(2)
      const ok = ClientToScreenFn(hwnd, pt)
      if (!ok) throw nativeError('io_error', 'The window client origin could not be resolved to screen coordinates.')
      return { x: pt[0], y: pt[1] }
    }

    api = {
      virtualScreen() {
        return {
          left: GetSystemMetricsFn(SM_XVIRTUALSCREEN),
          top: GetSystemMetricsFn(SM_YVIRTUALSCREEN),
          width: GetSystemMetricsFn(SM_CXVIRTUALSCREEN),
          height: GetSystemMetricsFn(SM_CYVIRTUALSCREEN),
        }
      },
      getCursorPos() {
        const pt = new Int32Array(2)
        GetCursorPosFn(pt)
        return { x: pt[0], y: pt[1] }
      },
      setCursorPos(x, y) {
        return !!SetCursorPosFn(x, y)
      },
      isWindow(hwnd) {
        return !!IsWindowFn(hwnd)
      },
      isWindowVisible(hwnd) {
        return !!IsWindowVisibleFn(hwnd)
      },
      isIconic(hwnd) {
        return !!IsIconicFn(hwnd)
      },
      getClientRect(hwnd) {
        const rect = new Int32Array(4)
        const ok = GetClientRectFn(hwnd, rect)
        if (!ok) return null
        return { left: rect[0], top: rect[1], right: rect[2], bottom: rect[3] }
      },
      clientToScreenOrigin,
      getForegroundWindow() {
        return GetForegroundWindowFn()
      },
      setForegroundWindow(hwnd) {
        return !!SetForegroundWindowFn(hwnd)
      },
      showWindow(hwnd, nCmdShow) {
        return !!ShowWindowFn(hwnd, nCmdShow)
      },
      inject(inputs) {
        const count = SendInputFn(inputs.length, inputs, koffi.sizeof('DESK_INPUT'))
        return typeof count === 'number' && count === inputs.length
      },
    }
    return api
  } catch (error) {
    apiFailure = nativeError('native_unavailable', `The Win32 input bridge failed to initialize: ${explain(error)}`)
    throw apiFailure
  }
}

function explain(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Wall-clock budget guard: every desktop action is bounded and synchronous. */
function assertWithinTimeBudget(started: number): void {
  if (Date.now() - started > DESKTOP_LIMITS.MAX_DESKTOP_ACTION_TIME_MS) {
    throw nativeError('timeout', 'The desktop action exceeded its wall-clock budget.')
  }
}

function hwndOf(windowId: string): bigint {
  try {
    return BigInt(windowId)
  } catch {
    throw nativeError('malformed', 'Invalid "windowId".')
  }
}

function inputMouse(flags: number, mouseData = 0, dx = 0, dy = 0): Input {
  return { type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData, dwFlags: flags, time: 0, dwExtraInfo: 0n } } }
}

function inputKey(vk: number, flags: number): Input {
  return { type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0n } } }
}

function inputUnicode(code: number, flags: number): Input {
  return { type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: code, dwFlags: flags | KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0n } } }
}

/** Canonical key name -> virtual-key code + extended flag. Callers validated first. */
function keyVk(key: string): { vk: number; extended: boolean } {
  if (/^[a-z]$/.test(key)) return { vk: key.charCodeAt(0) - 0x20, extended: false }
  if (/^[0-9]$/.test(key)) return { vk: key.charCodeAt(0), extended: false }
  const fn = /^f([1-9]|1[0-2])$/.exec(key)
  if (fn) return { vk: 0x70 + Number(fn[1]) - 1, extended: false }
  const named: Record<string, { vk: number; extended?: boolean }> = {
    enter: { vk: 0x0d },
    tab: { vk: 0x09 },
    escape: { vk: 0x1b },
    space: { vk: 0x20 },
    backspace: { vk: 0x08 },
    delete: { vk: 0x2e, extended: true },
    home: { vk: 0x24, extended: true },
    end: { vk: 0x23, extended: true },
    pageup: { vk: 0x21, extended: true },
    pagedown: { vk: 0x22, extended: true },
    arrow_left: { vk: 0x25, extended: true },
    arrow_up: { vk: 0x26, extended: true },
    arrow_right: { vk: 0x27, extended: true },
    arrow_down: { vk: 0x28, extended: true },
    shift: { vk: 0x10 },
    control: { vk: 0x11 },
    alt: { vk: 0x12 },
    capslock: { vk: 0x14 },
  }
  const entry = named[key]
  return entry ? { vk: entry.vk, extended: entry.extended === true } : { vk: 0, extended: false }
}

/**
 * Resolve a window-targeted action: window must exist, be visible and not
 * minimized, and the client-relative (x, y) must be inside the client area.
 * Returns the screen-point the injected input must target.
 */
function windowPoint(windowId: string, x: number, y: number): { hwnd: bigint; screenX: number; screenY: number } {
  const obs = getApi()
  const hwnd = hwndOf(windowId)
  if (!obs.isWindow(hwnd)) {
    throw nativeError('window_not_found', `Window "${windowId}" no longer exists.`, windowId)
  }
  if (!obs.isWindowVisible(hwnd) || obs.isIconic(hwnd)) {
    throw nativeError('window_not_interactable', `Window "${windowId}" is not visible or is minimized.`, windowId)
  }
  const rect = obs.getClientRect(hwnd)
  if (!rect) {
    throw nativeError('window_not_interactable', `Window "${windowId}" has no measurable client area.`, windowId)
  }
  const width = Math.max(0, rect.right - rect.left)
  const height = Math.max(0, rect.bottom - rect.top)
  if (x < 0 || y < 0 || x >= width || y >= height) {
    throw nativeError('coordinate_out_of_bounds', `Point (${x}, ${y}) is outside the client area of window "${windowId}".`, windowId)
  }
  const origin = obs.clientToScreenOrigin(hwnd)
  return { hwnd, screenX: origin.x + x, screenY: origin.y + y }
}

/** The DesktopInteractionBackend implementation the PRODUCTION agent wires. */
export class RealDesktopInteractionBackend implements DesktopInteractionBackend {
  readonly id = 'real-desktop'

  private mouseDown(mouseData: number, left: boolean): Input {
    return inputMouse(left ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_RIGHTDOWN, mouseData)
  }

  private mouseUp(mouseData: number, left: boolean): Input {
    return inputMouse(left ? MOUSEEVENTF_LEFTUP : MOUSEEVENTF_RIGHTUP, mouseData)
  }

  private keyInputs(keys: string[]): Input[] {
    const down: Input[] = []
    for (const key of keys) {
      const { vk, extended } = keyVk(key)
      if (vk === 0) throw nativeError('unsupported_key', 'The requested key is not in the supported key allow-list.')
      down.push(inputKey(vk, extended ? KEYEVENTF_EXTENDEDKEY : 0))
    }
    const up: Input[] = []
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      const { vk, extended } = keyVk(keys[i]!)
      up.push(inputKey(vk, (extended ? KEYEVENTF_EXTENDEDKEY : 0) | KEYEVENTF_KEYUP))
    }
    return [...down, ...up]
  }

  private typeInputs(text: string): Input[] {
    const events: Input[] = []
    for (const char of text) {
      if (char === '\t') {
        events.push(...this.keyInputs(['tab']))
      } else if (char === '\n' || char === '\r') {
        events.push(...this.keyInputs(['enter']))
      } else {
        const code = char.charCodeAt(0)
        events.push(inputUnicode(code, 0), inputUnicode(code, KEYEVENTF_KEYUP))
      }
    }
    return events
  }

  async capabilities(): Promise<NativeDesktopCapabilitiesResult> {
    const limits = {
      maxHotkeyKeys: DESKTOP_LIMITS.MAX_HOTKEY_KEYS,
      maxTypeTextLength: DESKTOP_LIMITS.MAX_TYPE_TEXT_LENGTH,
      maxScrollDelta: DESKTOP_LIMITS.MAX_SCROLL_DELTA,
      maxDesktopActionTimeMs: DESKTOP_LIMITS.MAX_DESKTOP_ACTION_TIME_MS,
      maxClientCoordinate: DESKTOP_LIMITS.MAX_CLIENT_COORDINATE,
      maxScreenCoordinate: DESKTOP_LIMITS.MAX_SCREEN_COORDINATE,
    }
    try {
      const obs = getApi()
      const vs = obs.virtualScreen()
      return { available: true, hasApi: true, virtualScreen: vs, limits }
    } catch (error) {
      const code = isNative(error) ? (error as { code: string }).code : 'native_unavailable'
      return {
        available: false,
        hasApi: process.platform === 'win32',
        reason: code === 'unsupported' ? 'Desktop input is not available on this platform.' : 'The desktop input bridge could not be initialized.',
        limits,
      }
    }
  }

  async cursor(): Promise<NativeCursorResult> {
    const obs = getApi()
    const { x, y } = obs.getCursorPos()
    return { x, y, measured: true }
  }

  async moveMouse(x: number, y: number, signal?: DesktopCancellationSignal): Promise<NativeDesktopMoveResult> {
    const started = Date.now()
    const obs = getApi()
    if (signal?.cancelled) {
      const { x: cx, y: cy } = obs.getCursorPos()
      return { x: cx, y: cy, verified: false, cancelled: true }
    }
    const vs = obs.virtualScreen()
    if (x < vs.left || y < vs.top || x >= vs.left + vs.width || y >= vs.top + vs.height) {
      throw nativeError('coordinate_out_of_bounds', `Screen point (${x}, ${y}) is outside the virtual desktop.`)
    }
    assertWithinTimeBudget(started)
    obs.setCursorPos(x, y)
    assertWithinTimeBudget(started)
    const { x: cx, y: cy } = obs.getCursorPos()
    return { x, y, verified: cx === x && cy === y, cancelled: false }
  }

  async click(windowId: string, x: number, y: number, signal?: DesktopCancellationSignal): Promise<NativeDesktopClickResult> {
    if (signal?.cancelled) return { windowId, x, y, injected: false, cancelled: true }
    const obs = getApi()
    const { screenX, screenY } = windowPoint(windowId, x, y)
    const started = Date.now()
    obs.setCursorPos(screenX, screenY)
    assertWithinTimeBudget(started)
    const injected = obs.inject([this.mouseDown(0, true), this.mouseUp(0, true)])
    return { windowId, x, y, injected, cancelled: false }
  }

  async doubleClick(windowId: string, x: number, y: number, signal?: DesktopCancellationSignal): Promise<NativeDesktopClickResult> {
    if (signal?.cancelled) return { windowId, x, y, injected: false, cancelled: true }
    const obs = getApi()
    const { screenX, screenY } = windowPoint(windowId, x, y)
    const started = Date.now()
    obs.setCursorPos(screenX, screenY)
    assertWithinTimeBudget(started)
    const injected = obs.inject([
      this.mouseDown(0, true),
      this.mouseUp(0, true),
      this.mouseDown(0, true),
      this.mouseUp(0, true),
    ])
    return { windowId, x, y, injected, cancelled: false }
  }

  async rightClick(windowId: string, x: number, y: number, signal?: DesktopCancellationSignal): Promise<NativeDesktopClickResult> {
    if (signal?.cancelled) return { windowId, x, y, injected: false, cancelled: true }
    const obs = getApi()
    const { screenX, screenY } = windowPoint(windowId, x, y)
    const started = Date.now()
    obs.setCursorPos(screenX, screenY)
    assertWithinTimeBudget(started)
    const injected = obs.inject([this.mouseDown(0, false), this.mouseUp(0, false)])
    return { windowId, x, y, injected, cancelled: false }
  }

  async scroll(
    windowId: string,
    x: number,
    y: number,
    delta: number,
    signal?: DesktopCancellationSignal,
  ): Promise<NativeDesktopScrollResult> {
    if (signal?.cancelled) return { windowId, x, y, delta, injected: false, cancelled: true }
    const obs = getApi()
    const { screenX, screenY } = windowPoint(windowId, x, y)
    const started = Date.now()
    obs.setCursorPos(screenX, screenY)
    assertWithinTimeBudget(started)
    const injected = obs.inject([inputMouse(MOUSEEVENTF_WHEEL, (delta * WHEEL_DELTA) >>> 0)])
    return { windowId, x, y, delta, injected, cancelled: false }
  }

  async keyPress(key: string, signal?: DesktopCancellationSignal): Promise<NativeDesktopActionResult> {
    if (signal?.cancelled) return { injected: false, cancelled: true }
    const obs = getApi()
    const started = Date.now()
    const injected = obs.inject(this.keyInputs([key]))
    assertWithinTimeBudget(started)
    return { injected, cancelled: false }
  }

  async hotkey(keys: string[], signal?: DesktopCancellationSignal): Promise<NativeDesktopActionResult> {
    if (signal?.cancelled) return { injected: false, cancelled: true }
    const obs = getApi()
    const started = Date.now()
    const injected = obs.inject(this.keyInputs(keys))
    assertWithinTimeBudget(started)
    return { injected, cancelled: false }
  }

  async typeText(text: string, signal?: DesktopCancellationSignal): Promise<NativeDesktopActionResult> {
    if (signal?.cancelled) return { injected: false, cancelled: true }
    const obs = getApi()
    const started = Date.now()
    const injected = obs.inject(this.typeInputs(text))
    assertWithinTimeBudget(started)
    return { injected, cancelled: false }
  }

  async focusWindow(windowId: string): Promise<NativeDesktopFocusResult> {
    const obs = getApi()
    const hwnd = hwndOf(windowId)
    if (!obs.isWindow(hwnd)) {
      throw nativeError('window_not_found', `Window "${windowId}" no longer exists.`, windowId)
    }
    const before = obs.getForegroundWindow()
    obs.setForegroundWindow(hwnd)
    const after = obs.getForegroundWindow()
    const focused = after === hwnd
    const detail = focused
      ? 'The target window is the active foreground window.'
      : before === after
        ? 'The target window could not be made foreground; the OS did not award it activation.'
        : 'Another window became foreground after the focus attempt.'
    return { windowId, focused, detail }
  }

  async minimizeWindow(windowId: string): Promise<NativeDesktopWindowStateResult> {
    const obs = getApi()
    const hwnd = hwndOf(windowId)
    if (!obs.isWindow(hwnd)) {
      throw nativeError('window_not_found', `Window "${windowId}" no longer exists.`, windowId)
    }
    const ok = obs.showWindow(hwnd, SW_MINIMIZE)
    return {
      windowId,
      action: 'minimize',
      success: ok,
      detail: ok ? 'Window was minimized.' : 'Window could not be minimized.',
    }
  }

  async maximizeWindow(windowId: string): Promise<NativeDesktopWindowStateResult> {
    const obs = getApi()
    const hwnd = hwndOf(windowId)
    if (!obs.isWindow(hwnd)) {
      throw nativeError('window_not_found', `Window "${windowId}" no longer exists.`, windowId)
    }
    const ok = obs.showWindow(hwnd, SW_MAXIMIZE)
    return {
      windowId,
      action: 'maximize',
      success: ok,
      detail: ok ? 'Window was maximized.' : 'Window could not be maximized.',
    }
  }

  async restoreWindow(windowId: string): Promise<NativeDesktopWindowStateResult> {
    const obs = getApi()
    const hwnd = hwndOf(windowId)
    if (!obs.isWindow(hwnd)) {
      throw nativeError('window_not_found', `Window "${windowId}" no longer exists.`, windowId)
    }
    const ok = obs.showWindow(hwnd, SW_RESTORE)
    return {
      windowId,
      action: 'restore',
      success: ok,
      detail: ok ? 'Window was restored.' : 'Window could not be restored.',
    }
  }
}

function isNative(error: unknown): boolean {
  return error instanceof Error && error.name === 'NativeError'
}