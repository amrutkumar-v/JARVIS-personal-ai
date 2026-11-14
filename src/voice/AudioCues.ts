/**
 * Procedural Auditory Cues / Earcons (Phase 6)
 *
 * Synthesizes subtle, non-intrusive procedural feedback chimes for voice
 * and interaction events using oscillator nodes.
 *
 * Invariants:
 *  - Output only: zero microphone access, zero recording primitives.
 *  - Zero asset dependencies: no external .mp3/.wav files or network downloads.
 *  - Safe fallback: no-op in headless / non-audio environments without throwing.
 */

export type AudioCueType = 'wake' | 'recognize' | 'complete' | 'error' | 'interrupt'

export interface AudioCuesOptions {
  enabled?: boolean
  volume?: number
  context?: AudioContext | null
}

export class AudioCues {
  private ctx: AudioContext | null = null
  private enabled: boolean
  private volume: number

  constructor(options: AudioCuesOptions = {}) {
    this.enabled = options.enabled ?? true
    this.volume = Math.max(0, Math.min(1, options.volume ?? 0.2))

    if (options.context !== undefined) {
      this.ctx = options.context
    } else if (typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (AudioCtx) {
        try {
          this.ctx = new AudioCtx()
        } catch {
          this.ctx = null
        }
      }
    }
  }

  get isSupported(): boolean {
    return this.ctx !== null
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
  }

  /**
   * Resume audio context on user gesture (browser autoplay policy requirement).
   */
  async unlock(): Promise<void> {
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Play an acoustic cue by type.
   */
  play(type: AudioCueType): void {
    if (!this.enabled || !this.ctx) return

    switch (type) {
      case 'wake':
        this.playWakeChime()
        break
      case 'recognize':
        this.playRecognizeBeep()
        break
      case 'complete':
        this.playCompleteChime()
        break
      case 'error':
        this.playErrorTone()
        break
      case 'interrupt':
        this.playInterruptClick()
        break
    }
  }

  private playTone(freq: number, startTime: number, duration: number, peakVol: number): void {
    if (!this.ctx) return
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()

    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, startTime)

    gain.gain.setValueAtTime(0.001, startTime)
    gain.gain.linearRampToValueAtTime(peakVol * this.volume, startTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration)

    osc.connect(gain)
    gain.connect(this.ctx.destination)

    osc.start(startTime)
    osc.stop(startTime + duration)
  }

  /**
   * Ascending arpeggio (C5 -> E5 -> G5) indicating assistant is awake and listening.
   */
  playWakeChime(): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    this.playTone(523.25, now, 0.12, 0.3)
    this.playTone(659.25, now + 0.08, 0.12, 0.35)
    this.playTone(783.99, now + 0.16, 0.22, 0.4)
  }

  /**
   * Soft short blip (A5) confirming command capture.
   */
  playRecognizeBeep(): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    this.playTone(880.0, now, 0.06, 0.25)
  }

  /**
   * Pleasant harmonic chord (E5 + A5) confirming successful action completion.
   */
  playCompleteChime(): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    this.playTone(659.25, now, 0.25, 0.25)
    this.playTone(880.0, now + 0.04, 0.35, 0.3)
  }

  /**
   * Downward minor tone (E4 -> C4) indicating an error or refusal.
   */
  playErrorTone(): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    this.playTone(329.63, now, 0.15, 0.3)
    this.playTone(261.63, now + 0.12, 0.22, 0.35)
  }

  /**
   * Rapid damped click indicating speech was interrupted by barge-in.
   */
  playInterruptClick(): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    this.playTone(440.0, now, 0.03, 0.2)
  }
}

