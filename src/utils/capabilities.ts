/** True if the runtime can speak using the platform SpeechSynthesis API. */
export function canSpeak(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/**
 * True if the runtime can transcribe microphone audio.
 * Web Speech recognition works in Chromium-family and Safari (long-press enabled).
 */
export function canHear(): boolean {
  if (typeof window === 'undefined') return false
  return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window
}

/**
 * True if `udp` (mouse, touch, gesture) input can be used to steer the scene.
 */
export function canUsePointer(): boolean {
  return typeof window !== 'undefined' && 'PointerEvent' in window
}

/** Render low frame-rate when the context requests less animation. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** Hardware concurrency, used to scale particle density. */
export function deviceTier(): 'low' | 'medium' | 'high' {
  if (
    (typeof navigator === 'undefined' || navigator.hardwareConcurrency === 0) &&
    typeof window !== 'undefined' &&
    !(window as unknown as { WebGLRenderingContext?: unknown }).WebGLRenderingContext
  ) {
    return 'low'
  }
  const cores = navigator.hardwareConcurrency ?? 4
  if (cores <= 4) return 'medium'
  return 'high'
}