import type { JarvisStatus } from '../engine/types'
import type { GoalRunSnapshot } from '../state/goalRun'
import type { ReconnectPhase } from '../backend/reconnect'
import type { EnvironmentDrive, VisualState } from './types'

/**
 * Phase 8 — normalized visual state layer.
 *
 * This is the only place that maps REAL engine signals (status + goal verdict
 * + backend reconnect phase) onto the normalized `VisualState` vocabulary the
 * environments render. Nothing here invents state: it only translates what the
 * engine actually reports.
 *
 *  JARVIS ENGINE → NORMALIZED VISUAL STATE → VISUAL ENVIRONMENT → MOTION
 */

export interface EngineSignal {
  status: JarvisStatus
  isSpeaking: boolean
  goalRun: Pick<GoalRunSnapshot, 'task'> | null
  backendPhase: ReconnectPhase
}

const STATE_OF: Record<JarvisStatus, VisualState> = {
  idle: 'idle',
  listening: 'listening',
  thinking: 'thinking',
  understanding: 'thinking',
  planning: 'planning',
  executing: 'executing',
  observing: 'observing',
  verifying: 'verifying',
  // Real speech rides over the underlying state; the drive flags `speaking`.
  speaking: 'idle',
  waiting_for_confirmation: 'waiting',
  recovering: 'recovering',
  retrying: 'recovering',
  success: 'completed',
  warning: 'recovering',
  error: 'failed',
  failed: 'failed',
  cancelling: 'cancelled',
  cancelled: 'cancelled',
}

const TERMINAL_VERDICT_OF: Record<string, VisualState> = {
  completed: 'completed',
  failed: 'failed',
  unverified: 'failed',
  blocked: 'failed',
  cancelled: 'cancelled',
}

export function normalizeVisualState(signal: EngineSignal): VisualState {
  // A finished goal verdict (only ever a real engine verdict) takes precedence
  // over the transient status once the run has actually closed.
  const verdict = signal.goalRun?.task?.status
  if (verdict) {
    const terminal = TERMINAL_VERDICT_OF[verdict]
    if (terminal) return terminal
  }

  const base = STATE_OF[signal.status]

  // Real backend reconnect cycles: when the engine sits idle but the
  // persistent core is actively reconnecting, reflect that recovery honestly.
  if (base === 'idle' && isReconnecting(signal.backendPhase)) {
    return 'recovering'
  }

  return base
}

function isReconnecting(phase: ReconnectPhase): boolean {
  return phase === 'connecting' || phase === 'waiting' || phase === 'giving_up'
}

interface DriveProfile {
  energy: number
  speed: number
  pulse: number
}

const PROFILE: Record<VisualState, DriveProfile> = {
  idle: { energy: 0.22, speed: 0.35, pulse: 1.4 },
  listening: { energy: 0.55, speed: 0.7, pulse: 1.7 },
  thinking: { energy: 0.75, speed: 0.9, pulse: 2.0 },
  planning: { energy: 0.75, speed: 0.9, pulse: 2.0 },
  executing: { energy: 1.05, speed: 1.2, pulse: 2.5 },
  observing: { energy: 0.9, speed: 1.0, pulse: 2.2 },
  verifying: { energy: 0.95, speed: 0.85, pulse: 2.7 },
  recovering: { energy: 1.05, speed: 0.9, pulse: 2.5 },
  waiting: { energy: 0.7, speed: 0.5, pulse: 1.9 },
  completed: { energy: 1.0, speed: 0.95, pulse: 3.0 },
  failed: { energy: 1.25, speed: 0.9, pulse: 2.7 },
  cancelled: { energy: 0.5, speed: 0.4, pulse: 1.6 },
}

/** Reduced-motion scaling (matches the 3D scene's approach). */
const MOTION_SCALE = 0.16
const PULSE_SCALE = 0.4

/**
 * Bounded, deterministic speaking amplitude — used ONLY while the engine
 * reports real speech; returns 0 otherwise.
 */
export function speechEnergy(t: number): number {
  const drive = Math.sin(t * 5.2)
  return (drive + 1) / 2
}

export function computeDrive(
  status: JarvisStatus,
  isSpeaking: boolean,
  goalRun: Pick<GoalRunSnapshot, 'task'> | null,
  backendPhase: ReconnectPhase,
  reducedMotion: boolean,
  t: number,
): EnvironmentDrive {
  const state = normalizeVisualState({ status, isSpeaking, goalRun, backendPhase })
  const p = PROFILE[state]
  const speaking = isSpeaking || status === 'speaking'
  return {
    state,
    status,
    speaking,
    energy: p.energy,
    speed: p.speed * (reducedMotion ? MOTION_SCALE : 1),
    pulse: p.pulse * (reducedMotion ? PULSE_SCALE : 1),
    speech: speaking ? speechEnergy(t) : 0,
  }
}