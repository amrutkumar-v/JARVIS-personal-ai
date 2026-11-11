/**
 * Wake-word provider abstraction (Phase 1.6).
 *
 * NOT tied to any vendor. A provider listens for the wake phrase and fires
 * `onWake` ONLY when the canonical phrase is detected (with an optional
 * trailing command). While listening for the wake phrase it must NOT forward
 * arbitrary microphone content — non-matching transcripts are dropped.
 * Browser mode uses the platform recognizer + deterministic normalization; a
 * future native provider may perform fully local detection without sending
 * audio anywhere.
 */
import { createRecognition, type RecognitionLike } from './recognition'
import { splitWakeAndCommand, type WakeParse } from './normalization'
import type { VoiceWakeMode, WakePayload } from './types'

export interface WakeWordCapabilities {
  available: boolean
  reason?: string
}

export interface WakeWordProvider {
  readonly id: string
  /** Begin wake listening. Returns false when unsupported/unavailable. */
  start(mode: VoiceWakeMode): boolean
  stop(): void
  readonly active: boolean
  readonly supported: boolean
  onWake(handler: (payload: WakePayload) => void): () => void
  onError(handler: (message: string) => void): () => void
  capabilities(): WakeWordCapabilities
}

/**
 * Browser wake-word provider over the platform SpeechRecognition surface.
 * Continuous recognition feeds transcripts through `splitWakeAndCommand`; only
 * matches are emitted, everything else is discarded before it can reach the
 * Agent Core. Audio is still handled by the platform recognizer — the docs
 * say so honestly; a local on-device detector is a future native seam.
 */
export class BrowserWakeWordProvider implements WakeWordProvider {
  readonly id = 'browser-wake-word'
  private recognition: RecognitionLike | null = null
  private wakeHandlers: ((payload: WakePayload) => void)[] = []
  private errorHandlers: ((message: string) => void)[] = []
  private activeFlag = false
  private stopping = false
  private denied = false

  readonly supported: boolean

  constructor(recognition: RecognitionLike | null = createRecognition()) {
    this.recognition = recognition
    this.supported = recognition !== null
    if (recognition) this.wire(recognition)
  }

  get active(): boolean {
    return this.activeFlag
  }

  onWake(handler: (payload: WakePayload) => void): () => void {
    this.wakeHandlers.push(handler)
    return () => {
      this.wakeHandlers = this.wakeHandlers.filter((h) => h !== handler)
    }
  }

  onError(handler: (message: string) => void): () => void {
    this.errorHandlers.push(handler)
    return () => {
      this.errorHandlers = this.errorHandlers.filter((h) => h !== handler)
    }
  }

  capabilities(): WakeWordCapabilities {
    if (!this.supported) {
      return { available: false, reason: 'Speech recognition is not supported in this browser.' }
    }
    if (this.denied) {
      return { available: false, reason: 'Microphone permission denied.' }
    }
    return { available: true }
  }

  start(_mode: VoiceWakeMode): boolean {
    if (!this.recognition || this.active || this.denied) return false
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
      this.emitError(error instanceof Error ? error.message : 'Failed to start wake listening.')
      return false
    }
  }

  stop(): void {
    if (!this.recognition || !this.active) return
    this.stopping = true
    this.activeFlag = false
    try {
      this.recognition.abort()
    } catch {
      /* already stopped */
    }
  }

  private emitWake(payload: WakePayload): void {
    for (const handler of [...this.wakeHandlers]) handler(payload)
  }

  private emitError(message: string): void {
    for (const handler of [...this.errorHandlers]) handler(message)
  }

  private wire(rec: RecognitionLike): void {
    rec.onresult = (event) => {
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const alt = event.results[i]
        if (alt.isFinal) final += alt[0]?.transcript ?? ''
      }
      const cleaned = final.trim()
      if (!cleaned) return
      // Deterministic gate: non-wake transcripts are dropped here, they never
      // leave the wake provider.
      const parsed: WakeParse = splitWakeAndCommand(cleaned)
      if (!parsed.matched) return
      this.emitWake({ phrase: cleaned, command: parsed.command })
    }

    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.denied = true
        this.activeFlag = false
        this.emitError('Microphone permission required, or wake detection not allowed on this browser.')
      } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
        this.emitError(`Wake detection error: ${event.error}`)
      }
    }

    rec.onend = () => {
      const wasActive = this.activeFlag
      this.activeFlag = false
      // Restart only when we explicitly want to keep listening (browser
      // recognizers stop on their own). Never auto-retry after an error.
      // `stop()` clears activeFlag up front, so an explicit stop can never
      // resurrect the recognizer here.
      if (wasActive && !this.stopping && !this.denied) {
        try {
          this.activeFlag = true
          this.recognition?.start()
        } catch {
          this.activeFlag = false
        }
      }
      this.stopping = false
    }
  }
}