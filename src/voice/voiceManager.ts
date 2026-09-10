/**
 * VoiceManager orchestration (Phase 1.6).
 *
 * Owns nothing the Agent Core owns. It manages wake state, command listening,
 * deterministic sleep/cancel handling, the bounded command timeout, and
 * connects three seams:
 *
 *   WakeWordProvider → VoiceManager → SpeechToTextProvider → submitCommand
 *   assistant response → VoiceManager → TextToSpeechProvider
 *
 * `submitCommand` and `cancelCurrent` are injected — production passes the
 * existing `AssistantEngine.process` / `cancelCurrentTask`; tests pass fakes.
 * Voice NEVER bypasses permissions: a spoken command enters the engine exactly
 * like a typed one, and plans/tools/permissions/verification stay untouched.
 */
import { VoiceStateMachine, type VoiceConfig, type VoiceState } from './types'
import { DEFAULT_VOICE_CONFIG } from './types'
import { classifyUtterance } from './normalization'
import type { WakeWordProvider } from './wakeWordProvider'
import type { SpeechToTextProvider } from './speechProvider'
import type { TextToSpeechProvider } from './ttsProvider'
import type { WakePayload } from './types'

export interface VoiceManagerCallbacks {
  /** Deliver a spoken command into the existing Agent Core (e.g. engine.process). */
  submitCommand(text: string): void
  /** Cancel the current Agent Core run with the EXISTING cancellation mechanism. */
  cancelCurrent(): void
  onStateChange?(state: VoiceState): void
  onNotice?(kind: 'info' | 'warning' | 'error', text: string): void
  /** Called when a command is being delivered (before submitCommand). */
  onCommand?(text: string): void
}

export interface VoiceManagerOptions {
  wake: WakeWordProvider | null
  stt: SpeechToTextProvider
  tts: TextToSpeechProvider
  callbacks: VoiceManagerCallbacks
  config?: Partial<VoiceConfig>
}

type TimerHandle = ReturnType<typeof setTimeout>

export class VoiceManager {
  readonly machine: VoiceStateMachine
  private readonly wake: WakeWordProvider | null
  private readonly stt: SpeechToTextProvider
  private readonly tts: TextToSpeechProvider
  private readonly callbacks: VoiceManagerCallbacks
  private readonly config: VoiceConfig

  private commandTimer: TimerHandle | null = null
  private sessionTimer: TimerHandle | null = null
  private sessionDeadline: number | null = null
  private pendingCommand: string | null = null
  private disposed = false
  private wakeUnsub: (() => void) | null = null
  private wakeErrorUnsub: (() => void) | null = null
  private sttUnsub: (() => void) | null = null
  private sttErrorUnsub: (() => void) | null = null

  constructor(options: VoiceManagerOptions) {
    this.wake = options.wake
    this.stt = options.stt
    this.tts = options.tts
    this.callbacks = options.callbacks
    this.config = { ...DEFAULT_VOICE_CONFIG, ...options.config, phrases: { ...DEFAULT_VOICE_CONFIG.phrases, ...options.config?.phrases } }
    this.machine = new VoiceStateMachine()
    if (this.wake) {
      this.wakeUnsub = this.wake.onWake((payload) => this.handleWake(payload))
      this.wakeErrorUnsub = this.wake.onError((message) => this.handleInputError(message))
    }
    this.sttUnsub = this.stt.onTranscript((text) => this.handleTranscript(text))
    this.sttErrorUnsub = this.stt.onError((message) => this.handleInputError(message))
  }

  get state(): VoiceState {
    return this.machine.state
  }

  /* ------------------------------------------------ session control */

  /**
   * Arm wake listening. MUST be called from a user gesture (browser autoplay
   * policy); respects mic permission and never retries in a loop.
   */
  arm(): boolean {
    if (this.disposed) return false
    if (!this.wake || !this.wake.supported) {
      this.notice('warning', 'Wake word is not available in this browser.')
      return false
    }
    const caps = this.wake.capabilities()
    if (!caps.available) {
      this.notice('warning', caps.reason ?? 'Wake word is unavailable.')
      return false
    }
    this.resetSessionCeiling()
    this.stt.abort()
    if (!this.transition('LISTENING_FOR_WAKE')) return false
    if (!this.wake.start('wake')) {
      this.notice('warning', 'Could not start wake listening.')
      this.transition('ERROR')
      this.transition('SLEEPING')
      return false
    }
    return true
  }

  /** Explicitly return to sleep (UI disarm, permission loss, or shutdown). */
  sleep(): void {
    if (this.disposed) return
    this.stopAllInput()
    this.resetSessionCeiling()
    this.pendingCommand = null
    this.transition('SLEEPING')
  }

  /** Cancel the active run / session. Maps into the existing engine cancellation. */
  cancel(speakPhrase = true): void {
    if (this.disposed) return
    if (this.machine.state === 'PROCESSING') {
      this.callbacks.cancelCurrent()
    }
    this.stopCommandListener()
    this.resetSessionCeiling()
    this.pendingCommand = null
    if (this.transition('CANCELLED')) {
      if (speakPhrase) this.speakPhrase(this.config.phrases.cancel, () => this.returnToWake())
      else this.returnToWake()
    }
  }

  handleWake(payload: WakePayload): void {
    if (this.disposed) return
    // Wake while already awake is ignored (duplicate wake events are dropped).
    if (this.machine.state !== 'LISTENING_FOR_WAKE') return
    this.wake?.stop()
    this.transition('AWAKE')
    // Phase 1.6 — the whole awake session is bounded by one session ceiling
    // armed at wake; activity never resets it, so an always-on mic always
    // closes after `sessionTimeoutMs` no matter how chatty the user is.
    this.armSessionCeiling()
    if (payload.command && payload.command.trim().length > 0) {
      // Direct form: "Wake up, JARVIS, open Chrome." — skip the ack.
      this.beginCommand(payload.command)
      return
    }
    this.speakPhrase(this.config.phrases.wake, () => this.enterCommandListening())
  }

  handleTranscript(text: string): void {
    if (this.disposed) return
    const kind = classifyUtterance(text)
    if (kind === 'none') return

    const state = this.machine.state
    if (kind === 'cancel') {
      if (state === 'PROCESSING' || state === 'SPEAKING') {
        this.cancel()
      } else if (state === 'LISTENING_FOR_COMMAND' || state === 'AWAKE') {
        this.stopCommandListener()
        this.pendingCommand = null
        if (this.transition('CANCELLED')) {
          this.speakPhrase(this.config.phrases.cancel, () => this.returnToWake())
        }
      }
      return
    }

    if (kind === 'sleep') {
      if (state === 'PROCESSING') this.callbacks.cancelCurrent()
      this.stopCommandListener()
      this.pendingCommand = null
      if (this.transition('SLEEPING')) {
        this.speakPhrase(this.config.phrases.sleep, () => undefined)
      }
      return
    }

    // A real command.
    if (state === 'PROCESSING') {
      // The Agent Core is already running; keep a single queued command slot.
      this.pendingCommand = text
      return
    }
    if (state === 'SPEAKING') {
      // Interrupting speech: stop TTS and take the new command.
      this.tts.stop()
      this.stopCommandListener()
      this.beginCommand(text)
      return
    }
    if (state === 'LISTENING_FOR_COMMAND' || state === 'AWAKE' || state === 'LISTENING_FOR_WAKE') {
      this.stopCommandListener()
      this.beginCommand(text)
    }
  }

  /** Engine status feed — completes the PROCESSING → SPEAKING → LISTENING cycle. */
  engineStatus(status: string): void {
    if (this.disposed) return
    if (this.machine.state === 'PROCESSING' || this.machine.state === 'SPEAKING') {
      if (status === 'speaking') {
        this.transition('SPEAKING')
      } else if (status === 'idle' || status === 'success' || status === 'cancelled') {
        this.afterRun()
      } else if (status === 'error' || status === 'warning' || status === 'failed') {
        this.resetSessionCeiling()
        this.speakPhrase(this.config.phrases.failure, () => this.returnToWake())
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopAllInput()
    this.resetSessionCeiling()
    this.wakeUnsub?.()
    this.wakeErrorUnsub?.()
    this.sttUnsub?.()
    this.sttErrorUnsub?.()
    this.tts.stop()
    this.transition('SLEEPING')
  }

  /* ------------------------------------------------ internals */

  private transition(next: VoiceState): boolean {
    if (!this.machine.transition(next)) return false
    this.callbacks.onStateChange?.(next)
    return true
  }

  private notice(kind: 'info' | 'warning' | 'error', text: string): void {
    this.callbacks.onNotice?.(kind, text)
  }

  private speakPhrase(text: string, onDone: () => void): void {
    if (!this.tts.supported) {
      onDone()
      return
    }
    this.tts.speak(text, { volume: 1, onDone: () => onDone() })
  }

  private beginCommand(text: string): void {
    this.clearCommandTimer()
    this.callbacks.onCommand?.(text)
    this.transition('PROCESSING')
    this.callbacks.submitCommand(text)
  }

  private enterCommandListening(): void {
    if (this.disposed) return
    this.transition('LISTENING_FOR_COMMAND')
    this.startCommandListening()
  }

  private afterRun(): void {
    if (this.disposed) return
    if (this.pendingCommand) {
      const next = this.pendingCommand
      this.pendingCommand = null
      this.beginCommand(next)
      return
    }
    if (this.transition('LISTENING_FOR_COMMAND')) {
      this.startCommandListening()
    }
  }

  private startCommandListening(): void {
    this.stt.start()
    this.commandTimer = setTimeout(() => this.handleTimeout(), this.config.commandTimeoutMs)
  }

  private stopCommandListener(): void {
    this.stt.abort()
    this.clearCommandTimer()
  }

  private handleTimeout(): void {
    this.stopCommandListener()
    this.resetSessionCeiling()
    this.pendingCommand = null
    if (this.transition('SLEEPING')) {
      // "I didn't hear a command." — then back to wake listening per config.
      if (this.config.sleepOnTimeout) {
        this.speakPhrase(this.config.phrases.noCommand, () => this.returnToWake())
      }
    }
  }

  private handleSessionExpiry(): void {
    this.stopAllInput()
    this.resetSessionCeiling()
    this.pendingCommand = null
    // Silent ceiling: the bounded multi-turn session simply closes the mic.
    this.transition('SLEEPING')
  }

  private handleInputError(message: string): void {
    if (this.disposed) return
    // Permission denied / unavailable: surface once, stop, do NOT auto-retry.
    this.stopAllInput()
    this.resetSessionCeiling()
    this.pendingCommand = null
    this.notice('warning', message)
    if (this.transition('ERROR')) {
      this.returnToWake()
    }
  }

  private returnToWake(): void {
    this.transition('SLEEPING')
  }

  private stopAllInput(): void {
    this.wake?.stop()
    this.stt.abort()
    this.clearCommandTimer()
  }

  private clearCommandTimer(): void {
    if (this.commandTimer) clearTimeout(this.commandTimer)
    this.commandTimer = null
  }

  /** Arm the one-per-session ceiling at wake (never re-armed by activity). */
  private armSessionCeiling(): void {
    if (this.sessionDeadline !== null) return
    this.sessionDeadline = Date.now() + this.config.sessionTimeoutMs
    this.sessionTimer = setTimeout(() => this.handleSessionExpiry(), this.config.sessionTimeoutMs)
  }

  private resetSessionCeiling(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer)
    this.sessionTimer = null
    this.sessionDeadline = null
  }
}