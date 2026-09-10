/**
 * Minimal typed surface of the Web Speech API's SpeechRecognition.
 * Typed here because TS's lib.dom does not yet expose it uniformly.
 */

export interface RecognitionEvent {
  resultIndex: number
  results: ArrayLike<RecognitionAlternativeList>
}

export interface RecognitionAlternativeList {
  isFinal: boolean
  length: number
  [index: number]: { transcript: string }
}

export interface RecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
  onspeechstart: (() => void) | null
  onspeechend: (() => void) | null
  onaudiostart: (() => void) | null
  onaudioend: (() => void) | null
  onnomatch: (() => void) | null
}

type Ctor = new () => RecognitionLike

function ctor(): Ctor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: Ctor
    webkitSpeechRecognition?: Ctor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function createRecognition(): RecognitionLike | null {
  const C = ctor()
  return C ? new C() : null
}