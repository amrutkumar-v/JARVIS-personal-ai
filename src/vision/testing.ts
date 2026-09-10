import type { ScreenshotResult } from '../observation'
import { fsError } from '../filesystem'
import type { VisionAnalysisOptions, VisionCapabilities, VisionProvider } from './provider'
import { VISION_UNAVAILABLE_MESSAGE } from './provider'
import type { VisualElement, VisionAnalysisResult } from './types'
import { VISUAL_LIMITS } from './limits'

/**
 * Deterministic in-memory vision provider — TESTS ONLY.
 *
 * Never imported or constructed by production code (src/vision/index.ts
 * deliberately does not export it); production binds a REAL VisionProvider
 * when configured, and `createDefaultAppVisionProvider()` returns `undefined`
 * until then. This fake exists so the visual tools + engine seam can be
 * exercised quickly and deterministically, and every capability it reports is
 * HONEST for a fake (it genuinely can segment + resolve its own elements).
 *
 * Semantics:
 *   - analyzeScreenshot returns the seeded elements bounded to the viewport,
 *     clipped to MAX_VISUAL_ELEMENTS (a provider that lies is a bug we test
 *     AGAINST, not a fake we blur)
 *   - available=false → capabilities all-false and analysis throws unavailable
 *   - a forced failure (`setFailure`) exercises the provider-error path
 */

/** Default deterministic desktop set sized to the 2x2 fake screenshot surface. */
export function defaultVisionElements(): VisualElement[] {
  return [
    { id: 'el-settings', type: 'button', label: 'Settings', bounds: { x: 0, y: 0, width: 1, height: 1 }, confidence: 1 },
    { id: 'el-search', type: 'input', label: 'Search', bounds: { x: 1, y: 0, width: 1, height: 1 }, confidence: 1 },
    { id: 'el-cancel', type: 'button', label: 'Cancel', bounds: { x: 0, y: 0, width: 1, height: 1 }, confidence: 1 },
    { id: 'el-submit-a', type: 'button', label: 'Submit', text: 'Submit', bounds: { x: 0, y: 1, width: 1, height: 1 }, confidence: 1 },
    { id: 'el-submit-b', type: 'button', label: 'Submit', text: 'Submit', bounds: { x: 1, y: 1, width: 1, height: 1 }, confidence: 1 },
    { id: 'el-remember', type: 'checkbox', label: 'Remember me', bounds: { x: 1, y: 1, width: 1, height: 1 }, confidence: 1 },
    { id: 'el-saved', type: 'text', label: 'Saved', text: 'Saved', bounds: { x: 0, y: 1, width: 1, height: 1 }, confidence: 1 },
    { id: 'el-dialog', type: 'dialog', label: 'Confirm dialog', bounds: { x: 1, y: 0, width: 1, height: 1 }, confidence: 1 },
    { id: 'el-link', type: 'link', label: 'Learn more', bounds: { x: 0, y: 0, width: 1, height: 1 }, confidence: 1 },
  ]
}

export class FakeVisionProvider implements VisionProvider {
  readonly id = 'fake-vision'
  /** Positive marker so tests can assert production never swaps this in. */
  readonly testsOnly = true

  /** Deterministic element set the next analysis reports. */
  elements: VisualElement[] = defaultVisionElements()
  /** Chronological options passed to each analyze (for cancellation/timing tests). */
  lastOptions?: VisionAnalysisOptions
  analyzeCalls = 0
  private available = true
  private failureReason = VISION_UNAVAILABLE_MESSAGE
  private forcedFailure: string | null = null

  setAvailable(on: boolean, reason?: string): void {
    this.available = on
    if (!on) this.failureReason = reason ?? 'Visual analysis is disabled for this test.'
  }

  /** Force every analysis to throw (provider-error path). */
  setFailure(message = 'Forced analysis failure.'): void {
    this.forcedFailure = message
  }

  clearFailure(): void {
    this.forcedFailure = null
  }

  /** Replace the deterministic element set for the next analysis. */
  setElements(elements: VisualElement[]): void {
    this.elements = [...elements]
  }

  capabilities(): VisionCapabilities {
    if (!this.available) {
      return {
        visionAvailable: false,
        ocrAvailable: false,
        uiElementDetectionAvailable: false,
        targetLocalizationAvailable: false,
        reason: this.failureReason,
      }
    }
    // A fake that CAN segment and resolve its own elements honestly reports so.
    return {
      visionAvailable: true,
      ocrAvailable: true,
      uiElementDetectionAvailable: true,
      targetLocalizationAvailable: true,
    }
  }

  async analyzeScreenshot(
    screenshot: ScreenshotResult,
    options?: VisionAnalysisOptions,
  ): Promise<VisionAnalysisResult> {
    if (this.forcedFailure) throw fsError('io', this.forcedFailure)
    if (!this.available) throw fsError('unavailable', this.failureReason)
    if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    this.analyzeCalls += 1
    this.lastOptions = options
    return {
      viewport: { width: screenshot.width, height: screenshot.height },
      // The bounded, clipped element list a real analyser would return.
      elements: this.elements.slice(0, VISUAL_LIMITS.MAX_VISUAL_ELEMENTS),
      providerId: this.id,
      analyzedAt: 0,
    }
  }
}

/** Convenience factory for tests (static-analysed as a tests-only fake). */
export function createFakeVisionProvider(): FakeVisionProvider {
  return new FakeVisionProvider()
}