import type { ScreenshotResult } from '../observation'

/**
 * Webcam capability contract (Phase 2.7) — a REAL browser camera, never a mock.
 *
 * Camera is a browser-only surface: it lives in the app tab (getUserMedia), not
 * in the native agent. The engine binds a CameraController ONLY when the app
 * supplies one; otherwise camera commands are answered honestly as unavailable.
 *
 * Privacy contract (mirrors the voice layer):
 *   - `audio: false` is always used — the camera never captures sound.
 *   - Camera activation only ever happens on an explicit user gesture or an
 *     explicit user command; the browser's own permission prompt is the gate.
 *   - Captured frames are TRANSIENT PNG bytes, never persisted or logged.
 *   - Capture is only possible while the user keeps the camera active.
 */

export type CameraPermissionState =
  | 'unknown'
  | 'granted'
  | 'denied'
  | 'in-use'
  | 'incompatible'
  | 'unavailable'

export interface CameraCapabilities {
  /** A real webcam surface exists in this tab. */
  available: boolean
  /** Most recently observed browser permission / device state. */
  permission: CameraPermissionState
  /** True while a real video stream is live. */
  active: boolean
  reason?: string
}

export interface CameraStartResult {
  ok: boolean
  permission: CameraPermissionState
  reason?: string
}

/**
 * The camera surface the engine and UI can drive. Every method performs the
 * REAL browser operation or honestly reports why it cannot.
 */
export interface CameraController {
  readonly id: string
  capabilities(): CameraCapabilities
  start(): Promise<CameraStartResult>
  stop(): void
  /** Release the stream and drop listeners (session teardown). */
  dispose(): void
  /** Real snapshot of the live feed as a transient PNG (null when off). */
  captureFrame(): Promise<ScreenshotResult | null>
  /** Bind the preview <video> element used to snapshot the live feed. */
  setVideoElement(element: HTMLVideoElement | null): void
  subscribe(listener: (status: CameraCapabilities) => void): () => void
}