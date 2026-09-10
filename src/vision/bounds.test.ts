import { describe, expect, it } from 'vitest'
import { chooseClickPoint, clipVisualElement, clipVisualElements, resolveClickPoint, validateVisualBounds } from './bounds'
import { VISUAL_LIMITS } from './limits'
import type { VisualElement } from './types'

const VIEWPORT = { width: 100, height: 100 }

describe('validateVisualBounds', () => {
  it('accepts a finite, positive, in-viewport rectangle', () => {
    const done = validateVisualBounds({ x: 10, y: 20, width: 30, height: 40 }, VIEWPORT)
    expect(done.ok).toBe(true)
    if (done.ok) expect(done.bounds).toEqual({ x: 10, y: 20, width: 30, height: 40 })
  })

  it('rejects non-object input', () => {
    expect(validateVisualBounds(undefined, VIEWPORT)).toEqual({ ok: false, reason: 'Element bounds are missing.' })
  })

  it('rejects NaN / Infinity / non-number bounds', () => {
    expect(validateVisualBounds({ x: NaN, y: 0, width: 1, height: 1 }, VIEWPORT).ok).toBe(false)
    expect(validateVisualBounds({ x: Infinity, y: 0, width: 1, height: 1 }, VIEWPORT).ok).toBe(false)
    expect(validateVisualBounds({ x: '0', y: 0, width: 1, height: 1 }, VIEWPORT).ok).toBe(false)
    expect(validateVisualBounds({ x: 0, y: 0, width: 1, height: 1 } as never, VIEWPORT).ok).toBe(true)
  })

  it('rejects negative and zero-area rectangles', () => {
    expect(validateVisualBounds({ x: -1, y: 0, width: 1, height: 1 }, VIEWPORT).ok).toBe(false)
    expect(validateVisualBounds({ x: 0, y: -2, width: 1, height: 1 }, VIEWPORT).ok).toBe(false)
    expect(validateVisualBounds({ x: 0, y: 0, width: 0, height: 1 }, VIEWPORT).ok).toBe(false)
    expect(validateVisualBounds({ x: 0, y: 0, width: 1, height: 0 }, VIEWPORT).ok).toBe(false)
  })

  it('rejects rectangles that overflow the viewport', () => {
    expect(validateVisualBounds({ x: 90, y: 0, width: 20, height: 1 }, VIEWPORT).ok).toBe(false)
    expect(validateVisualBounds({ x: 0, y: 95, width: 1, height: 10 }, VIEWPORT).ok).toBe(false)
  })
})

describe('chooseClickPoint', () => {
  it('returns the rounded centre of the element', () => {
    expect(chooseClickPoint({ x: 10, y: 20, width: 31, height: 41 })).toEqual({ x: 26, y: 41 })
    expect(chooseClickPoint({ x: 0, y: 0, width: 1, height: 1 })).toEqual({ x: 1, y: 1 })
  })
})

describe('resolveClickPoint', () => {
  const element: VisualElement = { id: 'e1', type: 'button', label: 'Go', bounds: { x: 5, y: 5, width: 10, height: 10 }, confidence: 1 }

  it('validates then chooses the click point', () => {
    expect(resolveClickPoint(element, VIEWPORT)).toEqual({ point: { x: 10, y: 10 } })
  })

  it('fails before returning a point for an invalid element', () => {
    const broken = { ...element, bounds: { x: 5, y: 5, width: NaN, height: 10 } }
    expect('point' in resolveClickPoint(broken, VIEWPORT)).toBe(false)
  })
})

describe('element hygiene', () => {
  it('clips overlong labels and text to MAX_VISUAL_TEXT_LENGTH', () => {
    const long = 'x'.repeat(VISUAL_LIMITS.MAX_VISUAL_TEXT_LENGTH + 50)
    const clipped = clipVisualElement({ id: 'e', type: 'text', label: long, text: long, bounds: { x: 0, y: 0, width: 1, height: 1 }, confidence: 1 })
    expect(clipped.label?.length).toBe(VISUAL_LIMITS.MAX_VISUAL_TEXT_LENGTH)
    expect(clipped.text?.length).toBe(VISUAL_LIMITS.MAX_VISUAL_TEXT_LENGTH)
  })

  it('caps the element list at MAX_VISUAL_ELEMENTS', () => {
    const many = Array.from({ length: VISUAL_LIMITS.MAX_VISUAL_ELEMENTS + 20 }, (_, i) => ({
      id: `el-${i}`,
      type: 'button' as const,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      confidence: 1,
    }))
    expect(clipVisualElements(many)).toHaveLength(VISUAL_LIMITS.MAX_VISUAL_ELEMENTS)
  })
})