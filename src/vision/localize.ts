/**
 * Deterministic visual-target resolution (Phase 1.7).
 *
 * Given a natural-language target instruction and a bounded element list, this
 * module finds 0..N matching elements WITHOUT guessing:
 *
 *   tier 1  exact label match      (trimmed, case-sensitive)
 *   tier 2  normalised label match (lowercase, whitespace-collapsed)
 *   tier 3  exact visible text     (trimmed, case-sensitive)
 *
 * The FIRST non-empty tier wins (deterministic priority). Candidates are then
 * filtered by (optional) expected type, confidence threshold, and a spatial
 * `within` box whose check uses the element CENTRE. The result is:
 *
 *   found       exactly one candidate survives
 *   ambiguous   more than one survives (candidates capped) → ASK/FAIL SAFELY
 *   not_found   nothing survived
 *
 * The resolver never head-matches, never fuzzes, and never invents a
 * candidate that was not actually observed.
 */
import { VISUAL_LIMITS } from './limits'
import { resolveClickPoint } from './bounds'
import type { ResolvedVisualTarget, VisualBounds, VisualElement, VisualResolveOptions } from './types'

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function elementLabel(element: VisualElement): string | undefined {
  return element.label && element.label.length > 0 ? element.label : undefined
}

function elementText(element: VisualElement): string | undefined {
  return element.text && element.text.length > 0 ? element.text : undefined
}

function centreWithin(element: VisualElement, box: VisualBounds): boolean {
  const x = element.bounds.x + element.bounds.width / 2
  const y = element.bounds.y + element.bounds.height / 2
  return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height
}

/** True when the raw number is a usable confidence in [0,1]. */
function isValidConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export function resolveVisualTarget(
  instruction: string,
  elements: VisualElement[],
  options?: VisualResolveOptions,
): ResolvedVisualTarget {
  const target = typeof instruction === 'string' ? instruction.trim() : ''
  if (target.length === 0) return { status: 'not_found' }

  const list = Array.isArray(elements) ? elements : []

  // First non-empty matching tier wins.
  let pool: VisualElement[] = []
  const exactLabel = list.filter((e) => elementLabel(e)?.trim() === target)
  if (exactLabel.length > 0) pool = exactLabel
  else {
    const normalized = normalizeLabel(target)
    const normalLabel = list.filter((e) => {
      const label = elementLabel(e)
      return label !== undefined && normalizeLabel(label) === normalized
    })
    if (normalLabel.length > 0) pool = normalLabel
    else {
      const exactText = list.filter((e) => elementText(e)?.trim() === target)
      if (exactText.length > 0) pool = exactText
    }
  }

  if (pool.length === 0) return { status: 'not_found' }

  // Deterministic filters — each is a real observation, never a guess.
  const expectedType = options?.expected_type
  if (expectedType) pool = pool.filter((e) => e.type === expectedType)

  const threshold = options?.confidence_threshold
  if (isValidConfidence(threshold)) pool = pool.filter((e) => e.confidence >= threshold)

  const within = options?.within
  if (within) pool = pool.filter((e) => centreWithin(e, within))

  // Stable ordering for ambiguity reporting: higher confidence first, then id.
  pool = [...pool].sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))

  if (pool.length === 1) return { status: 'found', element: pool[0] }
  if (pool.length > 1) {
    return {
      status: 'ambiguous',
      candidates: pool.slice(0, VISUAL_LIMITS.MAX_TARGET_CANDIDATES),
    }
  }
  return { status: 'not_found' }
}

/** True when the instruction resolves to exactly one actionable element. */
export function resolveSingleTarget(
  instruction: string,
  elements: VisualElement[],
  options?: VisualResolveOptions,
): { element: VisualElement } | { error: string } {
  const resolved = resolveVisualTarget(instruction, elements, options)
  if (resolved.status === 'found') return { element: resolved.element }
  if (resolved.status === 'ambiguous') {
    const labels = resolved.candidates.map((c) => c.label ?? c.id).join('", "')
    return { error: `The visual target "${instruction}" is ambiguous (candidates: "${labels}"). Refusing to guess.` }
  }
  return { error: `No visual element matched "${instruction}".` }
}

/** Viewport-space click point of a resolved element (bounds validated). */
export function resolvedClickPoint(
  element: VisualElement,
  viewport: { width: number; height: number },
): { point: { x: number; y: number } } | { error: string } {
  return resolveClickPoint(element, viewport)
}