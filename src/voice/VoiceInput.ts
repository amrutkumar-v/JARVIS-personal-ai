import { createRecognition, type RecognitionLike } from './recognition'

export interface VoiceInputCallbacks {
  onStart(): void
  onInterim(text: string): void
  onFinal(text: string): void
  onEnd(reason: 'done' | 'aborted' | 'error' | 'unavailable'): void
  onError(error: string): void
}

export type VoiceInputEndReason = VoiceInputCallbacks['onEnd'] extends (reason: infer R) => void
  ? R
  : never

/** Voice-input backend abstraction. Phase 0: browser SpeechRecognition. */
export interface VoiceInput {
  start(): boolean
  stop(): void
  abort(): void
  readonly isListening: boolean
  readonly supported: boolean
}

export class BrowserVoiceInput implements VoiceInput {
  private recognition: RecognitionLike | null = null
  private callbacks: VoiceInputCallbacks
  private active = false
  private finalReceived = false
  private stopping = false
  private ended = true

  readonly supported: boolean

  constructor(callbacks: VoiceInputCallbacks) {
    this.callbacks = callbacks
    this.recognition = createRecognition()
    this.supported = this.recognition !== null
    if (this.recognition) this.wire(this.recognition)
  }

  get isListening(): boolean {
    return this.active
  }

  start(): boolean {
    if (!this.recognition || this.active) return false
    this.active = true
    this.finalReceived = false
    this.stopping = false
    this.ended = false
    try {
      this.recognition.continuous = true
      this.recognition.interimResults = true
      this.recognition.lang = 'en-US'
      this.recognition.start()
      return true
    } catch (error) {
      this.active = false
      this.callbacks.onError(error instanceof Error ? error.message : 'Failed to start recognition')
      return false
    }
  }

  stop(): void {
    if (!this.recognition || !this.active) return
    this.stopping = true
    try {
      // finalise any pending interim, then stop
      this.recognition.stop()
    } catch {
      this.abort()
    }
  }

  abort(): void {
    this.active = false
    this.stopping = false
    this.recognition?.abort()
    if (!this.ended) {
      this.ended = true
      this.callbacks.onEnd('aborted')
    }
  }

  private wire(rec: RecognitionLike): void {
    rec.onstart = () => {
      this.active = true
      this.callbacks.onStart()
    }

    rec.onspeechstart = () => {
      this.callbacks.onInterim('')
    }

    rec.onresult = (event) => {
      let interim = ''
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const alt = event.results[i]
        const transcript = alt[0]?.transcript ?? ''
        if (alt.isFinal) final += transcript
        else interim += transcript
      }
      if (final) {
        this.finalReceived = true
        this.callbacks.onFinal(final.trim())
        // After a final result, let speech settle and auto-stop.
        window.setTimeout(() => {
          if (this.active) this.stop()
        }, 700)
      } else if (interim) {
        this.callbacks.onInterim(interim.trim())
      }
    }

    rec.onerror = (event) => {
      // not-allowed / no-speech are expected transitions; report the rest
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.callbacks.onError('Microphone permission required, or recognition not allowed on this browser.')
      } else if (event.error === 'no-speech') {
        /* silent — handled via onend */
      } else if (event.error !== 'aborted') {
        this.callbacks.onError(`Speech recognition error: ${event.error}`)
      }
    }

    rec.onend = () => {
      this.ended = true
      const wasActive = this.active
      const wasStopping = this.stopping
      this.active = false
      this.stopping = false
      if (wasActive) {
        if (wasStopping || this.finalReceived) this.callbacks.onEnd('done')
        else this.callbacks.onEnd('error')
      }
    }
  }
}