/**
 * Voice interaction state model (Phase 1.6).
 *
 * VOICE IS AN INPUT INTERFACE. This machine only describes WHO is listening
 * and WHAT the session is doing — it never plans, executes, permission-checks
 * or verifies. Those responsibilities stay in the existing Agent Core.
 *
 * The flow mirrors the suggested session states:
 *
 *   SLEEPING
 *     → LISTENING_FOR_WAKE      (wake provider listening; only wake phrases)
 *     → AWAKE                   (wake phrase accepted)
 *     → LISTENING_FOR_COMMAND   (command listener armed, bounded timeout)
 *     → PROCESSING              (command submitted to the Agent Core)
 *     → SPEAKING                (assistant response being spoken)
 *     → LISTENING_FOR_COMMAND   (multi-turn session continues)
 *
 * CANCELLED / ERROR are recoverable: they return to SLEEPING or wake listening.
 */

export type VoiceState =
  | 'SLEEPING'
  | 'LISTENING_FOR_WAKE'
  | 'AWAKE'
  | 'LISTENING_FOR_COMMAND'
  | 'PROCESSING'
  | 'SPEAKING'
  | 'CANCELLED'
  | 'ERROR'

/** What the wake provider is being asked to listen for. */
export type VoiceWakeMode = 'wake' | 'command'

export interface WakePayload {
  /** The recognized wake phrase (normalized). */
  phrase: string
  /** Optional trailing command captured after the wake phrase. */
  command?: string
}

export interface VoicePhrases {
  /** Spoken when waking up with no trailing command. */
  wake: string
  /** Spoken when the command timeout expires with no command. */
  noCommand: string
  /** Spoken on an explicit sleep command. */
  sleep: string
  /** Spoken when a command is cancelled. */
  cancel: string
  /** Spoken when the agent run fails. */
  failure: string
}

export interface VoiceConfig {
  /** Bounded command-listening window (ms). */
  commandTimeoutMs: number
  /** Bounded multi-turn session window (ms) once awake. */
  sessionTimeoutMs: number
  /** Wake listening continues when the voice session is sleeping. */
  sleepOnTimeout: boolean
  phrases: VoicePhrases
}

export const DEFAULT_VOICE_PHRASES: VoicePhrases = {
  wake: "I'm here, {name}. How can I help?",
  noCommand: "I didn't hear a command.",
  sleep: 'Going to sleep.',
  cancel: 'Cancelled.',
  failure: "I couldn't complete that.",
}

/**
 * Resolve the `{name}` placeholder in a spoken phrase.
 *
 * With a known operator name the greeting is personal ("I'm here, Amrut. How
 * can I help?"). Without one — or with the untouched default profile name —
 * the placeholder is dropped cleanly ("I'm here. How can I help?") so JARVIS
 * never greets an anonymous "Operator".
 */
export function resolveVoicePhrase(phrase: string, name?: string): string {
  const clean = (name ?? '').trim()
  const isPlaceholderName = !clean || clean.toLowerCase() === 'operator'
  const resolved = isPlaceholderName
    ? phrase.replace(/,\s*\{name\}/g, '').replace(/\{name\}/g, '')
    : phrase.replace(/\{name\}/g, clean)
  return resolved.replace(/\s{2,}/g, ' ').trim()
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  commandTimeoutMs: 8_000,
  sessionTimeoutMs: 30_000,
  sleepOnTimeout: true,
  phrases: DEFAULT_VOICE_PHRASES,
}

const RECOVERABLE: ReadonlySet<VoiceState> = new Set<VoiceState>(['CANCELLED', 'ERROR'])

/** CANCELLED/ERROR are recoverable session states (not permanent terminations). */
export function voiceStateRecoverable(state: VoiceState): boolean {
  return RECOVERABLE.has(state) || state === 'SLEEPING'
}

/**
 * Pure transition rule, mirroring the Agent Core `canTransition` convention.
 * SLEEPING is the root state; CANCELLED/ERROR may return to it or to wake
 * listening. Self-transitions are legal.
 */
export function canVoiceTransition(from: VoiceState, to: VoiceState): VoiceState | undefined {
  if (from === to) return to
  switch (from) {
    case 'SLEEPING':
      return to === 'LISTENING_FOR_WAKE' ? to : undefined
    case 'LISTENING_FOR_WAKE':
      return to === 'AWAKE' || to === 'SLEEPING' || to === 'CANCELLED' || to === 'ERROR' ? to : undefined
    case 'AWAKE':
      return to === 'LISTENING_FOR_COMMAND' || to === 'PROCESSING' || to === 'SLEEPING' || to === 'CANCELLED' || to === 'ERROR' ? to : undefined
    case 'LISTENING_FOR_COMMAND':
      return to === 'PROCESSING' || to === 'SPEAKING' || to === 'SLEEPING' || to === 'CANCELLED' || to === 'ERROR' ? to : undefined
    case 'PROCESSING':
      return to === 'SPEAKING' || to === 'LISTENING_FOR_COMMAND' || to === 'SLEEPING' || to === 'CANCELLED' || to === 'ERROR' ? to : undefined
    case 'SPEAKING':
      // A new command may interrupt speech (barge-in) and start running.
      return to === 'LISTENING_FOR_COMMAND' || to === 'PROCESSING' || to === 'SLEEPING' || to === 'CANCELLED' || to === 'ERROR' ? to : undefined
    case 'CANCELLED':
      return to === 'SLEEPING' || to === 'LISTENING_FOR_WAKE' || to === 'ERROR' ? to : undefined
    case 'ERROR':
      return to === 'SLEEPING' || to === 'LISTENING_FOR_WAKE' ? to : undefined
    default:
      return undefined
  }
}

/** Tiny mutable wrapper the VoiceManager drives; rules live in `canVoiceTransition`. */
export class VoiceStateMachine {
  private current: VoiceState = 'SLEEPING'

  get state(): VoiceState {
    return this.current
  }

  transition(next: VoiceState): boolean {
    const allowed = canVoiceTransition(this.current, next)
    if (!allowed) return false
    this.current = next
    return true
  }

  force(state: VoiceState): void {
    this.current = state
  }

  reset(): void {
    this.current = 'SLEEPING'
  }
}