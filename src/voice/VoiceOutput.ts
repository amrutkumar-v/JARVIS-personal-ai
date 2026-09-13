/**
 * Voice-output backend abstraction. Phase 0: browser SpeechSynthesis.
 * UI must call `stop()` on route/search unmount — speechSynthesis may keep
 * talking otherwise.
 */
export interface VoiceOutput {
  speak(text: string, onDone?: () => void, volume?: number): void
  stop(): void
  /** Preferred voice id for the current locale, or null. */
  pickVoice(): string | null
  readonly speaking: boolean
  readonly supported: boolean
  /** Fired when the watchdog rescues a wedged speech engine (soft recovery). */
  onRescued?: () => void
}

export interface BrowserVoiceOutputOptions {
  /** Called when the watchdog rescues a wedged speech engine. */
  onRescued?: () => void
}

export class BrowserVoiceOutput implements VoiceOutput {
  private synth: SpeechSynthesis | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null

  readonly supported: boolean
  onRescued?: () => void

  /** @internal optional injected synth for tests; omit for the real browser. */
  constructor(synthOverride?: SpeechSynthesis | null, options?: BrowserVoiceOutputOptions) {
    if (synthOverride !== undefined) {
      this.synth = synthOverride
    } else if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.synth = window.speechSynthesis
    }
    this.supported = this.synth !== null
    this.onRescued = options?.onRescued
  }

  get speaking(): boolean {
    return this.synth?.speaking ?? false
  }

  speak(text: string, onDone?: () => void, volume = 1): void {
    this.clearWatchdog()
    if (!this.synth || !text) {
      onDone?.()
      return
    }
    this.synth.cancel()
    // Un-wedge: Chromium can leave speechSynthesis "paused" after a long idle
    // period or a cancelled utterance, silently dropping every later speak.
    // resume() before each utterance is the standard recovery and is a no-op
    // on healthy engines.
    if (typeof this.synth.resume === 'function') {
      try {
        this.synth.resume()
      } catch {
        /* resume can throw on wedged engines — treat as un-recoverable here */
      }
    }

    const utterance = new SpeechSynthesisUtterance(text)
    const preferred = this.pickVoice()
    if (preferred) {
      const match = this.synth.getVoices().find((v) => v.voiceURI === preferred)
      if (match) utterance.voice = match
    }
    utterance.rate = 1.04
    utterance.pitch = 0.92
    utterance.volume = Math.min(1, Math.max(0, volume))
    // Bounded safety net: on machines without a working audio/render path
    // speechSynthesis may never fire onend/onerror, which would leave the UI
    // stuck on "SPEAKING" forever. Fire the completion anyway after a generous
    // window and RESCUE the engine so future utterances still work. Never
    // cutting short a normal utterance (final responses speak in seconds).
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      this.clearWatchdog()
      onDone?.()
    }
    utterance.onend = done
    utterance.onerror = done
    this.watchdog = setTimeout(() => {
      this.rescue()
      done()
    }, BrowserVoiceOutput.WATCHDOG_MS)

    this.synth.speak(utterance)
  }

  /**
   * Soft-recover a wedged speech engine. Chrome's known bug: after a dropped
   * utterance the engine stays permanently "speaking" while actually silent,
   * and every later speak() is swallowed. cancel() + resume() rebinds the
   * pipeline; the onRescued hook lets diagnostics count the event.
   */
  private rescue(): void {
    const synth = this.synth
    if (!synth) return
    const stuck = synth.speaking === true
    try {
      if (typeof synth.cancel === 'function') synth.cancel()
      if (stuck && typeof synth.resume === 'function') synth.resume()
    } catch {
      /* a synthetic engine has no recovering surface — still settle the UI */
    }
    if (stuck) this.onRescued?.()
  }

  stop(): void {
    this.clearWatchdog()
    if (!this.synth) return
    this.synth.cancel()
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog)
      this.watchdog = null
    }
  }

  /** Generous upper bound before a stuck TTS stream is deemed done. */
  static readonly WATCHDOG_MS = 30_000

  pickVoice(): string | null {
    if (!this.synth) return null
    const voices = this.synth.getVoices()
    const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'))
    if (english.length === 0) return null
    // Prefer Google US English, then Microsoft David/Zira, else first EN.
    const preferred = ['Google US English', 'Microsoft David', 'Microsoft Zira', 'Daniel']
    for (const name of preferred) {
      const hit = english.find((v) => v.name === name)
      if (hit) return hit.voiceURI
    }
    return english[0].voiceURI
  }
}