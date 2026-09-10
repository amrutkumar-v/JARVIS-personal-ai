import type { PointerEvent, KeyboardEvent, CSSProperties } from 'react'
import { canHear } from '../../utils/capabilities'
import { useJarvisStore } from '../../state/jarvis.store'

interface Props {
  isListening: boolean
  isSpeaking: boolean
  onStart: () => void
  onStop: () => void
}

/**
 * Primary hold-to-speak control. Press/spacebar to talk, release to stop.
 * The surrounding radial bars animate while the mic is hot.
 */
export function VoiceButton({ isListening, isSpeaking, onStart, onStop }: Props) {
  const voiceEnabled = useJarvisStore.use.preferences().voiceEnabled
  const disabled = !canHear() || !voiceEnabled

  const handlePointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (disabled) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    onStart()
  }

  const handlePointerUp = () => {
    if (disabled) return
    onStop()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      if (isListening) onStop()
      else onStart()
    }
  }

  const label = disabled
    ? 'Voice unavailable'
    : isListening
      ? 'Listening — release to stop'
      : isSpeaking
        ? 'Say something…'
        : 'Hold to speak'

  return (
    <button
      type="button"
      className={`voice-button${isListening ? ' is-listening' : ''}${isSpeaking ? ' is-speaking' : ''}`}
      aria-label={label}
      aria-pressed={isListening}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      disabled={disabled}
    >
      <span className="voice-ring voice-ring-1" aria-hidden="true" />
      <span className="voice-ring voice-ring-2" aria-hidden="true" />
      <span className="voice-bars" aria-hidden="true">
        {Array.from({ length: 12 }).map((_, i) => (
          <span className="voice-bar" key={i} style={{ '--i': i } as CSSProperties} />
        ))}
      </span>
      <svg
        className="voice-mic"
        width="26"
        height="26"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10a7 7 0 0 0 14 0" />
        <line x1="12" y1="17" x2="12" y2="22" />
      </svg>
    </button>
  )
}