import { describe, expect, it } from 'vitest'
import { describeCameraFrame } from './describe'
import type { VisionAnalysisResult } from '../vision/types'

function analysis(elements: VisionAnalysisResult['elements']): VisionAnalysisResult {
  return { viewport: { width: 640, height: 480 }, elements, providerId: 'fake', analyzedAt: Date.now() }
}

describe('describeCameraFrame (provider-safe summary)', () => {
  it('never invents elements for an empty analysis', () => {
    expect(describeCameraFrame(analysis([]))).toContain('reported no recognisable elements')
  })

  it('describes only what the vision model actually returned', () => {
    const reply = describeCameraFrame(
      analysis([
        { id: 'a', type: 'text', text: 'Hello', bounds: { x: 0, y: 0, width: 10, height: 10 }, confidence: 0.9 },
        { id: 'b', type: 'button', label: 'Save', bounds: { x: 20, y: 20, width: 10, height: 10 }, confidence: 0.8 },
      ]),
    )
    expect(reply).toContain('2 elements')
    expect(reply).toContain('text "Hello"')
    expect(reply).toContain('button "Save"')
  })

  it('is bounded even when the model returns many elements', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      type: 'icon' as const,
      bounds: { x: i, y: i, width: 4, height: 4 },
      confidence: 0.5,
    }))
    const reply = describeCameraFrame(analysis(many))
    expect(reply).toContain('20 elements')
    expect(reply).toContain('and 14 more')
  })
})