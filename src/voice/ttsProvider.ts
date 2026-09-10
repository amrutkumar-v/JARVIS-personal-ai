/**
 * Text-to-speech provider abstraction (Phase 1.6).
 *
 * The Agent Core produces TEXT; this provider simply speaks the safe response
 * that would be displayed in the UI. No internal traces, tool arguments,
 * tokens, paths or redacted text ever reach TTS.
 */
import { BrowserVoiceOutput, type VoiceOutput } from './VoiceOutput'

export interface TextToSpeechCapabilities {
  available: boolean
  reason?: string
}

export interface TextToSpeechProvider {
  readonly id: string
  /** Speak text; `onDone(ok)` fires when playback ends or is interrupted. */
  speak(text: string, opts?: { volume?: number; onDone?: (ok: boolean) => void }): void
  stop(): void
  pickVoice(): string | null
  readonly speaking: boolean
  readonly supported: boolean
  capabilities(): TextToSpeechCapabilities
}

export class BrowserTextToSpeechProvider implements TextToSpeechProvider {
  readonly id = 'browser-text-to-speech'
  private output: VoiceOutput
  private doneHandler: ((ok: boolean) => void) | null = null

  readonly supported: boolean

  constructor(output: VoiceOutput = new BrowserVoiceOutput()) {
    this.output = output
    this.supported = output.supported
  }

  get speaking(): boolean {
    return this.output.speaking
  }

  speak(text: string, opts?: { volume?: number; onDone?: (ok: boolean) => void }): void {
    if (!this.supported || !text) {
      opts?.onDone?.(false)
      return
    }
    this.doneHandler?.(false)
    this.doneHandler = opts?.onDone ?? null
    // One actor with one voice: speaking cancels any in-flight utterance, so
    // TTS streams can never overlap.
    this.output.speak(text, () => {
      const handler = this.doneHandler
      this.doneHandler = null
      handler?.(true)
    }, opts?.volume ?? 1)
  }

  stop(): void {
    this.output.stop()
    const handler = this.doneHandler
    this.doneHandler = null
    handler?.(false)
  }

  pickVoice(): string | null {
    return this.output.pickVoice()
  }

  capabilities(): TextToSpeechCapabilities {
    if (!this.supported) {
      return { available: false, reason: 'Speech synthesis is not supported in this browser.' }
    }
    return { available: true }
  }
}