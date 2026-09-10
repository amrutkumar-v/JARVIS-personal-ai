import type { VisionAnalysisResult } from '../vision/types'

/**
 * Deterministic, PROVIDER-SAFE summary of a real camera-frame analysis
 * (Phase 2.7). Built ONLY from the elements the vision model actually returned
 * — it never invents semantics and never exposes raw bytes, coords or prompts.
 */
const MAX_DESCRIBED_ELEMENTS = 6

export function describeCameraFrame(analysis: VisionAnalysisResult): string {
  const count = analysis.elements.length
  if (count === 0) {
    return `I can see the camera feed, but the ${analysis.providerId} vision model reported no recognisable elements in it.`
  }
  const shown = analysis.elements.slice(0, MAX_DESCRIBED_ELEMENTS)
  const items = shown.map((element) => {
    const kind = element.type === 'unknown' ? 'element' : element.type
    if (element.label) return `${kind} "${element.label}"`
    if (element.text) return `${kind} "${element.text}"`
    return kind
  })
  const more = count > shown.length ? ` and ${count - shown.length} more` : ''
  return `I see ${count} element${count === 1 ? '' : 's'} in the camera frame: ${items.join(', ')}${more}.`
}