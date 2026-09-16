/**
 * Voice status presentation — pure mapping from REAL voice state to the
 * compact HUD chip. Kept side-effect free so it is unit-testable without a
 * DOM. Labels use the exact `voiceState` enum values that already exist
 * (`SLEEPING`, `LISTENING_FOR_WAKE`, `AWAKE`, …) plus honest derived markers:
 * ARMED when the wake session is live, LISTENING only while the recognizer is
 * actually hot, OFFLINE when no voice capability exists at all.
 */

import type { VoiceState } from '../../voice/types'

export type VoiceDisplayMode =
  | 'offline'
  | 'listening'
  | 'armed'
  | 'standby'
  | 'recovering'

export interface VoiceStatusPresentation {
  mode: VoiceDisplayMode
  /** Short display label (uppercase, mono chip). */
  label: string
  /** One-word a11y label. */
  accessibleLabel: string
}

export function voiceStatusPresentation(
  voiceState: VoiceState,
  armed: boolean,
  recognizing: boolean,
  anyVoiceAvailable: boolean,
): VoiceStatusPresentation {
  if (!anyVoiceAvailable) {
    return {
      mode: 'offline',
      label: 'OFFLINE',
      accessibleLabel: 'Voice offline',
    }
  }
  if (recognizing) {
    return {
      mode: 'listening',
      label: 'LISTENING',
      accessibleLabel: 'Listening',
    }
  }
  if (armed) {
    switch (voiceState) {
      case 'ERROR':
        return {
          mode: 'recovering',
          label: 'ERROR · RECOVERING',
          accessibleLabel: 'Voice error, recovering',
        }
      case 'CANCELLED':
        return {
          mode: 'recovering',
          label: 'CANCELLED',
          accessibleLabel: 'Voice cancelled, recovering',
        }
      case 'SPEAKING':
        return {
          mode: 'armed',
          label: 'SPEAKING',
          accessibleLabel: 'Jarvis speaking',
        }
      case 'PROCESSING':
        return {
          mode: 'armed',
          label: 'PROCESSING',
          accessibleLabel: 'Processing voice command',
        }
      default:
        return {
          mode: 'armed',
          label: voiceState.toUpperCase(),
          accessibleLabel: `Voice armed, ${voiceState.toLowerCase().replace(/_/g, ' ')}`,
        }
    }
  }
  // Unarmed but voice exists: report the REAL resting state.
  if (voiceState === 'CANCELLED' || voiceState === 'ERROR') {
    return {
      mode: 'recovering',
      label: 'RECOVERING',
      accessibleLabel: 'Voice session recovering',
    }
  }
  return {
    mode: 'standby',
    label: 'STANDBY',
    accessibleLabel: 'Voice standby',
  }
}