import { useJarvisStore } from '../../state/jarvis.store'
import { dispatchInteraction } from '../../interaction/controller'
import { canHear } from '../../utils/capabilities'
import { voiceStatusPresentation } from './voiceStatusPresentation'

/**
 * Visible voice state HUD chip.
 *
 * Communicates the REAL voice session: state, armed/unarmed, active
 * listening/processing and honest OFFLINE when no voice capability exists.
 * When the wake word is possible, the chip is a real <button> that toggles the
 * wake session through the InteractionController — never a direct store write.
 * When wake is unavailable the chip is read-only (`disabled`), which still
 * satisfies keyboard accessibility (real button, visible focus) without a
 * dead-end action.
 */
export function VoiceStatus() {
  const voiceState = useJarvisStore.use.voiceState()
  const voiceArmed = useJarvisStore.use.voiceArmed()
  const isRecognizing = useJarvisStore.use.isRecognizing()
  const capabilities = useJarvisStore.use.capabilities()
  const preferences = useJarvisStore.use.preferences()

  const wakeWordAvailable =
    capabilities.wakeWordAvailable && preferences.wakeWordEnabled

  const anyVoice =
    canHear() || capabilities.speechSynthesisAvailable || wakeWordAvailable

  // A connected wake session or a hot recognizer is a live interaction; the
  // resting SLEEPING state needs no live indicator.
  const live = isRecognizing || voiceArmed

  const p = voiceStatusPresentation(voiceState, voiceArmed, isRecognizing, anyVoice)

  // If wake is available this is an interactive toggle; otherwise a read-only
  // status readout. Both are real buttons so focus is always visible.
  return (
    <button
      type="button"
      className={`voice-status is-${p.mode}${live ? ' is-live' : ''}`}
      aria-pressed={wakeWordAvailable ? voiceArmed : undefined}
      aria-label={wakeWordAvailable ? 'Toggle wake word' : p.accessibleLabel}
      title={wakeWordAvailable ? 'Wake word — toggle' : `Voice state: ${p.accessibleLabel}`}
      disabled={!wakeWordAvailable}
      onClick={() => {
        if (!wakeWordAvailable) return
        dispatchInteraction({ action: 'toggle_wake' })
      }}
    >
      <span className="voice-status-dot" aria-hidden="true" />
      <span className="voice-status-text">
        <span className="voice-status-kicker">VOICE</span>
        <span className="voice-status-state">{p.label}</span>
      </span>
    </button>
  )
}