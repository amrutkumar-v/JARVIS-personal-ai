/**
 * Visual transition verification (Phase 1.7) — the closed loop.
 *
 * After a visual action (click/type) the tool re-observes the screen and asks:
 * "did the expected_after visible state appear?" The verdict is then mapped
 * onto the EXISTING engine verification rails (never a new engine status):
 *
 *   verified    → tool verify() returns  ok:true   → engine status 'verified'
 *   refuted     → tool verify() returns  ok:false with "Refuted: …"
 *                                              → engine status 'failed'
 *   unverified  → tool verify() throws            → engine status 'unverified'
 *                  (the action ran; the outcome simply could not be confirmed)
 *
 * This module is PURE: it only compares the post-action element list against
 * the expected element description. It never claims an effect it did not see.
 */
import type { VisualElement, VisualTransitionOutcome } from './types'

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Deterministic presence check: expected_after matches an element's exact
 * label, normalised label, or exact visible text. Never fuzzy.
 */
export function findExpectedElement(
  expectedAfter: string,
  elements: VisualElement[],
): VisualElement | undefined {
  const target = typeof expectedAfter === 'string' ? expectedAfter.trim() : ''
  if (target.length === 0) return undefined
  const normalised = normalize(target)
  for (const element of elements) {
    if (typeof element.label === 'string' && element.label.trim() === target) return element
    if (typeof element.label === 'string' && normalize(element.label) === normalised) return element
    if (typeof element.text === 'string' && element.text.trim() === target) return element
  }
  return undefined
}

/** Verdict of one visual transition against its post-action element list. */
export function verifyVisualTransition(options: {
  /** Element description the action was supposed to make VISIBLE. */
  expectedAfter: string
  /** Elements observed AFTER the action was injected. */
  elements: VisualElement[]
}): VisualTransitionOutcome {
  const expected = typeof options.expectedAfter === 'string' ? options.expectedAfter.trim() : ''
  if (expected.length === 0) {
    return {
      verdict: 'unverified',
      message: 'No expected visible state was supplied; the action injected but its outcome was not confirmed.',
    }
  }
  if (!Array.isArray(options.elements)) {
    return {
      verdict: 'unverified',
      message: 'No post-action visual state was available; the outcome could not be confirmed.',
    }
  }
  const found = findExpectedElement(expected, options.elements)
  if (found) {
    return {
      verdict: 'verified',
      message: `Confirmed the visible element "${expected}" is present after the action.`,
      checks: ['expected after'],
    }
  }
  return {
    verdict: 'refuted',
    message: `Refuted: the visible element "${expected}" was not present after the action.`,
  }
}