import type { GestureCommand, GestureId } from './types'

/**
 * Phase 10 — centralized gesture-to-command mapping (mission #5).
 *
 * Physical gestures are decoupled from their effects. The mapping is the single
 * knob a user turns to change which real-world movement triggers which JARVIS
 * action. Every other module (tracker, gate, HUD, executor, tests) references
 * THIS single record, never hardcodes a mapping.
 *
 * "Central mapping for every physical movement the body can make" — this is
 * that mapping. A user edits only this file to reassign gestures; the pipeline
 * and the executor flow from it without modification.
 */

export const GESTURE_ACTION_MAP: Record<GestureId, GestureCommand> = {
  zoom_in: 'zoom_in',
  zoom_out: 'zoom_out',
  crush: 'crush',
  theme_change: 'theme_change',
}

/** Reassign a gesture's command at runtime (for the Settings UI in phase 20). */
export function remapGesture(gesture: GestureId, command: GestureCommand): void {
  GESTURE_ACTION_MAP[gesture] = command
}

/** Presentation labels shown in the HUD and taskbar. */
export const GESTURE_LABELS: Record<GestureId, string> = {
  zoom_in: 'Zoom In',
  zoom_out: 'Zoom Out',
  crush: 'Crush',
  theme_change: 'Theme Change',
}

/** Human-readable description of what a command actually does. */
export const GESTURE_DESCRIPTIONS: Record<GestureCommand, string> = {
  zoom_in: 'Increase the active environment zoom level',
  zoom_out: 'Decrease the active environment zoom level',
  crush: 'Close the topmost open panel',
  theme_change: 'Cycle to the next visual theme',
}