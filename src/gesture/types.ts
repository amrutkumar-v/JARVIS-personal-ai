/**
 * Phase 10 — hand gesture types.
 *
 * Purely descriptive: the shared vocabulary between the tracker, recognizer,
 * gate, mapping layer, engine executor and HUD. Types are intentionally
 * `readonly` so recognition results are stable snapshots, never mutated after
 * they leave the pipeline.
 */

/** The four physical gestures JARVIS understands (stable identity). */
export type GestureId = 'zoom_in' | 'zoom_out' | 'crush' | 'theme_change'

/** The precise, user-confirmed physical definitions — the spec, in code. */
export const GESTURE_DEFINITIONS: Record<GestureId, string> = {
  zoom_in: 'Two-hand pinch/expand — hands start close together, move apart. Trigger once after the movement clearly completes.',
  zoom_out: 'Two-hand pinch/contract — hands start separated, move together. Trigger once after the movement clearly completes.',
  crush: 'Closed fist — open hand closes into a fist and holds briefly. Recognized on the transition, triggers once with cooldown.',
  theme_change: 'Horizontal open-palm swipe — open hand moves horizontally across the view in a deliberate sweep. Triggers once per completed swipe.',
}

/** Command identity the existing JARVIS action layer executes. */
export type GestureCommand = 'zoom_in' | 'zoom_out' | 'crush' | 'theme_change'

/** One 21-point hand, normalised to units of frame width. */
export interface NormalizedHand {
  handIndex: number
  handedness: 'Left' | 'Right' | 'Unknown'
  confidence: number
  /** Landmark 0. */
  wrist: { x: number; y: number }
  /** Mean of the four MCP joints — the hand's body, robust to finger pose. */
  palmCenter: { x: number; y: number }
  /** Mean wrist→MCP distance, in units of frame width (scale invariant). */
  palmSize: number
  /** 0..1 — fraction of the four fingers that count as open. */
  openScore: number
  /** 0..1 — thumb openness (tip distance relative to palmSize). */
  thumbOpen: number
  /** All 21 normalized points (frame-width units). */
  landmarks: ReadonlyArray<{ x: number; y: number }>
  /** Zero-based FOUR-finger openness for index..pinky. */
  fingerOpen: readonly [boolean, boolean, boolean, boolean]
}

/** One inference frame from the tracker (already normalised). */
export interface RawHandSample {
  /** Monotonic sample id within the tracking session. */
  t: number
  /** Wall-clock ms of the video frame (monotonic for MediaPipe VIDEO mode). */
  ts: number
  hands: NormalizedHand[]
  /** Tracking quality 0..1 (e.g. mean detection confidence). */
  quality: number
}

/** A gesture detector vote for one sample. Never fires itself. */
export interface GestureCandidate {
  gesture: GestureId
  confidence: number
}

/** The recognised, gated intent that leaves the pipeline. */
export interface GestureIntent {
  gesture: GestureId
  confidence: number
  timestamp: number
  handCount: number
  trackingQuality: GestureTrackingQuality
}

/**
 * Tracking lifecycle (mission #2):
 * UNKNOWN → TRACKING → CANDIDATE → CONFIRMED → ACTION FIRED → COOLDOWN → READY.
 */
export type GesturePhase =
  | 'unknown' // initialized, nothing observed yet
  | 'tracking' // hands observed below the candidate bar
  | 'candidate' // a detector is actively forming a candidate
  | 'confirmed' // candidate accepted, about to fire
  | 'fired' // action fired, per-gesture cooldown running
  | 'cooldown' // repeated candidate rejected by cooldown (still observed)
  | 'error'

export type GestureTrackingQuality = 'none' | 'poor' | 'ok' | 'good'

/** UI-facing snapshot pushed to the store/HUD. */
export interface GestureStatus {
  active: boolean
  modelReady: boolean
  error?: string
  hands: number
  quality: GestureTrackingQuality
  phase: GesturePhase
  lastGesture: GestureIntent | null
}

/** Honest outcome of executing a gesture command — recognition ≠ action. */
export interface GestureActionResult {
  command: GestureCommand
  ok: boolean
  /** Machine-usable failure reason when `ok` is false. */
  reason?: string
  /** Human-readable detail shown in notices/HUD. */
  detail: string
}