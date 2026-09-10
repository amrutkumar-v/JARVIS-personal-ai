/**
 * Deterministic test providers for the voice module (Phase 1.6).
 *
 * `testsOnly: true` on every class. Production wiring never imports this file
 * — `src/voice/index.ts` deliberately does not re-export it, and a security
 * test asserts a production import would fail.
 */
import type { VoiceWakeMode, WakePayload } from './types'
import type {
  WakeWordProvider,
  WakeWordCapabilities,
} from './wakeWordProvider'
import type {
  SpeechToTextProvider,
  SpeechToTextCapabilities,
} from './speechProvider'
import type {
  TextToSpeechProvider,
  TextToSpeechCapabilities,
} from './ttsProvider'

export interface FakeWakeOptions {
  supported?: boolean
  available?: boolean
  reason?: string
}

export class FakeWakeWordProvider implements WakeWordProvider {
  readonly id = 'fake-wake-word'
  readonly testsOnly = true
  supported: boolean
  private available: boolean
  private reason: string | undefined
  private activeFlag = false
  private wakeHandlers: ((payload: WakePayload) => void)[] = []
  private errorHandlers: ((message: string) => void)[] = []

  startModes: VoiceWakeMode[] = []
  stopCalls = 0

  constructor(options: FakeWakeOptions = {}) {
    this.supported = options.supported ?? true
    this.available = options.available ?? true
    this.reason = options.reason
  }

  get active(): boolean {
    return this.activeFlag
  }

  start(mode: VoiceWakeMode): boolean {
    if (!this.supported || !this.available || this.activeFlag) return false
    this.startModes.push(mode)
    this.activeFlag = true
    return true
  }

  stop(): void {
    this.activeFlag = false
    this.stopCalls += 1
  }

  emitWake(payload: WakePayload): void {
    for (const handler of [...this.wakeHandlers]) handler(payload)
  }

  emitError(message: string): void {
    for (const handler of [...this.errorHandlers]) handler(message)
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
    if (!this.supported) return { available: false, reason: 'Unsupported in tests.' }
    return { available: this.available, reason: this.reason }
  }
}

export class FakeSpeechToTextProvider implements SpeechToTextProvider {
  readonly id = 'fake-speech-to-text'
  readonly testsOnly = true
  supported: boolean
  private available: boolean
  private reason: string | undefined
  private activeFlag = false
  private transcriptHandlers: ((text: string) => void)[] = []
  private startHandlers: (() => void)[] = []
  private endHandlers: ((reason: 'done' | 'aborted' | 'error') => void)[] = []
  private errorHandlers: ((message: string) => void)[] = []

  startCalls = 0
  stopCalls = 0
  abortCalls = 0

  constructor(options: FakeWakeOptions = {}) {
    this.supported = options.supported ?? true
    this.available = options.available ?? true
    this.reason = options.reason
  }

  get listening(): boolean {
    return this.activeFlag
  }

  start(): boolean {
    if (!this.supported || !this.available || this.activeFlag) return false
    this.startCalls += 1
    this.activeFlag = true
    return true
  }

  stop(): void {
    this.activeFlag = false
    this.stopCalls += 1
  }

  abort(): void {
    this.activeFlag = false
    this.abortCalls += 1
  }

  emitTranscript(text: string): void {
    for (const handler of [...this.transcriptHandlers]) handler(text)
  }

  emitStart(): void {
    for (const handler of [...this.startHandlers]) handler()
  }

  emitEnd(reason: 'done' | 'aborted' | 'error'): void {
    for (const handler of [...this.endHandlers]) handler(reason)
  }

  emitError(message: string): void {
    for (const handler of [...this.errorHandlers]) handler(message)
  }

  onTranscript(handler: (text: string) => void): () => void {
    this.transcriptHandlers.push(handler)
    return () => {
      this.transcriptHandlers = this.transcriptHandlers.filter((h) => h !== handler)
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
    if (!this.supported) return { available: false, reason: 'Unsupported in tests.' }
    return { available: this.available, reason: this.reason }
  }
}

interface SpokenEntry {
  text: string
  volume?: number
}

export class FakeTextToSpeechProvider implements TextToSpeechProvider {
  readonly id = 'fake-text-to-speech'
  readonly testsOnly = true
  supported: boolean
  private available: boolean
  private reason: string | undefined
  private activeFlag = false
  private doneHandler: ((ok: boolean) => void) | null = null
  private utterances: SpokenEntry[] = []

  constructor(options: FakeWakeOptions = {}) {
    this.supported = options.supported ?? true
    this.available = options.available ?? true
    this.reason = options.reason
  }

  get speaking(): boolean {
    return this.activeFlag
  }

  get spoken(): SpokenEntry[] {
    return [...this.utterances]
  }

  get lastText(): string | null {
    return this.utterances.length > 0 ? this.utterances[this.utterances.length - 1]!.text : null
  }

  speak(text: string, opts?: { volume?: number; onDone?: (ok: boolean) => void }): void {
    if (!this.supported || !this.available) {
      opts?.onDone?.(false)
      return
    }
    // One actor with one voice: a new utterance interrupts any in-flight one.
    this.activeFlag = true
    this.doneHandler?.(false)
    this.utterances.push({ text, volume: opts?.volume })
    this.doneHandler = opts?.onDone ?? null
  }

  /** Simulate the utterance finishing naturally. */
  finishLast(): void {
    const handler = this.doneHandler
    this.doneHandler = null
    this.activeFlag = false
    handler?.(true)
  }

  stop(): void {
    const handler = this.doneHandler
    this.doneHandler = null
    this.activeFlag = false
    handler?.(false)
  }

  pickVoice(): string | null {
    return null
  }

  capabilities(): TextToSpeechCapabilities {
    if (!this.supported) return { available: false, reason: 'Unsupported in tests.' }
    return { available: this.available, reason: this.reason }
  }
}