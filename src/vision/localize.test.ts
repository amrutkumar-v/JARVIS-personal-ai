import { describe, expect, it } from 'vitest'
import { resolvedClickPoint, resolveSingleTarget, resolveVisualTarget } from './localize'
import { VISUAL_LIMITS } from './limits'
import type { VisualElement } from './types'

function element(partial: Partial<VisualElement> & { id: string; bounds: VisualElement['bounds'] }): VisualElement {
  return { type: 'button', confidence: 1, ...partial }
}

const ELEMENTS: VisualElement[] = [
  element({ id: 'settings', label: 'Settings', bounds: { x: 0, y: 0, width: 10, height: 10 } }),
  element({ id: 'search', type: 'input', label: 'Search', bounds: { x: 20, y: 0, width: 10, height: 10 } }),
  element({ id: 'cancel', label: 'Cancel', bounds: { x: 0, y: 20, width: 10, height: 10 } }),
  element({ id: 'submit-a', label: 'Submit', text: 'Submit', bounds: { x: 0, y: 40, width: 10, height: 10 } }),
  element({ id: 'submit-b', label: 'Submit', text: 'Submit', bounds: { x: 20, y: 40, width: 10, height: 10 } }),
  element({ id: 'save', type: 'text', label: 'Saved', text: 'Saved', bounds: { x: 40, y: 0, width: 10, height: 10 } }),
  element({ id: 'dim', label: 'Fuzzy', confidence: 0.3, bounds: { x: 60, y: 0, width: 10, height: 10 } }),
]

describe('resolveVisualTarget — label/text tiers', () => {
  it('resolves an exact label match to one element', () => {
    expect(resolveVisualTarget('Settings', ELEMENTS)).toEqual({ status: 'found', element: ELEMENTS[0] })
  })

  it('resolves a normalised label match (case + spaces)', () => {
    const done = resolveVisualTarget('  settings ', ELEMENTS)
    expect(done.status).toBe('found')
  })

  it('resolves an exact visible-text match when no label matches', () => {
    // 'Saved' matches BOTH the label and text; drop the label to force a text tier.
    const textOnly = ELEMENTS.map((e) => (e.id === 'save' ? { ...e, label: undefined } : e))
    const done = resolveVisualTarget('Saved', textOnly)
    expect(done.status).toBe('found')
  })

  it('prefers the label tier over a text tier', () => {
    const both: VisualElement[] = [
      element({ id: 'a', label: 'Submit', text: 'Send', bounds: { x: 0, y: 0, width: 1, height: 1 } }),
      element({ id: 'b', label: 'Send', text: 'Submit', bounds: { x: 2, y: 0, width: 1, height: 1 } }),
    ]
    // 'Submit' matches a's LABEL and b's TEXT — label tier wins deterministically.
    const done = resolveVisualTarget('Submit', both)
    expect(done.status).toBe('found')
    if (done.status === 'found') expect(done.element.id).toBe('a')
  })

  it('reports not_found for an empty instruction', () => {
    expect(resolveVisualTarget('', ELEMENTS)).toEqual({ status: 'not_found' })
    expect(resolveVisualTarget('   ', ELEMENTS)).toEqual({ status: 'not_found' })
  })

  it('reports not_found when nothing matches', () => {
    expect(resolveVisualTarget('Banana button', ELEMENTS)).toEqual({ status: 'not_found' })
  })
})

describe('resolveVisualTarget — filters and ambiguity', () => {
  it('filters by expected_type (turns a label match into not_found)', () => {
    const done = resolveVisualTarget('Search', ELEMENTS, { expected_type: 'button' })
    expect(done.status).toBe('not_found')
    const ok = resolveVisualTarget('Search', ELEMENTS, { expected_type: 'input' })
    expect(ok.status).toBe('found')
  })

  it('filters by confidence threshold (drops low-confidence candidates)', () => {
    expect(resolveVisualTarget('Fuzzy', ELEMENTS, { confidence_threshold: 0.5 }).status).toBe('not_found')
    expect(resolveVisualTarget('Fuzzy', ELEMENTS, { confidence_threshold: 0.2 }).status).toBe('found')
  })

  it('filters spatially by centre-inside-box (resolves an ambiguity)', () => {
    const done = resolveVisualTarget('Submit', ELEMENTS, { within: { x: 0, y: 40, width: 10, height: 10 } })
    expect(done.status).toBe('found')
    if (done.status === 'found') expect(done.element.id).toBe('submit-a')
  })

  it('reports ambiguous with bounded candidates when multiple survive', () => {
    const done = resolveVisualTarget('Submit', ELEMENTS)
    expect(done.status).toBe('ambiguous')
    if (done.status === 'ambiguous') {
      expect(done.candidates.map((c) => c.id)).toEqual(['submit-a', 'submit-b'])
      expect(done.candidates.length).toBeLessThanOrEqual(VISUAL_LIMITS.MAX_TARGET_CANDIDATES)
    }
  })

  it('never returns more candidates than MAX_TARGET_CANDIDATES', () => {
    const crowd = Array.from({ length: 25 }, (_, i) => element({ id: `dup-${i}`, label: 'Dup', bounds: { x: i % 5, y: i * 10, width: 1, height: 1 } }))
    const done = resolveVisualTarget('Dup', crowd)
    expect(done.status).toBe('ambiguous')
    if (done.status === 'ambiguous') {
      expect(done.candidates).toHaveLength(VISUAL_LIMITS.MAX_TARGET_CANDIDATES)
    }
  })
})

describe('resolveSingleTarget / resolvedClickPoint', () => {
  it('returns the element when uniquely resolved', () => {
    const done = resolveSingleTarget('Settings', ELEMENTS)
    expect(done).toEqual({ element: ELEMENTS[0] })
  })

  it('fails safely (no guess) on ambiguity', () => {
    const done = resolveSingleTarget('Submit', ELEMENTS)
    expect('error' in done).toBe(true)
    if ('error' in done) expect(done.error).toMatch(/ambiguous/)
  })

  it('fails safely on not found', () => {
    const done = resolveSingleTarget('Nope', ELEMENTS)
    expect('error' in done).toBe(true)
  })

  it('returns a click point for a resolved element only when its bounds are valid', () => {
    expect(resolvedClickPoint(ELEMENTS[0], { width: 100, height: 100 })).toEqual({ point: { x: 5, y: 5 } })
    const broken = element({ id: 'broken', bounds: { x: 0, y: 0, width: NaN, height: 10 } })
    expect('point' in resolvedClickPoint(broken, { width: 100, height: 100 })).toBe(false)
  })
})