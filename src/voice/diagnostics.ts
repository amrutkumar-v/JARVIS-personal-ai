/**
 * Voice self-test / diagnostics (Phase 13 — integrated from the reference
 * voice assistant's `window.__voice` counters and audio self-test).
 *
 * This module ONLY counts structured events and provokes a benign TTS probe —
 * it never captures or persists raw audio. It is a pure, dependency-free
 * tracker so the boundary scan in `security.test.ts` can keep asserting that
 * the voice layer stays an input interface (no raw-audio capture primitives).
 */

export type VoiceCounterName =
  | 'sessionsStarted'
  | 'wakeAccepted'
  | 'wakeRejected'
  | 'wakeDenied'
  | 'commandsSubmitted'
  | 'commandsCanceled'
  | 'commandsQueued'
  | 'transcriptsDropped'
  | 'speechStarted'
  | 'speechFinished'
  | 'speechInterrupted'
  | 'speechRescued'
  | 'inputErrors'
  | 'engineFailures'

export const ALL_VOICE_COUNTERS: readonly VoiceCounterName[] = [
  'sessionsStarted',
  'wakeAccepted',
  'wakeRejected',
  'wakeDenied',
  'commandsSubmitted',
  'commandsCanceled',
  'commandsQueued',
  'transcriptsDropped',
  'speechStarted',
  'speechFinished',
  'speechInterrupted',
  'speechRescued',
  'inputErrors',
  'engineFailures',
]

export interface VoiceDiagnosticsSnapshot {
  counters: Record<VoiceCounterName, number>
  startedAt: number
  state: string
  lastError: string | null
}

function emptyCounters(): Record<VoiceCounterName, number> {
  return Object.fromEntries(ALL_VOICE_COUNTERS.map((name) => [name, 0])) as Record<VoiceCounterName, number>
}

/** Bounded, forward-only counters for the voice session (reset on demand). */
export class VoiceDiagnostics {
  private counters: Record<VoiceCounterName, number> = emptyCounters()
  readonly startedAt: number = Date.now()
  private state: string = 'SLEEPING'
  private error: string | null = null

  increment(name: VoiceCounterName): void {
    this.counters[name] += 1
  }

  setState(state: string): void {
    this.state = state
  }

  setError(message: string | null): void {
    this.error = message
  }

  reset(): void {
    this.counters = emptyCounters()
    this.error = null
    this.state = 'SLEEPING'
  }

  snapshot(): VoiceDiagnosticsSnapshot {
    return {
      counters: { ...this.counters },
      startedAt: this.startedAt,
      state: this.state,
      lastError: this.error,
    }
  }
}

/** Structural provider seams (keeps this module dependency-free). */
export interface TtsLike {
  readonly supported: boolean
  capabilities(): { available: boolean; reason?: string }
}

export interface WakeLike {
  readonly supported: boolean
  capabilities(): { available: boolean; reason?: string }
}

export interface SttLike {
  capabilities?: () => { available: boolean; reason?: string }
}

export interface VoiceHealthReport {
  tts: { supported: boolean; available: boolean; reason?: string }
  wake: { supported: boolean; available: boolean; reason?: string }
  stt: { available: boolean; reason?: string }
  diagnostics: VoiceDiagnosticsSnapshot
}

/**
 * Honest voice-readiness probe used by the diagnostics/self-test capability.
 * Never claims availability it cannot back with a real capability report.
 */
export function assessVoiceHealth(options: {
  tts?: TtsLike | null
  wake?: WakeLike | null
  stt?: SttLike | null
  diagnostics?: VoiceDiagnostics | null
}): VoiceHealthReport {
  const { tts, wake, stt, diagnostics } = options

  const ttsReport = { supported: false, available: false, reason: undefined as string | undefined }
  if (tts) {
    ttsReport.supported = tts.supported
    const caps = tts.capabilities()
    ttsReport.available = tts.supported && caps.available
    ttsReport.reason = caps.reason
  }

  const wakeReport = { supported: false, available: false, reason: undefined as string | undefined }
  if (wake) {
    wakeReport.supported = wake.supported
    const caps = wake.capabilities()
    wakeReport.available = wake.supported && caps.available
    wakeReport.reason = caps.reason
  }

  const sttReport: { available: boolean; reason?: string } = { available: false }
  if (stt) {
    const caps = stt.capabilities?.()
    sttReport.available = caps?.available ?? false
    sttReport.reason = caps?.reason
  }

  return {
    tts: ttsReport,
    wake: wakeReport,
    stt: sttReport,
    diagnostics: diagnostics?.snapshot() ?? { counters: emptyCounters(), startedAt: Date.now(), state: 'SLEEPING', lastError: null },
  }
}