/**
 * Viewport → virtual-screen → client-relative coordinate conversion (Phase 1.7, 1.8).
 *
 * The vision layer reasons in VIEWPORT pixels (the screenshot). The desktop
 * layer acts in two OTHER explicit systems (Phase 1.5):
 *   - SCREEN px  = absolute virtual-desktop coordinates, may include negative
 *                 origins (multi-monitor) — used ONLY by desktop.move/cursor.
 *   - CLIENT px  = coordinates relative to the TARGET window's client origin
 *                 — used ONLY by window-targeted actions (click/type…).
 *
 * This module converts explicitly and REFUSES every step it cannot prove:
 *   - the screenshot must cover the virtual screen exactly (dimensions must
 *     match) — no blind scaling of coordinates is ever performed;
 *   - the client point must land INSIDE the window (clientBounds exact when
 *     measured — Phase 1.8; otherwise the documented frame-offset
 *     approximation on `bounds` is used and never silently scaled).
 *
 * All functions are pure and unit-testable.
 */
import type { VirtualScreen } from '../desktop'
import type { WindowBounds } from '../observation'
import type { VisualViewport } from './types'

export type Point2D = { x: number; y: number }

/** Convert a viewport point (pixels in a screenshot) to virtual-screen px. */
export function viewportPointToScreen(
  viewport: VisualViewport,
  virtualScreen: VirtualScreen,
  x: number,
  y: number,
): { screen: Point2D } | { error: string } {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'The viewport point must contain finite numbers.' }
  if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
    return { error: `The viewport point (${x}, ${y}) lies outside the analysed screenshot.` }
  }
  if (viewport.width !== virtualScreen.width || viewport.height !== virtualScreen.height) {
    return {
      error: `Screenshot (${viewport.width}x${viewport.height}) does not match the virtual desktop (${virtualScreen.width}x${virtualScreen.height}); coordinates are not converted without a matching surface.`,
    }
  }
  return { screen: { x: virtualScreen.left + x, y: virtualScreen.top + y } }
}

/**
 * Convert an absolute screen point into client-relative px of a window.
 *
 * When `clientBounds` is provided (Phase 1.8, measured by the native agent
 * with GetClientRect + ClientToScreen) the conversion is EXACT: those bounds
 * describe the client area in screen pixels, so a screenshot pixel maps 1:1
 * onto the client origin. When it is absent, the legacy frame-offset
 * approximation against `bounds` is used — never scaled, always documented.
 */
export function screenPointToClient(
  bounds: WindowBounds,
  screen: Point2D,
  clientBounds?: WindowBounds,
): { client: Point2D } | { error: string } {
  if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y)) {
    return { error: 'The screen point must contain finite numbers.' }
  }
  if (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.top) || !Number.isFinite(bounds.right) || !Number.isFinite(bounds.bottom)) {
    return { error: 'Window bounds must contain finite numbers.' }
  }
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
    return { error: 'Window bounds are inverted and cannot be used.' }
  }
  if (clientBounds) {
    if (
      !Number.isFinite(clientBounds.left) ||
      !Number.isFinite(clientBounds.top) ||
      !Number.isFinite(clientBounds.right) ||
      !Number.isFinite(clientBounds.bottom)
    ) {
      return { error: 'The client bounds must contain finite numbers.' }
    }
    if (clientBounds.right <= clientBounds.left || clientBounds.bottom <= clientBounds.top) {
      return { error: 'The client bounds are inverted and cannot be used.' }
    }
    if (
      screen.x < clientBounds.left ||
      screen.x >= clientBounds.right ||
      screen.y < clientBounds.top ||
      screen.y >= clientBounds.bottom
    ) {
      return {
        error: `Screen point (${screen.x}, ${screen.y}) lies outside the window client area (${clientBounds.left},${clientBounds.top})-(${clientBounds.right},${clientBounds.bottom}).`,
      }
    }
    return { client: { x: screen.x - clientBounds.left, y: screen.y - clientBounds.top } }
  }
  if (screen.x < bounds.left || screen.x >= bounds.right || screen.y < bounds.top || screen.y >= bounds.bottom) {
    return {
      error: `Screen point (${screen.x}, ${screen.y}) lies outside window bounds (${bounds.left},${bounds.top})-(${bounds.right},${bounds.bottom}).`,
    }
  }
  // Legacy fallback: the frame/title-bar offset is not measured, so the client
  // point is surface-relative. Documented everywhere the conversion is consumed:
  // the tool reports the outcome (verification) honestly.
  return { client: { x: screen.x - bounds.left, y: screen.y - bounds.top } }
}

/** Full pipeline: viewport → screen → client. Errors propagate untouched. */
export function resolveClientPoint(
  viewport: VisualViewport,
  virtualScreen: VirtualScreen,
  windowBounds: WindowBounds,
  x: number,
  y: number,
  clientBounds?: WindowBounds,
): { client: Point2D } | { error: string } {
  const screenStep = viewportPointToScreen(viewport, virtualScreen, x, y)
  if ('error' in screenStep) return screenStep
  return screenPointToClient(windowBounds, screenStep.screen, clientBounds)
}