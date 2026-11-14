/**
 * Speech-to-text provider abstraction (Phase 1.6).
 *
 * Typed seam for command recognition. The provider owns microphone access and
 * emits FINAL transcripts; the VoiceManager decides what to do with them.
 * Nothing here hard-codes a vendor — browser mode uses the platform
 * recognizer, a native/future provider can replace it without touching the
 * Agent Core.
 */
import { createRecognition, type RecognitionLike } from './recognition'

export interface SpeechToTextCapabilities {
  available: boolean
  reason?: string
}

export interface SpeechToTextProvider {
  readonly id: string
  start(): boolean
  stop(): void
  abort(): void
  readonly listening: boolean
  readonly supported: boolean
  onTranscript(handler: (text: string) => void): () => void
  onInterimTranscript?(handler: (text: string) => void): () => void
  onStart(handler: () => void): () => void
  onEnd(handler: (reason: 'done' | 'aborted' | 'error') => void): () => void
  onError(handler: (message: string) => void): () => void
  capabilities(): SpeechToTextCapabilities
}

/** Browser speech-to-text provider over the platform SpeechRecognition surface. */
export class BrowserSpeechToTextProvider implements SpeechToTextProvider {
  readonly id = 'browser-speech-to-text'
  private recognition: RecognitionLike | null = null
  private transcriptHandlers: ((text: string) => void)[] = []
  private interimHandlers: ((text: string) => void)[] = []
  private startHandlers: (() => void)[] = []
  private endHandlers: ((reason: 'done' | 'aborted' | 'error') => void)[] = []
  private errorHandlers: ((message: string) => void)[] = []
  private activeFlag = false
  private stopping = false
  private denied = false
  /** True while the caller still wants the recognizer running. */
  private wantActive = false

  readonly supported: boolean

  constructor(recognition: RecognitionLike | null = createRecognition()) {
    this.recognition = recognition
    this.supported = recognition !== null
    if (recognition) this.wire(recognition)
  }

  get listening(): boolean {
    return this.activeFlag
  }

  onTranscript(handler: (text: string) => void): () => void {
    this.transcriptHandlers.push(handler)
    return () => {
      this.transcriptHandlers = this.transcriptHandlers.filter((h) => h !== handler)
    }
  }

  onInterimTranscript(handler: (text: string) => void): () => void {
    this.interimHandlers.push(handler)
    return () => {
      this.interimHandlers = this.interimHandlers.filter((h) => h !== handler)
    }
  }

  onStart(handler: () => void): () => void {
    this.startHandlers.push(handler)
    return () => {
      this.startHandlers = this.startHandlers.filter((h) => h !== handler)
    }
  }

  onEnd(handler: (reason: 'done' | 'aborted' | 'error') => void): () => void {
    this.endHandlers.push(handler)
    return () => {
      this.endHandlers = this.endHandlers.filter((h) => h !== handler)
    }
  }

  onError(handler: (message: string) => void): () => void {
    this.errorHandlers.push(handler)
    return () => {
      this.errorHandlers = this.errorHandlers.filter((h) => h !== handler)
    }
  }

  capabilities(): SpeechToTextCapabilities {
    if (!this.supported) {
      return { available: false, reason: 'Speech recognition is not supported in this browser.' }
    }
    if (this.denied) {
      return { available: false, reason: 'Microphone permission denied.' }
    }
    return { available: true }
  }

  start(): boolean {
    if (!this.recognition || this.activeFlag || this.denied) return false
    this.wantActive = true
    this.activeFlag = true
    this.stopping = false
    try {
      this.recognition.continuous = true
      this.recognition.interimResults = true
      this.recognition.lang = 'en-US'
      this.recognition.start()
      return true
    } catch (error) {
      this.activeFlag = false
      this.emitError(error instanceof Error ? error.message : 'Failed to start speech recognition.')
      return false
    }
  }

  stop(): void {
    this.wantActive = false
    if (!this.recognition || !this.activeFlag) return
    this.stopping = true
    try {
      this.recognition.stop()
    } catch {
      this.abort()
    }
  }

  abort(): void {
    this.wantActive = false
    this.activeFlag = false
    this.stopping = false
    try {
      this.recognition?.abort()
    } catch {
      /* already stopped */
    }
  }

  private emitTranscript(text: string): void {
    for (const handler of [...this.transcriptHandlers]) handler(text)
  }

  private emitInterim(text: string): void {
    for (const handler of [...this.interimHandlers]) handler(text)
  }

  private emitStart(): void {
    for (const handler of [...this.startHandlers]) handler()
  }

  private emitEnd(reason: 'done' | 'aborted' | 'error'): void {
    for (const handler of [...this.endHandlers]) handler(reason)
  }

  private emitError(message: string): void {
    for (const handler of [...this.errorHandlers]) handler(message)
  }

  private wire(rec: RecognitionLike): void {
    rec.onstart = () => {
      this.activeFlag = true
      this.emitStart()
    }

    rec.onresult = (event) => {
      let final = ''
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const alt = event.results[i]
        if (alt.isFinal) {
          final += alt[0]?.transcript ?? ''
        } else {
          interim += alt[0]?.transcript ?? ''
        }
      }
      const cleaned = final.trim()
      if (cleaned) this.emitTranscript(cleaned)
      const cleanedInterim = interim.trim()
      if (cleanedInterim) this.emitInterim(cleanedInterim)
    }

    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.denied = true
        this.activeFlag = false
        this.emitError('Microphone permission required, or speech recognition not allowed on this browser.')
      } else if (event.error === 'aborted' || event.error === 'no-speech') {
        /* handled via onend */
      } else {
        this.emitError(`Speech recognition error: ${event.error}`)
      }
    }

    rec.onend = () => {
      const wasActive = this.activeFlag
      const wasStopping = this.stopping
      this.activeFlag = false
      this.stopping = false
      if (wasActive) {
        if (wasStopping) this.emitEnd('done')
        else if (this.denied) this.emitEnd('error')
        else this.emitEnd('done')
      }
      // Chrome ends a `continuous` recognizer on its own after a stretch of
      // silence. The voice session is still open, so the command listener
      // resumes itself instead of leaving the session deaf for the rest of
      // its bounded lifetime. `wantActive` is false once the session stops
      // the listener, so this never resurrects a closed session.
      if (this.wantActive && !this.denied && !wasStopping) {
        try {
          this.activeFlag = true
          this.recognition?.start()
        } catch {
          this.activeFlag = false
        }
      }
    }
  }
}