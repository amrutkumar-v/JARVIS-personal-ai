/**
 * Visual element bounds + click-point math (Phase 1.7) — pure, deterministic.
 *
 * Coordinate safety rules (mirror the desktop layer):
 *   - bounds are finite, non-negative numbers; NaN / Infinity / negatives are
 *     REJECTED, never silently coerced.
 *   - an element must (a) have a positive area and (b) sit fully inside the
 *     analysed viewport to be actionable.
 *   - click points are the ROUNDED center of the element; we never "clamp" a
 *     broken element into existence.
 *
 * All functions in this module are side-effect free and unit-testable.
 */
import { VISUAL_LIMITS } from './limits'
import type { VisualBounds, VisualElement, VisualViewport } from './types'

export type BoundsValidation = { ok: true; bounds: VisualBounds } | { ok: false; reason: string }

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Validate a raw bounds object (rejects NaN/Infinity/negatives/zero area). */
export function validateVisualBounds(raw: unknown, viewport?: VisualViewport): BoundsValidation {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'Element bounds are missing.' }
  const b = raw as Record<string, unknown>
  if (!isFiniteNumber(b.x)) return { ok: false, reason: 'Element bound "x" must be a finite number.' }
  if (!isFiniteNumber(b.y)) return { ok: false, reason: 'Element bound "y" must be a finite number.' }
  if (!isFiniteNumber(b.width)) return { ok: false, reason: 'Element bound "width" must be a finite number.' }
  if (!isFiniteNumber(b.height)) return { ok: false, reason: 'Element bound "height" must be a finite number.' }

  const bounds: VisualBounds = { x: b.x, y: b.y, width: b.width, height: b.height }
  if (b.x < 0 || b.y < 0) return { ok: false, reason: 'Element bounds must not extend off the top or left of the viewport.' }
  if (bounds.width <= 0 || bounds.height <= 0) {
    return { ok: false, reason: 'Element bounds must have a positive width and height.' }
  }
  if (viewport) {
    if (bounds.x + bounds.width > viewport.width || bounds.y + bounds.height > viewport.height) {
      return { ok: false, reason: 'Element bounds extend outside the analysed viewport.' }
    }
  }
  return { ok: true, bounds }
}

/** Centre point of a bounds rectangle (viewport px, rounded). */
export function chooseClickPoint(bounds: VisualBounds): { x: number; y: number } {
  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  }
}

/** Validate an element then choose its click point; nothing else runs on failure. */
export function resolveClickPoint(
  element: VisualElement,
  viewport: VisualViewport,
): { point: { x: number; y: number } } | { error: string } {
  const validated = validateVisualBounds(element.bounds, viewport)
  if (!validated.ok) return { error: validated.reason }
  return { point: chooseClickPoint(validated.bounds) }
}

/* ---------------------------------------------------------------- hygiene */

/** Bound one element's label/text so no dump ever grows without limit. */
export function clipVisualElement(element: VisualElement): VisualElement {
  const clip = (value: string | undefined): string | undefined => {
    if (typeof value !== 'string' || value.length === 0) return undefined
    return value.length > VISUAL_LIMITS.MAX_VISUAL_TEXT_LENGTH
      ? value.slice(0, VISUAL_LIMITS.MAX_VISUAL_TEXT_LENGTH)
      : value
  }
  return {
    ...element,
    label: clip(element.label),
    text: clip(element.text),
  }
}

/** Bounded element list: clipped text + capped at MAX_VISUAL_ELEMENTS. */
export function clipVisualElements(elements: VisualElement[]): VisualElement[] {
  return elements.slice(0, VISUAL_LIMITS.MAX_VISUAL_ELEMENTS).map(clipVisualElement)
}