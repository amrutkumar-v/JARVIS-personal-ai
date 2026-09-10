/**
 * Web-side observation capability contract (Phase 1.4).
 *
 * Mirrors the native wire types (`native/src/protocol.ts`) WITHOUT importing
 * them: this module is compiled by the strict app tsconfig and must stay
 * self-contained, so the window-id charset + validation are duplicated here by
 * design (platform-facing bridge types live in
 * `src/native/NativeWindowsObservationProvider.ts`).
 *
 * EYES, NOT HANDS: the surface below can READ windows and the screen and
 * nothing else. There is no focus/move/click/type verb anywhere in the
 * contract — the engine only ever registers `window.list` / `window.status` /
 * `desktop.screenshot`.
 */
export interface WindowBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface WindowSummary {
  /** Opaque decimal window id (validated by WINDOW_ID_PATTERN). */
  windowId: string
  title: string
  pid?: number
  /** Executable NAME only (never a path). */
  processName?: string
  visible: boolean
  minimized: boolean
  maximized: boolean
  bounds?: WindowBounds
  /**
   * Client-area bounds in screen coordinates, measured by the native agent
   * (GetClientRect + ClientToScreen). This is the EXACT coordinate space the
   * screenshot pixels live in — the frame offsets (title bar, borders) are
   * absent, so a screenshot pixel maps 1:1 onto a clientBounds point.
   * Absent when the OS does not report it; the web layer must then fall back
   * to `bounds` with an explicit, documented frame-offset estimate.
   */
  clientBounds?: WindowBounds
}

export interface WindowStatus extends WindowSummary {
  /** True when the window still exists right now (verify target). */
  exists: boolean
}

export interface ScreenshotResult {
  width: number
  height: number
  format: 'png'
  /** Encoded bytes (base64); transient, never persisted or logged. */
  bytesLength: number
  bytes: string
}

export type ObservationOp = 'list' | 'status' | 'screenshot'

export interface ObservationCapabilities {
  /** False when the native agent is unreachable / not Windows. */
  available: boolean
  reason?: string
  /** The native agent offers an observation API at all. */
  hasApi: boolean
  canListWindows: boolean
  canInspectWindows: boolean
  canCaptureScreenshots: boolean
}

export interface ObservationProvider {
  id: string
  capabilities(): ObservationCapabilities
  /** Async re-probe; used for the engine start() wiring seam. */
  refreshNativeStatus?(): Promise<void>
  listWindows(): Promise<WindowSummary[]>
  getWindowStatus(windowId: string): Promise<WindowStatus>
  captureScreenshot(): Promise<ScreenshotResult>
}

/** Window id charset: decimal only — never a path, pointer or command. */
export const WINDOW_ID_PATTERN = /^\d{1,10}$/
export const MAX_WINDOW_ID_LENGTH = 10

/**
 * Normalize + validate a window id for the web side. Returns a trimmed id on
 * success, or a human reason on failure (discriminated union).
 */
export function normalizeWindowId(input: unknown): { id: string } | { error: string } {
  if (typeof input !== 'string') return { error: 'windowId must be a string.' }
  const id = input.trim()
  if (id.length === 0) return { error: 'windowId must not be empty.' }
  if (id.length > MAX_WINDOW_ID_LENGTH) return { error: `windowId must be at most ${MAX_WINDOW_ID_LENGTH} digits.` }
  if (!WINDOW_ID_PATTERN.test(id)) return { error: 'windowId must be a plain decimal number (never a path or pointer).' }
  return { id }
}