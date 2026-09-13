import type { GestureUiState } from '../../state/jarvis.store'
import { GESTURE_LABELS } from '../../gesture'
import type { GesturePhase } from '../../gesture'

/**
 * Phase 10 — gesture HUD.
 *
 * A minimal always-on overlay (when gestures are active) that reflects the REAL
 * tracker output every ~300ms: live hand count, tracking quality, lifecycle
 * phase and the last gesture that actually fired. Purely presentational — it
 * never drives the controller.
 */

const PHASE_LABEL: Record<GesturePhase, string> = {
  unknown: 'off',
  tracking: 'TRACKING',
  candidate: 'CANDIDATE',
  confirmed: 'CONFIRMED',
  fired: 'FIRED',
  cooldown: 'COOLDOWN',
  error: 'ERROR',
}

function phraseFor(state: GestureUiState): string {
  if (state.error) {
    const map: Record<string, string> = {
      camera_unavailable: 'No camera available',
      camera_stopped: 'Camera stopped',
      model_load_failed: 'Model failed to load',
      no_document: 'Browser unavailable',
    }
    return map[state.error] ?? state.error
  }
  if (!state.active) return 'off'
  if (!state.modelReady) return 'loading model…'
  if (state.phase === 'fired' && state.lastGesture) {
    return `${GESTURE_LABELS[state.lastGesture.gesture]}`
  }
  return PHASE_LABEL[state.phase]
}

function qualityDot(state: GestureUiState): string {
  if (state.hands === 0) return 'q-none'
  return `q-${state.quality}`
}

export function GestureHud({ gesture }: { gesture: GestureUiState }) {
  if (!gesture.active && !gesture.error) return null
  return (
    <div
      className={`gesture-hud${gesture.active ? ' is-active' : ' is-error'}`}
      aria-live="polite"
    >
      <span className="gesture-hud-title">GESTURE</span>
      <span className={`gesture-hud-dot ${qualityDot(gesture)}`} aria-hidden="true" />
      <span className="gesture-hud-msg">{phraseFor(gesture)}</span>
      {gesture.hands > 0 ? (
        <span className="gesture-hud-count">{gesture.hands} hand{gesture.hands === 1 ? '' : 's'}</span>
      ) : null}
    </div>
  )
}