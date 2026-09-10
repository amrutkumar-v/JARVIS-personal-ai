/**
 * Visual-Understanding types (Phase 1.7) — EYES.
 *
 * The vision layer answers ONE question: "what recognisable UI elements are
 * on screen right now, and where?" It NEVER decides how to act on them — that
 * remains the Agent Core loop + the existing desktop tool tiers.
 *
 * Safety contract for the whole module:
 *   - elements are STRUCTURAL facts (id, type, label, bounds, confidence);
 *     the analysis never invents a semantic that was not observed.
 *   - `text` on an element is bounded and kept out of traces (see sanitize.ts);
 *     screenshots are transient and never persisted or logged.
 *   - target resolution is deterministic and ambiguity-safe: the resolver
 *     reports `found` ONLY for an exact match and `ambiguous` for 2+ equally
 *     good candidates — it never guesses.
 */

export type VisualElementType =
  | 'button'
  | 'input'
  | 'text'
  | 'link'
  | 'checkbox'
  | 'menu'
  | 'dialog'
  | 'icon'
  | 'unknown'

/** Allow-list for `expected_type` tool params (never accepts anything else). */
export const VISUAL_ELEMENT_TYPES: readonly VisualElementType[] = [
  'button',
  'input',
  'text',
  'link',
  'checkbox',
  'menu',
  'dialog',
  'icon',
  'unknown',
]

/** Element footprint in VIEWPORT pixels (non-negative finite numbers). */
export interface VisualBounds {
  /** Left edge (viewport px, origin top-left). */
  x: number
  /** Top edge (viewport px, origin top-left). */
  y: number
  width: number
  height: number
}

/** One recognisable UI element on the analysed screenshot. */
export interface VisualElement {
  /** Provider-local element id (unique within one analysis). */
  id: string
  type: VisualElementType
  /** Short semantic name, when the provider can derive one (bounded). */
  label?: string
  /** Bounded visible text (MAX_VISUAL_TEXT_LENGTH); absent when not a text leaf. */
  text?: string
  bounds: VisualBounds
  /** Provider confidence 0..1; NEVER a guarantee of meaning. */
  confidence: number
}

/** The screenshot area the analysis covers (viewport px). */
export interface VisualViewport {
  width: number
  height: number
}

export interface VisionAnalysisResult {
  viewport: VisualViewport
  /** Bounded to MAX_VISUAL_ELEMENTS by the analysis / tool layer. */
  elements: VisualElement[]
  providerId: string
  /** Model id reported by the provider (undefined for deterministic fakes). */
  modelId?: string
  analyzedAt: number
}

/* ---------------------------------------------------------------- resolution */

export type VisualResolveStatus = 'found' | 'ambiguous' | 'not_found'

export interface VisualResolveOptions {
  /** Only elements of this type are candidates (deterministic filter). */
  expected_type?: VisualElementType
  /** Only elements with confidence >= threshold are candidates (0..1). */
  confidence_threshold?: number
  /** Optional viewport box; a candidate's CENTRE must land inside it. */
  within?: VisualBounds
}

export type ResolvedVisualTarget =
  | { status: 'found'; element: VisualElement }
  | { status: 'ambiguous'; candidates: VisualElement[] }
  | { status: 'not_found' }

/* -------------------------------------------------------- transition verdicts */

/**
 * Closed-loop verdict of a visual action (Phase 1.7).
 *
 *   verified    the expected_after state WAS observed on the post-action screen
 *   unverified  the action ran but the outcome could not be confirmed (no
 *               expected state, or no post-state evidence available)
 *   refuted     the expected_after state was explicitly NOT present after the
 *               action — the claimed transition did not materialise
 */
export type VisualTransitionVerdict = 'verified' | 'unverified' | 'refuted'

export interface VisualTransitionOutcome {
  verdict: VisualTransitionVerdict
  /** Provider-safe, model-readable explanation. */
  message: string
  /** Named checks performed (present only when verified). */
  checks?: string[]
}