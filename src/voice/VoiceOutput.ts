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
}

export class BrowserVoiceOutput implements VoiceOutput {
  private synth: SpeechSynthesis | null = null

  readonly supported: boolean

  constructor() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.synth = window.speechSynthesis
    }
    this.supported = this.synth !== null
  }

  get speaking(): boolean {
    return this.synth?.speaking ?? false
  }

  speak(text: string, onDone?: () => void, volume = 1): void {
    if (!this.synth || !text) {
      onDone?.()
      return
    }
    this.synth.cancel()

    const utterance = new SpeechSynthesisUtterance(text)
    const preferred = this.pickVoice()
    if (preferred) {
      const match = this.synth.getVoices().find((v) => v.voiceURI === preferred)
      if (match) utterance.voice = match
    }
    utterance.rate = 1.04
    utterance.pitch = 0.92
    utterance.volume = Math.min(1, Math.max(0, volume))
    utterance.onend = () => onDone?.()
    utterance.onerror = () => onDone?.()

    this.synth.speak(utterance)
  }

  stop(): void {
    if (!this.synth) return
    this.synth.cancel()
  }

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