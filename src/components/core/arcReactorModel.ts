import type { JarvisStatus } from '../../engine/types'

/**
 * Phase 2.5 — pure Arc-Reactor presentation model.
 *
 * Maps the REAL engine status to a bounded visual variant + a short
 * human-readable label. Nothing here invents state: it only reacts to what the
 * engine actually reports. `isSpeaking` is only ever surfaced when the engine
 * is genuinely emitting speech (no fake speaking animation).
 */

export interface ArcReactorPresentation {
  /** CSS variant key (drives the arc-reactor animation set). */
  variant: string
  /** Short human-readable caption shown with the reactor. */
  label: string
  /** True while the reactor should do the speech pulse (real speech only). */
  speaking: boolean
}

const VARIANT_OF: Record<JarvisStatus, string> = {
  idle: 'idle',
  listening: 'listening',
  thinking: 'planning',
  understanding: 'understanding',
  planning: 'planning',
  executing: 'executing',
  observing: 'observing',
  verifying: 'verifying',
  speaking: 'speaking',
  waiting_for_confirmation: 'attention',
  success: 'success',
  warning: 'warning',
  error: 'error',
  failed: 'error',
  cancelling: 'cancelled',
  cancelled: 'cancelled',
}

const LABEL_OF: Record<JarvisStatus, string> = {
  idle: 'STANDING BY',
  listening: 'LISTENING',
  thinking: 'PLANNING',
  understanding: 'UNDERSTANDING',
  planning: 'PLANNING',
  executing: 'EXECUTING',
  observing: 'OBSERVING',
  verifying: 'VERIFYING',
  speaking: 'SPEAKING',
  waiting_for_confirmation: 'CONFIRMATION REQUIRED',
  success: 'DONE',
  warning: 'ATTENTION',
  error: 'ERROR',
  failed: 'ERROR',
  cancelling: 'CANCELLING',
  cancelled: 'CANCELLED',
}

export function arcReactorPresentation(
  status: JarvisStatus,
  isSpeaking: boolean,
): ArcReactorPresentation {
  return {
    variant: VARIANT_OF[status],
    label: LABEL_OF[status],
    speaking: isSpeaking || status === 'speaking',
  }
}

/** Bounded speech pulse bound used by the CSS animation (0..1). */
export const ARC_REACTOR_SPEECH_BOUNDS = { min: 0.82, max: 1.18 } as const