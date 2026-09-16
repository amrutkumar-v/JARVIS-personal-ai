import { useJarvisStore } from '../../state/jarvis.store'
import { arcReactorPresentation } from './arcReactorModel'

/**
 * Fine technical readouts positioned around the Arc Reactor.
 *
 * Every value is REAL: the AI link reflects `capabilities.aiConnected`, the
 * device link reflects the backend connection phase, the voice readout the
 * live wake session state (real `voiceArmed` / `voiceState` / `isRecognizing`),
 * and the state label the actual engine status. Static module names (NEURAL
 * ENGINE, EXECUTION, VERIFICATION) are pure module markers — they never carry a
 * fabricated value. Nothing here synthesises state.
 */
export function CoreTelemetry() {
  const status = useJarvisStore.use.status()
  const isSpeaking = useJarvisStore.use.isSpeaking()
  const isRecognizing = useJarvisStore.use.isRecognizing()
  const capabilities = useJarvisStore.use.capabilities()
  const backend = useJarvisStore.use.backend()
  const voiceArmed = useJarvisStore.use.voiceArmed()
  const voiceState = useJarvisStore.use.voiceState()

  const p = arcReactorPresentation(status, isSpeaking)
  const aiLink = capabilities.aiConnected ? 'ONLINE' : 'OFFLINE'
  const deviceLink = backend.phase === 'connected' ? 'ONLINE' : backend.phase === 'idle' ? 'SYNC' : 'LINKING'
  const voice = voiceArmed ? voiceState.toUpperCase() : 'STANDBY'
  const voiceLive = voiceArmed || isRecognizing

  return (
    <div className="core-telemetry" aria-hidden="true">
      <span className="ct-item ct-neural"><i />NEURAL ENGINE</span>
      <span className="ct-item ct-exec"><i />EXECUTION</span>
      <span className="ct-item ct-verif"><i />VERIFICATION</span>
      <span className={`ct-item ct-ai${capabilities.aiConnected ? ' is-on' : ''}`}>
        AI&nbsp;LINK&nbsp;·&nbsp;{aiLink}
      </span>
      <span className={`ct-item ct-dev${backend.phase === 'connected' ? ' is-on' : ''}`}>
        DEVICE&nbsp;LINK&nbsp;·&nbsp;{deviceLink}
      </span>
      <span className={`ct-item ct-voice${voiceLive ? ' is-on' : ''}`}>
        VOICE&nbsp;·&nbsp;<b>{voice}</b>
      </span>
      <span className={`ct-item ct-state${p.variant === 'error' ? ' is-error' : ''}`}>
        STATE&nbsp;·&nbsp;{p.label}
      </span>
    </div>
  )
}