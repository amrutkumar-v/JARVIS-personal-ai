import type { NormalizedHand } from './types'

/**
 * Phase 10 — landmark normalization (mission #3).
 *
 * Converts a raw MediaPipe 21-point hand into our scale-invariant NormalizedHand:
 * distances are expressed in units of FRAME WIDTH so recognition never depends
 * on camera resolution, distance-to-camera or video size. Only MediaPipe's
 * normalized (0..1) landmark coordinates are consumed.
 */

/** Distance between two normalized points in units of frame width. */
export function distancePx(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

const FINGER_MCP: readonly number[] = [5, 9, 13, 17]
const FINGER_TIP: readonly number[] = [8, 12, 16, 20]
const THUMB_TIP = 4

/** Fingers are "open" when their tip is far from the wrist, relative to palm size. */
export const OPEN_FINGER_RATIO = 1.5
export const OPEN_THUMB_RATIO = 1.2

export interface RawPoint {
  x: number
  y: number
}

export interface RawHand {
  handIndex: number
  handedness: 'Left' | 'Right' | 'Unknown'
  confidence: number
  landmarks: ReadonlyArray<RawPoint>
}

export function normalizeHand(raw: RawHand): NormalizedHand {
  const pts = raw.landmarks
  const wrist = pts[0] ?? { x: 0, y: 0 }

  const mcp = FINGER_MCP.map((i) => pts[i] ?? wrist)
  const palmSize =
    mcp.reduce((sum, p) => sum + distancePx(wrist, p), 0) / Math.max(1, mcp.length)

  const palmCenter = {
    x: (wrist.x + mcp.reduce((s, p) => s + p.x, 0) / mcp.length) / 2,
    y: (wrist.y + mcp.reduce((s, p) => s + p.y, 0) / mcp.length) / 2,
  }

  const fingerOpen = [0, 1, 2, 3].map(
    (_, i) =>
      palmSize > 0 &&
      distancePx(pts[FINGER_TIP[i]!] ?? wrist, wrist) / palmSize >= OPEN_FINGER_RATIO,
  ) as [boolean, boolean, boolean, boolean]

  const openFingers = fingerOpen.filter(Boolean).length
  const openScore = openFingers / 4

  const thumbTip = pts[THUMB_TIP] ?? wrist
  const thumbOpen =
    palmSize > 0 ? Math.min(1, distancePx(thumbTip, wrist) / palmSize / OPEN_THUMB_RATIO) : 0

  return {
    handIndex: raw.handIndex,
    handedness: raw.handedness,
    confidence: raw.confidence,
    wrist,
    palmCenter,
    palmSize,
    openScore,
    thumbOpen,
    landmarks: pts as ReadonlyArray<{ x: number; y: number }>,
    fingerOpen,
  }
}

export function normalizeHands(raws: RawHand[]): NormalizedHand[] {
  return raws.map(normalizeHand)
}