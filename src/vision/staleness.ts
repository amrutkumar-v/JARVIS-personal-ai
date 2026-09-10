/**
 * Stale-observation protection (Phase 1.9).
 *
 * A visual action must NEVER be injected on an observation that can no longer
 * be trusted. The decision "this element is HERE at client (x, y)" was derived
 * from two observable identities:
 *
 *   1. the WINDOW state used for coordinate conversion (screen `bounds` +
 *      measured `clientBounds`) — if the window moved, resized or closed since,
 *      the converted point may no longer name the same UI element;
 *   2. the SCREENSHOT pixels the element inventory came from — if the screen
 *      changed since analysis, the element may have moved, relabelled or
 *      vanished without the window itself moving.
 *
 * The gate re-observes BOTH before any injection and refuses when either
 * changed. Both comparisons are EXACT (coordinate / byte equality) — never
 * time-based, never probabilistic. A ticking clock, animation or focus ring is
 * a conservative refusal: "when uncertain → do not inject".
 */
import type { ScreenshotResult, WindowBounds, WindowStatus } from '../observation'

export type StalenessCause = 'window_closed' | 'window_changed' | 'screen_changed'

function boundsChanged(a: WindowBounds | undefined, b: WindowBounds | undefined): boolean {
  if (a === undefined || b === undefined) return a !== b
  return a.left !== b.left || a.top !== b.top || a.right !== b.right || a.bottom !== b.bottom
}

/** True when the window's actionable geometry changed between two statuses. */
export function windowStateChanged(previous: WindowStatus, current: WindowStatus): boolean {
  if (previous.exists !== current.exists) return true
  if (!current.exists) return false
  if (boundsChanged(previous.bounds, current.bounds)) return true
  if (boundsChanged(previous.clientBounds, current.clientBounds)) return true
  return false
}

/** True when two captures are pixel-identical (same framing, same content). */
export function screenshotsMatch(previous: ScreenshotResult, current: ScreenshotResult): boolean {
  return (
    previous.width === current.width &&
    previous.height === current.height &&
    previous.format === current.format &&
    previous.bytes === current.bytes
  )
}

/**
 * Pure staleness classifier: returns which identity (if any) invalidated the
 * observation the action was resolved against. `null` means the observation is
 * still current and an injection is safe to proceed.
 */
export function classifyStaleness(
  decisionWindow: WindowStatus,
  currentWindow: WindowStatus,
  decisionShot: ScreenshotResult,
  currentShot: ScreenshotResult,
): StalenessCause | null {
  if (!currentWindow.exists) return 'window_closed'
  if (windowStateChanged(decisionWindow, currentWindow)) return 'window_changed'
  if (!screenshotsMatch(decisionShot, currentShot)) return 'screen_changed'
  return null
}