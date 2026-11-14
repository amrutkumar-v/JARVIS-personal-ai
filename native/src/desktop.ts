import { nativeError } from './errors.js'
import { DESKTOP_LIMITS } from './desktopLimits.js'
import type {
  NativeDesktopActionResult,
  NativeDesktopCapabilitiesResult,
  NativeDesktopClickResult,
  NativeDesktopFocusResult,
  NativeDesktopMoveResult,
  NativeCursorResult,
  NativeDesktopScrollResult,
  NativeDesktopWindowStateResult,
} from './protocol.js'

/**
 * Native Windows Agent — desktop interaction backend seam (Phase 1.5).
 *
 * HANDS: the agent injects REAL input ONLY through this narrow interface. A
 * real backend (`.desktopInput.js`) drives the Win32 SendInput/SetCursorPos/
 * SetForegroundWindow family over FFI; a tests-only memory backend
 * (`.testingDesktop.js`) drives the protocol tests deterministically. There
 * is no generic "move "/"execute"/"run" verb anywhere in the interface — each
 * verb (move, click, doubleClick, rightClick, scroll, keyPress, hotkey, type,
 * focusWindow) is an exact, bounded, single action. Errors are always
 * structured `NativeError`s (see `./errors.js`).
 *
 * Coordinate systems are EXPLICIT and never mixed:
 *   - Screen coordinates (virtual desktop, may include negative origins) —
 *     used ONLY by `moveMouse` and `cursor()`.
 *   - Client-relative coordinates (0..clientWidth / 0..clientHeight of the
 *     TARGET window) — used ONLY by window-targeted actions (click, double,
 *     right, scroll) that REQUIRE a `windowId`. The backend resolves the
 *     client origin with GetClientRect + ClientToScreen.
 *
 * An optional `DesktopCancellationSignal` lets a caller request an action be
 * skipped BEFORE it is performed; a cancelled action executes nothing and
 * returns a structured `cancelled` result (single-action semantics — there
 * are no queued actions).
 */
export interface DesktopCancellationSignal {
  /** True when the caller asks that this action not be performed. */
  cancelled?: boolean
}

export interface DesktopInteractionBackend {
  /** Stable backend identifier (for diagnostics / testsOnly flags). */
  id: string
  /** Backends that are pure test doubles MUST set this true. */
  testsOnly?: boolean

  /** Capability + virtual-screen + limits report (probe, read-only). */
  capabilities(): Promise<NativeDesktopCapabilitiesResult>

  /** Current cursor position (virtual-desktop screen coordinates). */
  cursor(): Promise<NativeCursorResult>

  /** Move the cursor to an ABSOLUTE virtual-desktop screen point. */
  moveMouse(x: number, y: number, signal?: DesktopCancellationSignal): Promise<NativeDesktopMoveResult>

  /** Single left click at client-relative (x, y) inside `windowId`. */
  click(windowId: string, x: number, y: number, signal?: DesktopCancellationSignal): Promise<NativeDesktopClickResult>

  /** Double left click at client-relative (x, y) inside `windowId`. */
  doubleClick(windowId: string, x: number, y: number, signal?: DesktopCancellationSignal): Promise<NativeDesktopClickResult>

  /** Right (context) click at client-relative (x, y) inside `windowId`. */
  rightClick(windowId: string, x: number, y: number, signal?: DesktopCancellationSignal): Promise<NativeDesktopClickResult>

  /** Scroll `delta` wheel units over client-relative (x, y) inside `windowId`. */
  scroll(windowId: string, x: number, y: number, delta: number, signal?: DesktopCancellationSignal): Promise<NativeDesktopScrollResult>

  /** Press one allow-listed key (sent to the focused window). */
  keyPress(key: string, signal?: DesktopCancellationSignal): Promise<NativeDesktopActionResult>

  /** Press an allow-listed key combination (1..MAX_HOTKEY_KEYS keys). */
  hotkey(keys: string[], signal?: DesktopCancellationSignal): Promise<NativeDesktopActionResult>

  /** Type bounded text via UNICODE input (sent to the focused window). */
  typeText(text: string, signal?: DesktopCancellationSignal): Promise<NativeDesktopActionResult>

  /** Bring a window to the foreground; `focused` reflects the POST-attempt state. */
  focusWindow(windowId: string): Promise<NativeDesktopFocusResult>

  /** Minimize a window. */
  minimizeWindow(windowId: string): Promise<NativeDesktopWindowStateResult>

  /** Maximize a window. */
  maximizeWindow(windowId: string): Promise<NativeDesktopWindowStateResult>

  /** Restore a window to normal state. */
  restoreWindow(windowId: string): Promise<NativeDesktopWindowStateResult>
}

/* ---------------------------------------------------------------- safety */

/**
 * The ONLY key names `desktop.keyPress` / `desktop.hotkey` accept. Letters,
 * digits, function keys and a small set of named physical keys — no WIN key,
 * no arbitrary VK codes, no "any key" escape hatch. Anything else is a
 * structured `unsupported_key` error before any backend is consulted.
 */
export const DESKTOP_KEYS: readonly string[] = [
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  'enter', 'tab', 'escape', 'space', 'backspace', 'delete',
  'home', 'end', 'pageup', 'pagedown',
  'arrow_left', 'arrow_up', 'arrow_right', 'arrow_down',
  'shift', 'control', 'alt', 'capslock',
]

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  ctrl: 'control',
  left: 'arrow_left',
  up: 'arrow_up',
  right: 'arrow_right',
  down: 'arrow_down',
  del: 'delete',
  pgup: 'pageup',
  pgdn: 'pagedown',
}

/** Canonical form of a key name, or undefined when unsupported. */
export function normalizeDesktopKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const key = raw.trim().toLowerCase()
  if (key.length === 0 || key.length > 16) return undefined
  return DESKTOP_KEYS.includes(key) ? key : KEY_ALIASES[key]
}

/** True only when the raw value is a supported key name. */
export function isDesktopKey(raw: unknown): boolean {
  return normalizeDesktopKey(raw) !== undefined
}

/** Validate a `key` parameter; returns the canonical key or throws `unsupported_key`. */
export function desktopKeyParam(raw: unknown): string {
  const key = normalizeDesktopKey(raw)
  if (!key) throw nativeError('unsupported_key', 'The requested key is not in the supported key allow-list.')
  return key
}

/** Validate a hotkey array (1..MAX_HOTKEY_KEYS supported keys); canonical array or throws. */
export function hotkeyParams(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw nativeError('invalid_argument', 'A hotkey needs at least one key.')
  }
  if (raw.length > DESKTOP_LIMITS.MAX_HOTKEY_KEYS) {
    throw nativeError('too_large', `A hotkey is limited to ${DESKTOP_LIMITS.MAX_HOTKEY_KEYS} keys.`)
  }
  return raw.map(desktopKeyParam)
}

/** Validate + normalize typed text (1..MAX_TYPE_TEXT_LENGTH chars, control chars rejected). */
export function typeTextParam(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw nativeError('invalid_argument', 'Text to type must be a non-empty string.')
  }
  if (raw.length > DESKTOP_LIMITS.MAX_TYPE_TEXT_LENGTH) {
    throw nativeError('too_large', `Typed text is limited to ${DESKTOP_LIMITS.MAX_TYPE_TEXT_LENGTH} characters.`)
  }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      throw nativeError('invalid_argument', 'Typed text may not contain control characters.')
    }
  }
  return raw
}

/** Validate a finite integer coordinate (client-relative sanity ceiling). */
export function coordParam(raw: unknown, name: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || !Number.isFinite(value)) {
    throw nativeError('invalid_argument', `"${name}" must be an integer.`)
  }
  if (Math.abs(value) > DESKTOP_LIMITS.MAX_CLIENT_COORDINATE) {
    throw nativeError('coordinate_out_of_bounds', `"${name}" is outside the coordinate ceiling.`)
  }
  return value
}

/** Validate a finite integer ABSOLUTE screen coordinate (wider virtual-desktop ceiling). */
export function screenCoordParam(raw: unknown, name: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || !Number.isFinite(value)) {
    throw nativeError('invalid_argument', `"${name}" must be an integer.`)
  }
  if (Math.abs(value) > DESKTOP_LIMITS.MAX_SCREEN_COORDINATE) {
    throw nativeError('coordinate_out_of_bounds', `"${name}" is outside the screen coordinate ceiling.`)
  }
  return value
}

/** Validate a scroll delta (|delta| <= MAX_SCROLL_DELTA, integer, non-zero handled by callers). */
export function scrollDeltaParam(raw: unknown): number {
  const delta = Number(raw)
  if (!Number.isInteger(delta) || !Number.isFinite(delta) || delta === 0) {
    throw nativeError('invalid_argument', '"delta" must be a non-zero integer.')
  }
  if (Math.abs(delta) > DESKTOP_LIMITS.MAX_SCROLL_DELTA) {
    throw nativeError('too_large', `Scroll delta is limited to ±${DESKTOP_LIMITS.MAX_SCROLL_DELTA}.`)
  }
  return delta
}

/** Honest non-Windows / never-instantiated capability fallback. */
export function unsupportedDesktopCapabilities(reason?: string): NativeDesktopCapabilitiesResult {
  return {
    available: false,
    hasApi: false,
    reason,
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

/** Shared "not implemented on this backend" guard used by real fallbacks. */
export function desktopUnsupported(message: string): never {
  throw nativeError('unsupported', message)
}