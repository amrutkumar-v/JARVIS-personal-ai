/**
 * Web-side desktop-interaction capability contract (Phase 1.5).
 *
 * HANDS: mirrors the native wire types (`native/src/protocol.ts`) WITHOUT
 * importing them — this module is compiled by the strict app tsconfig and must
 * stay self-contained, so the key allow-list + validation are duplicated here
 * by design (platform-facing bridge types live in
 * `src/native/NativeWindowsDesktopProvider.ts`).
 *
 * A provider exposes the desktop.* / window.focus surface to the engine ONLY
 * when a real backend is supplied. Browser mode yields NO desktop tools at all
 * — never a fabricated/in-memory "desktop".
 *
 * Coordinate systems are EXPLICIT and never mixed (same rule as the native
 * agent):
 *   - Screen coordinates (virtual desktop, may include negative origins) —
 *     used ONLY by `moveMouse` / `cursor`.
 *   - Client-relative coordinates (0..clientWidth / 0..clientHeight of the
 *     TARGET window) — used ONLY by window-targeted actions (click, double,
 *     right, scroll) that REQUIRE a `windowId`.
 *
 * Redaction: the engine records `[redacted]` in place of any typed text on
 * traces / plans via `sanitizeDesktopPayload`; the real string is only ever
 * handed to the backend (and echoed back to the model that invented it).
 */
export interface VirtualScreen {
  left: number
  top: number
  width: number
  height: number
}

export interface DesktopLimitsReport {
  maxHotkeyKeys: number
  maxTypeTextLength: number
  maxScrollDelta: number
  maxDesktopActionTimeMs: number
  maxClientCoordinate: number
  maxScreenCoordinate: number
}

export type DesktopOp =
  | 'cursor'
  | 'move'
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'scroll'
  | 'key_press'
  | 'hotkey'
  | 'type'
  | 'focus'
  | 'minimize'
  | 'maximize'
  | 'restore'

export interface DesktopCapabilities {
  /** False when the native agent is unreachable / not Windows. */
  available: boolean
  /** Whether the Win32 input/foreground API family is present. */
  hasApi: boolean
  reason?: string
  /** Virtual-desktop bounds (screen pixels; origin may be negative). */
  virtualScreen?: VirtualScreen
  /** The bounded input parameters the agent enforces. */
  limits: DesktopLimitsReport
  /** Per-op flags (all-false when unavailable). */
  ops: Record<DesktopOp, boolean>
}

/** Current cursor position (virtual-desktop screen coordinates). */
export interface DesktopCursorResult {
  x: number
  y: number
  /** True when the position was measured by the OS rather than estimated. */
  measured: boolean
}

export interface DesktopMoveResult {
  /** Virtual-desktop screen coordinates the cursor was moved to. */
  x: number
  y: number
  /** True only when a post-move read matched the target. */
  verified: boolean
  /** True when the caller cancelled the action before it ran. */
  cancelled: boolean
}

export interface DesktopClickResult {
  windowId: string
  /** Client-relative coordinates the action was targeted at. */
  x: number
  y: number
  /** True when the click sequence was actually injected. */
  injected: boolean
  /** True when the caller cancelled the action before it ran. */
  cancelled: boolean
}

export interface DesktopScrollResult extends DesktopClickResult {
  /** Signed wheel units actually injected (bounded by the limits). */
  delta: number
}

/** Result of a key / hotkey / typed-text injection (count, never content). */
export interface DesktopKeyResult {
  /** Number of keys/characters requested (length only — content never echoes). */
  length: number
  /** True when the input was actually injected. */
  injected: boolean
  /** True when the caller cancelled the action before it ran. */
  cancelled: boolean
}

export interface DesktopFocusResult {
  windowId: string
  /** True only when the target is the foreground window right now. */
  focused: boolean
  /** Provider-safe explanation of the post-attempt state. */
  detail: string
}

export interface DesktopWindowStateResult {
  windowId: string
  action: 'minimize' | 'maximize' | 'restore'
  success: boolean
  detail: string
}

export interface DesktopProvider {
  id: string
  /** Test doubles MUST set this true (production never binds to them). */
  testsOnly?: boolean

  capabilities(): DesktopCapabilities
  /** Async re-probe; used for the engine start() wiring seam. */
  refreshNativeStatus?(): Promise<void>

  /** Current cursor position (virtual-desktop screen coordinates). */
  cursor(): Promise<DesktopCursorResult>
  /** Move the cursor to an ABSOLUTE virtual-desktop screen point. */
  moveMouse(x: number, y: number): Promise<DesktopMoveResult>
  /** Single left click at client-relative (x, y) inside `windowId`. */
  click(windowId: string, x: number, y: number): Promise<DesktopClickResult>
  /** Double left click at client-relative (x, y) inside `windowId`. */
  doubleClick(windowId: string, x: number, y: number): Promise<DesktopClickResult>
  /** Right (context) click at client-relative (x, y) inside `windowId`. */
  rightClick(windowId: string, x: number, y: number): Promise<DesktopClickResult>
  /** Scroll `delta` wheel units over client-relative (x, y) inside `windowId`. */
  scroll(windowId: string, x: number, y: number, delta: number): Promise<DesktopScrollResult>
  /** Press one allow-listed key (sent to the focused window). */
  keyPress(key: string): Promise<DesktopKeyResult>
  /** Press an allow-listed key combination (1..MAX_HOTKEY_KEYS keys). */
  hotkey(keys: string[]): Promise<DesktopKeyResult>
  /** Type bounded text via UNICODE input (sent to the focused window). */
  typeText(text: string): Promise<DesktopKeyResult>
  /** Bring a window to the foreground; `focused` reflects the POST-attempt state. */
  focusWindow(windowId: string): Promise<DesktopFocusResult>
  /** Minimize a window. */
  minimizeWindow(windowId: string): Promise<DesktopWindowStateResult>
  /** Maximize a window. */
  maximizeWindow(windowId: string): Promise<DesktopWindowStateResult>
  /** Restore a window. */
  restoreWindow(windowId: string): Promise<DesktopWindowStateResult>
}

/* ---------------------------------------------------------------- safety */

/**
 * The ONLY key names `desktop.key_press` / `desktop.hotkey` accept — the same
 * allow-list as the native agent. No WIN key, no arbitrary VK codes, no
 * "any key" escape hatch.
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

/** Validate a `key` param; canonical key on success, human reason on failure. */
export function parseDesktopKey(raw: unknown): { key: string } | { error: string } {
  const key = normalizeDesktopKey(raw)
  if (!key) return { error: 'The requested key is not in the supported key allow-list.' }
  return { key }
}

/** Validate a hotkey array (1..MAX_HOTKEY_KEYS supported keys). */
export function parseHotkeyKeys(raw: unknown, maxHotkeyKeys = 4): { keys: string[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'A hotkey needs at least one key.' }
  if (raw.length > maxHotkeyKeys) return { error: `A hotkey is limited to ${maxHotkeyKeys} keys.` }
  const keys: string[] = []
  for (const entry of raw) {
    const parsed = parseDesktopKey(entry)
    if ('error' in parsed) return { error: parsed.error }
    keys.push(parsed.key)
  }
  return { keys }
}

/**
 * Validate + normalize typed text (1..MAX_TYPE_TEXT_LENGTH chars, control
 * chars rejected). Tab / newline are allowed (they map to real key presses);
 * everything else below 0x20 is refused.
 */
export function parseTypeText(raw: unknown, maxLength = 2000): { text: string } | { error: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { error: 'Text to type must be a non-empty string.' }
  if (raw.length > maxLength) return { error: `Typed text is limited to ${maxLength} characters.` }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return { error: 'Typed text may not contain control characters.' }
    }
  }
  return { text: raw }
}

/** Validate a finite integer client-relative coordinate. */
export function parseClientCoord(raw: unknown, name: string, ceiling = 10_000): { value: number } | { error: string } {
  const value = Number(raw)
  if (!Number.isInteger(value) || !Number.isFinite(value)) return { error: `"${name}" must be an integer.` }
  if (Math.abs(value) > ceiling) return { error: `"${name}" is outside the coordinate ceiling.` }
  return { value }
}

/** Validate a finite integer ABSOLUTE screen coordinate. */
export function parseScreenCoord(raw: unknown, name: string, ceiling = 1_000_000): { value: number } | { error: string } {
  const value = Number(raw)
  if (!Number.isInteger(value) || !Number.isFinite(value)) return { error: `"${name}" must be an integer.` }
  if (Math.abs(value) > ceiling) return { error: `"${name}" is outside the screen coordinate ceiling.` }
  return { value }
}

/** Validate a scroll delta (|delta| <= MAX_SCROLL_DELTA, integer, non-zero). */
export function parseScrollDelta(raw: unknown, ceiling = 5000): { value: number } | { error: string } {
  const delta = Number(raw)
  if (!Number.isInteger(delta) || !Number.isFinite(delta) || delta === 0) {
    return { error: '"delta" must be a non-zero integer.' }
  }
  if (Math.abs(delta) > ceiling) return { error: `Scroll delta is limited to ±${ceiling}.` }
  return { value: delta }
}

/* ---------------------------------------------------------------- redaction */

/**
 * Sanitize a tool payload for durable recording (traces, plans). Typed text
 * is replaced with a `[redacted]` placeholder so private input never persists;
 * every other desktop payload passes through unchanged. The real string still
 * travels: to the backend (execution) and back to the model that invented it.
 */
export function sanitizeDesktopPayload(
  toolId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (toolId !== 'desktop.type') return payload
  if (typeof payload['text'] !== 'string') return payload
  return { ...payload, text: '[redacted]' }
}