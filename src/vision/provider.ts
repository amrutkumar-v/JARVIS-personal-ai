/**
 * Web-side visual-understanding capability contract (Phase 1.7) — EYES.
 *
 * A VisionProvider turns a TRANSIENT screenshot into structured UI elements.
 * It is a PRODUCTION DI SEAM: nothing here fabricates vision. The app binds a
 * provider only when a real one is configured; otherwise the engine registers
 * NO visual tools, reports every visual capability as unavailable, and never
 * pretends it can see.
 *
 * Unlike EYES (observation) this surface is an ANALYSER: OCR + element
 * segmentation. It is deliberately read-only in the contract — there is no
 * click/type/focus verb anywhere; acting is the desktop layer's job.
 *
 * Privacy contract:
 *   - screenshot bytes are TRANSIT ONLY — the provider never persists them
 *   - analysis results may carry bounded labels/text, but never raw bytes
 *   - analysers never upload, stream, or telephone-home anywhere
 */
import type { ScreenshotResult } from '../observation'
import type { VisionAnalysisResult } from './types'

export interface VisionCapabilities {
  /** A REAL vision analysis is available right now. */
  visionAvailable: boolean
  /** Text recognition (OCR) is available on the configured provider. */
  ocrAvailable: boolean
  /** UI element segmentation (buttons/inputs/…) is available. */
  uiElementDetectionAvailable: boolean
  /** Target localisation can map an instruction onto detected elements. */
  targetLocalizationAvailable: boolean
  /** Human reason when one of the above is false. */
  reason?: string
}

export interface VisionAnalysisOptions {
  /** Abort the analysis (caller cancellation / MAX_VISUAL_ANALYSIS_MS wall). */
  signal?: AbortSignal
}

export interface VisionProvider {
  readonly id: string
  /** Test doubles MUST set this true (production never binds to them). */
  testsOnly?: boolean

  /** Honest capability report — no capability is ever claimed speculatively. */
  capabilities(): VisionCapabilities
  /** Async re-probe; used for the engine start() wiring seam (optional). */
  refreshNativeStatus?(): Promise<void>

  /**
   * Analyse one transient screenshot into bounded, structured UI elements.
   * Options are the ONLY permission to bound the work (abort/timing). Never
   * persists, uploads, or logs the screenshot or any OCR text.
   */
  analyzeScreenshot(screenshot: ScreenshotResult, options?: VisionAnalysisOptions): Promise<VisionAnalysisResult>
}

/** Honest, provider-safe state of a runtime with NO vision configuration. */
export const VISION_UNAVAILABLE_MESSAGE =
  'Visual semantic understanding is unavailable until a real VisionProvider is configured.'

export function unavailableVisionCapabilities(reason?: string): VisionCapabilities {
  return {
    visionAvailable: false,
    ocrAvailable: false,
    uiElementDetectionAvailable: false,
    targetLocalizationAvailable: false,
    reason: reason ?? VISION_UNAVAILABLE_MESSAGE,
  }
}