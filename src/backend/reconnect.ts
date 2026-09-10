/**
 * Pure reconnect state machine for the backend SSE stream (Phase 2.8).
 *
 * Kept dependency-free and fully deterministic so it can be unit-tested: the
 * client drives it; the state machine only decides WHEN to reconnect and how
 * long to wait (bounded exponential backoff). Reaching the attempt limit
 * yields `giving_up` — the UI then reports the backend honestly as
 * disconnected instead of looping forever.
 */

export type ReconnectPhase = 'idle' | 'connecting' | 'connected' | 'waiting' | 'giving_up'

export interface ReconnectConfig {
  /** Attempts after a lost connection before giving up (initial connect included). */
  maxAttempts: number
  /** Base delay for the first retry in ms (doubles per attempt, capped). */
  baseMs: number
  /** Hard ceiling for any single retry delay. */
  maxDelayMs?: number
}

export interface ReconnectStateMachine {
  readonly phase: ReconnectPhase
  readonly attempts: number
  reset(): void
  markConnected(): void
  /** Start of a reconnect cycle; returns delay in ms or -1 to give up. */
  nextDelay(): number
}

export class ReconnectController implements ReconnectStateMachine {
  private readonly config: ReconnectConfig
  private readonly onPhase: (phase: ReconnectPhase, attempts: number) => void
  private currentPhase: ReconnectPhase = 'idle'
  private currentAttempts = 0

  constructor(config: ReconnectConfig, onPhase: (phase: ReconnectPhase, attempts: number) => void = () => undefined) {
    this.config = config
    this.onPhase = onPhase
  }

  get phase(): ReconnectPhase {
    return this.currentPhase
  }

  get attempts(): number {
    return this.currentAttempts
  }

  reset(): void {
    this.currentAttempts = 0
    this.setPhase('idle', 0)
  }

  markConnected(): void {
    this.currentAttempts = 0
    this.setPhase('connected', 0)
  }

  nextDelay(): number {
    this.currentAttempts += 1
    if (this.currentAttempts > this.config.maxAttempts) {
      this.setPhase('giving_up', this.currentAttempts)
      return -1
    }
    const maxDelayMs = this.config.maxDelayMs ?? 15_000
    const delay = Math.min(this.config.baseMs * 2 ** (this.currentAttempts - 1), maxDelayMs)
    this.setPhase('waiting', this.currentAttempts)
    return delay
  }

  private setPhase(phase: ReconnectPhase, attempts: number): void {
    this.currentPhase = phase
    this.currentAttempts = attempts
    this.onPhase(phase, attempts)
  }
}