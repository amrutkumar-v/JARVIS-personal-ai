import type { GestureCommand, GestureActionResult } from './types'
import type { VisualEnvironmentId } from '../environment/types'
import { useZoomStore } from '../environment/zoomStore'
import { nextTheme } from '../themes'
import { useJarvisStore } from '../state/jarvis.store'
import { usePanelLayoutStore } from '../panel/panelStore'

/**
 * Phase 10 — command executor (mission #6).
 *
 * Runs the real action and VERIFIES the real post-condition. This is the honest
 * bridge between gesture recognition and the existing store surface: each
 * command is dispatched to the real store, and the outcome is checked before
 * claiming success. An empty command is an error. Every rejection carries a
 * machine-readable `reason` for the engine notices.
 */

export function executeGestureCommand(
  command: GestureCommand,
  activeEnvironmentId: VisualEnvironmentId,
): GestureActionResult {
  if (!command) {
    return { command, ok: false, reason: 'empty_command', detail: 'Empty gesture command.' }
  }

  switch (command) {
    case 'zoom_in': {
      const zoomStore = useZoomStore.getState()
      const result = zoomStore.adjustZoom(activeEnvironmentId, 1)
      if (!result.moved) {
        return {
          command,
          ok: false,
          reason: result.bound ?? 'no_change',
          detail: result.bound === 'max'
            ? 'Maximum zoom level already reached.'
            : 'Zoom did not increase.',
        }
      }
      return {
        command,
        ok: true,
        detail: `Zoomed in ${activeEnvironmentId}: ${Number(result.before.toFixed(3))} → ${Number(result.after.toFixed(3))}.`,
      }
    }
    case 'zoom_out': {
      const zoomStore = useZoomStore.getState()
      const result = zoomStore.adjustZoom(activeEnvironmentId, -1)
      if (!result.moved) {
        return {
          command,
          ok: false,
          reason: result.bound ?? 'no_change',
          detail: result.bound === 'min'
            ? 'Minimum zoom level already reached.'
            : 'Zoom did not decrease.',
        }
      }
      return {
        command,
        ok: true,
        detail: `Zoomed out ${activeEnvironmentId}: ${Number(result.before.toFixed(3))} → ${Number(result.after.toFixed(3))}.`,
      }
    }
    case 'crush': {
      const didClose = usePanelLayoutStore.getState().closeTopmostPanel()
      return {
        command,
        ok: didClose,
        reason: didClose ? undefined : 'no_open_panel',
        detail: didClose ? 'Topmost open panel closed.' : 'No open panel to close.',
      }
    }
    case 'theme_change': {
      const before = useJarvisStore.getState().theme
      const after = nextTheme(before)
      if (after === before) {
        return {
          command,
          ok: false,
          reason: 'single_theme',
          detail: 'Only one theme is available — cannot cycle.',
        }
      }
      useJarvisStore.getState().setTheme(after)
      const actual = useJarvisStore.getState().theme
      return {
        command,
        ok: actual === after,
        reason: actual === after ? undefined : 'theme_rejected',
        detail: actual === after
          ? `Theme changed: ${before} → ${after}.`
          : `Theme change was not applied (still ${before}).`,
      }
    }
    default: {
      return { command, ok: false, reason: 'unknown_command', detail: `Unknown command: ${String(command)}.` }
    }
  }
}