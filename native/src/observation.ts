import type { NativeScreenshotResult, NativeWindowStatusResult, NativeWindowSummary } from './protocol.js'

/**
 * Native Windows Agent — observation backend seam (Phase 1.4).
 *
 * EYES, NOT HANDS. The agent reads the desktop ONLY through this narrow
 * interface. A real backend reads the Win32 API over FFI (`./obsWin32.js`); a
 * tests-only memory backend drives the protocol tests deterministically.
 * Observation can never launch, move, focus or text-mine anything — the
 * interface has no such verbs by construction. Errors are always structured
 * `NativeError`s (see `./errors.js`).
 */
export interface ObservationBackend {
  /** Stable backend identifier (for diagnostics / testsOnly flags). */
  id: string
  /** Backends that are pure test doubles MUST set this true. */
  testsOnly?: boolean

  /** Top-level windows, deterministically ordered (visible first). */
  listWindows(): Promise<NativeWindowSummary[]>

  /** Inspect one window by its validated decimal id; vanished → not_found. */
  getWindowStatus(windowId: string): Promise<NativeWindowStatusResult>

  /** Capture the whole primary screen as an encoded image. */
  captureScreenshot(): Promise<NativeScreenshotResult>
}