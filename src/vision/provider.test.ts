import { describe, expect, it } from 'vitest'
import { VISION_UNAVAILABLE_MESSAGE, unavailableVisionCapabilities } from './provider'
import { VISUAL_LIMITS } from './limits'
import { createFakeVisionProvider } from './testing'
import type { ScreenshotResult } from '../observation'

/** The fake observation provider emits this exact 2x2 PNG — use the same. */
function shot(): ScreenshotResult {
  return { width: 2, height: 2, format: 'png', bytesLength: 83, bytes: 'iVBORw0KGgoAAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGklEQVR4nAXBAQEAAACCIMf6qrEGBE0ibNoBSiIIwehTveAAAAAASUVORK5CYII=' }
}

describe('unavailableVisionCapabilities', () => {
  it('reports every visual capability as unavailable', () => {
    const caps = unavailableVisionCapabilities()
    expect(caps).toMatchObject({
      visionAvailable: false,
      ocrAvailable: false,
      uiElementDetectionAvailable: false,
      targetLocalizationAvailable: false,
    })
  })

  it('carries an honest reason', () => {
    expect(unavailableVisionCapabilities('no provider').reason).toBe('no provider')
  })
})

describe('honesty string', () => {
  it('is the documented platform sentence (surface must match exactly)', () => {
    expect(VISION_UNAVAILABLE_MESSAGE).toBe(
      'Visual semantic understanding is unavailable until a real VisionProvider is configured.',
    )
  })
})

describe('createFakeVisionProvider (deterministic test double)', () => {
  it('is a tests-only provider', () => {
    expect(createFakeVisionProvider().testsOnly).toBe(true)
  })

  it('starts fully available with seeded elements matching the 2x2 fake screenshot', () => {
    const fake = createFakeVisionProvider()
    const caps = fake.capabilities()
    expect(caps.visionAvailable).toBe(true)
    expect(caps.ocrAvailable).toBe(true)
    expect(caps.uiElementDetectionAvailable).toBe(true)
    expect(caps.targetLocalizationAvailable).toBe(true)
    expect(fake.elements.length).toBeGreaterThan(0)
    for (const e of fake.elements) {
      expect(e.bounds.x).toBeGreaterThanOrEqual(0)
      expect(e.bounds.y).toBeGreaterThanOrEqual(0)
      expect(e.bounds.x + e.bounds.width).toBeLessThanOrEqual(2)
      expect(e.bounds.y + e.bounds.height).toBeLessThanOrEqual(2)
    }
  })

  it('reports availability off when the test sets it', () => {
    const fake = createFakeVisionProvider()
    fake.setAvailable(false)
    expect(fake.capabilities().visionAvailable).toBe(false)
    expect(fake.capabilities().reason).toBeDefined()
  })

  it('tracks analysis options + call counts', async () => {
    const fake = createFakeVisionProvider()
    const result = await fake.analyzeScreenshot(shot())
    expect(result).toBeDefined()
    expect(fake.analyzeCalls).toBe(1)
    fake.analyzeScreenshot(shot(), { signal: new AbortController().signal })
    expect(fake.analyzeCalls).toBe(2)
    expect(fake.lastOptions).toEqual({ signal: expect.anything() })
  })

  it('clips the seeded analysis to MAX_VISUAL_ELEMENTS', async () => {
    const fake = createFakeVisionProvider()
    fake.setElements(
      Array.from({ length: VISUAL_LIMITS.MAX_VISUAL_ELEMENTS + 30 }, () => ({
        id: 'x',
        type: 'button' as const,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        confidence: 0.5,
      })),
    )
    const result = await fake.analyzeScreenshot(shot())
    expect(result.elements.length).toBeLessThanOrEqual(VISUAL_LIMITS.MAX_VISUAL_ELEMENTS)
  })

  it('fails the analysis when a failure is injected', async () => {
    const fake = createFakeVisionProvider()
    fake.setFailure('engine unavailable')
    await expect(fake.analyzeScreenshot(shot())).rejects.toThrow(/unavailable/)
  })

  it('recovers after a failure is cleared', async () => {
    const fake = createFakeVisionProvider()
    fake.setFailure('engine unavailable')
    fake.clearFailure()
    const result = await fake.analyzeScreenshot(shot())
    expect(result).toBeDefined()
  })
})