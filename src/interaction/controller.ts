/**
 * Interaction surface — the single, gesture-ready abstraction every input
 * modality (mouse, keyboard, touch, and future webcam gestures) calls into.
 *
 * The gesture pipeline already maps physical gestures to `GestureCommand`
 * (zoom_in, zoom_out, crush, theme_change) and executes them through the real
 * stores. This controller generalizes that idea: ANY input source can dispatch
 * a normalized `InteractionAction`, and each action routes to the existing
 * stores and honestly reports whether it actually happened.
 */

import type { VisualEnvironmentId } from '../environment/types'
import type { PanelId } from '../panel/types'
import { usePanelLayoutStore } from '../panel/panelStore'
import { useZoomStore } from '../environment/zoomStore'
import { useJarvisStore } from '../state/jarvis.store'
import { nextTheme } from '../themes'
import { isEnvironmentId, stepEnvironment } from '../environment/registry'

export type InteractionAction =
  | 'next_environment'
  | 'previous_environment'
  | 'zoom_in'
  | 'zoom_out'
  | 'zoom_reset'
  | 'crush'
  | 'theme_change'
  | 'reset_layout'
  | 'focus_core'
  | 'open_panel'
  | 'close_panel'
  | 'toggle_wake'
  | 'listen_start'
  | 'listen_stop'

/** A panel-scoped action that needs a target id. */
export type PanelAction =
  | { action: 'open_panel'; panel: PanelId }
  | { action: 'close_panel'; panel: PanelId }

/** An environment-scoped action that needs a specific id. */
export type EnvironmentAction = {
  action: 'select_environment'
  environment: VisualEnvironmentId
}

export type InteractionRequest =
  | { action: InteractionAction }
  | PanelAction
  | EnvironmentAction

export interface InteractionResult {
  action: InteractionAction | 'select_environment'
  ok: boolean
  /** Machine-usable reason when `ok` is false. */
  reason?: string
  detail: string
}

/**
 * Voice is an async, manager-driven system (wake word provider, recognizer,
 * TTS). Its REAL business actions live in the voice session layer, not in the
 * stores, so the controller routes voice requests through handlers registered
 * once at app mount. Direct store mutation here would fabricate state the
 * voice manager never actually entered. If no handler is registered, the
 * request honestly fails with `voice_unavailable`.
 */
export interface VoiceInteractionHandlers {
  armWake?: () => void
  disarmWake?: () => void
  startListening?: () => void
  stopListening?: () => void
}

let voiceHandlers: VoiceInteractionHandlers = {}

export function registerVoiceHandlers(handlers: VoiceInteractionHandlers): void {
  voiceHandlers = handlers
}

function currentEnvironment(): VisualEnvironmentId {
  const id = usePanelLayoutStore.getState().environmentId
  return isEnvironmentId(id) ? id : 'arc'
}

/**
 * Dispatch a normalized interaction request. Every branch runs the REAL store
 * action and checks the honest outcome before reporting success — the same
 * contract as the gesture executor.
 */
export function dispatchInteraction(
  request: InteractionRequest,
  activeEnvironmentId: VisualEnvironmentId = currentEnvironment(),
): InteractionResult {
  switch (request.action) {
    case 'select_environment': {
      const before = activeEnvironmentId
      const after = isEnvironmentId(request.environment)
        ? request.environment
        : 'arc'
      if (after === before) {
        return {
          action: 'select_environment',
          ok: false,
          reason: 'already_active',
          detail: `Environment ${after} is already active.`,
        }
      }
      usePanelLayoutStore.getState().setEnvironment(after)
      return {
        action: 'select_environment',
        ok: true,
        detail: `Environment changed: ${before} → ${after}.`,
      }
    }
    case 'next_environment': {
      const before = activeEnvironmentId
      const after = stepEnvironment(before, 1)
      usePanelLayoutStore.getState().setEnvironment(after)
      return {
        action: 'next_environment',
        ok: after !== before,
        reason: after === before ? 'no_change' : undefined,
        detail: `Environment changed: ${before} → ${after}.`,
      }
    }
    case 'previous_environment': {
      const before = activeEnvironmentId
      const after = stepEnvironment(before, -1)
      usePanelLayoutStore.getState().setEnvironment(after)
      return {
        action: 'previous_environment',
        ok: after !== before,
        reason: after === before ? 'no_change' : undefined,
        detail: `Environment changed: ${before} → ${after}.`,
      }
    }
    case 'zoom_in': {
      const result = useZoomStore.getState().adjustZoom(activeEnvironmentId, 1)
      return {
        action: 'zoom_in',
        ok: result.moved,
        reason: result.bound ?? (result.moved ? undefined : 'no_change'),
        detail: result.moved
          ? `Zoomed in ${activeEnvironmentId}: ${Number(result.before.toFixed(3))} → ${Number(result.after.toFixed(3))}.`
          : result.bound === 'max'
            ? 'Maximum zoom level already reached.'
            : 'Zoom did not increase.',
      }
    }
    case 'zoom_out': {
      const result = useZoomStore.getState().adjustZoom(activeEnvironmentId, -1)
      return {
        action: 'zoom_out',
        ok: result.moved,
        reason: result.bound ?? (result.moved ? undefined : 'no_change'),
        detail: result.moved
          ? `Zoomed out ${activeEnvironmentId}: ${Number(result.before.toFixed(3))} → ${Number(result.after.toFixed(3))}.`
          : result.bound === 'min'
            ? 'Minimum zoom level already reached.'
            : 'Zoom did not decrease.',
      }
    }
    case 'zoom_reset': {
      const result = useZoomStore.getState().resetZoom(activeEnvironmentId)
      return {
        action: 'zoom_reset',
        ok: true,
        detail: `Zoom reset on ${activeEnvironmentId} to ${Number(result.after.toFixed(3))}.`,
      }
    }
    case 'crush': {
      const didClose = usePanelLayoutStore.getState().closeTopmostPanel()
      return {
        action: 'crush',
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
          action: 'theme_change',
          ok: false,
          reason: 'single_theme',
          detail: 'Only one theme is available — cannot cycle.',
        }
      }
      useJarvisStore.getState().setTheme(after)
      const actual = useJarvisStore.getState().theme
      return {
        action: 'theme_change',
        ok: actual === after,
        reason: actual === after ? undefined : 'theme_rejected',
        detail: actual === after
          ? `Theme changed: ${before} → ${after}.`
          : `Theme change was not applied (still ${before}).`,
      }
    }
    case 'reset_layout': {
      usePanelLayoutStore.getState().resetLayout()
      const p = usePanelLayoutStore.getState().panels
      const anyMoved = Object.values(p).some((panel) => panel.open)
      return {
        action: 'reset_layout',
        ok: true,
        detail: anyMoved ? 'Layout reset to defaults.' : 'Layout reset to defaults.',
      }
    }
    case 'focus_core': {
      usePanelLayoutStore.getState().focusPanel('core')
      return {
        action: 'focus_core',
        ok: true,
        detail: 'Core panel focused.',
      }
    }
    case 'open_panel': {
      const panel = (request as PanelAction).panel
      usePanelLayoutStore.getState().openPanel(panel)
      const opened = usePanelLayoutStore.getState().panels[panel]?.open ?? false
      return {
        action: 'open_panel',
        ok: opened,
        reason: opened ? undefined : 'panel_rejected',
        detail: opened ? `Panel ${panel} opened.` : `Panel ${panel} could not be opened.`,
      }
    }
    case 'close_panel': {
      const panel = (request as PanelAction).panel
      usePanelLayoutStore.getState().closePanel(panel)
      const closed = !(usePanelLayoutStore.getState().panels[panel]?.open ?? true)
      return {
        action: 'close_panel',
        ok: closed,
        reason: closed ? undefined : 'panel_rejected',
        detail: closed ? `Panel ${panel} closed.` : `Panel ${panel} could not be closed.`,
      }
    }
    case 'toggle_wake': {
      const armed = useJarvisStore.getState().voiceArmed
      const handler = armed ? voiceHandlers.disarmWake : voiceHandlers.armWake
      if (!handler) {
        return {
          action: 'toggle_wake',
          ok: false,
          reason: 'voice_unavailable',
          detail: `Wake word cannot be ${armed ? 'disarmed' : 'armed'} right now — the voice session is unavailable.`,
        }
      }
      handler()
      return {
        action: 'toggle_wake',
        ok: true,
        detail: armed
          ? 'Wake disarm request dispatched to the voice session.'
          : 'Wake arm request dispatched to the voice session.',
      }
    }
    case 'listen_start': {
      if (!voiceHandlers.startListening) {
        return {
          action: 'listen_start',
          ok: false,
          reason: 'voice_unavailable',
          detail: 'Listening cannot start — the voice session is unavailable.',
        }
      }
      voiceHandlers.startListening()
      return {
        action: 'listen_start',
        ok: true,
        detail: 'Listening start request dispatched to the voice session.',
      }
    }
    case 'listen_stop': {
      if (!voiceHandlers.stopListening) {
        return {
          action: 'listen_stop',
          ok: false,
          reason: 'voice_unavailable',
          detail: 'Listening cannot stop — the voice session is unavailable.',
        }
      }
      voiceHandlers.stopListening()
      return {
        action: 'listen_stop',
        ok: true,
        detail: 'Listening stop request dispatched to the voice session.',
      }
    }
    default: {
      const exhaustive: never = request as never
      return {
        action: 'focus_core',
        ok: false,
        reason: 'unknown_action',
        detail: `Unknown interaction action: ${String(exhaustive)}.`,
      }
    }
  }
}