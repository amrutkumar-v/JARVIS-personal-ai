import { useFrame } from '@react-three/fiber'
import { useJarvisStore } from '../state/jarvis.store'
import { PARAMS, live, speakingAmplitude } from './visual'

/** Multiplier applied to motion when the user prefers reduced motion. */
const MOTION_SCALE = 0.18
const SPEECH_SCALE = 1

/**
 * Dampens the shared visual parameters toward `PARAMS[status]` on every frame.
 * This is the only place that reads the status for the 3D scene — rendering
 * components read the already-smoothed `live` object.
 *
 * While the engine reports an ACTUAL speaking state (real TTS is emitting), the
 * speech energy follows a bounded, deterministic amplitude; otherwise it damps
 * back to its (zero) target. No fake speaking state is ever generated here.
 */
export function StatusDriver() {
  const status = useJarvisStore.use.status()
  const speaking = useJarvisStore.use.isSpeaking()
  const reduced = useJarvisStore.use.preferences().reducedMotion

  useFrame((state, dt) => {
    const t = PARAMS[status]
    const k = 1 - Math.exp(-dt * 2.5)
    live.active += (t.active - live.active) * k
    live.speed += (t.speed * (reduced ? MOTION_SCALE : 1) - live.speed) * k
    live.pulse += (t.pulse * (reduced ? 0.4 : 1) - live.pulse) * k
    live.color.lerp(t.color, k)

    // Speech reactivity: only real speech drives the amplitude; reduced motion
    // tames the gesture but keeps the honest energy level.
    const isRealSpeech = speaking || status === 'speaking'
    const targetSpeech = isRealSpeech
      ? speakingAmplitude(state.clock.elapsedTime, t.speech * (reduced ? 0.5 : SPEECH_SCALE))
      : 0
    live.speech += (targetSpeech - live.speech) * (1 - Math.exp(-dt * 4))
  })

  return null
}