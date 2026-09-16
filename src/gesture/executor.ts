import type { GestureCommand, GestureActionResult } from './types'
import type { VisualEnvironmentId } from '../environment/types'
import { dispatchInteraction, type InteractionRequest } from '../interaction/controller'

/**
 * Phase 10 — command executor (mission #6), now a compat shim over the
 * InteractionController.
 *
 * Gesture recognition produces a `GestureCommand`; this executor maps it to a
 * normalized `InteractionRequest` and dispatches through the single verified
 * action surface. Every dispatch re-reads the store and only reports success
 * when the true post-condition holds. An empty command is an error; every
 * rejection carries a machine-readable `reason` for the engine notices.
 */

const COMMAND_TO_REQUEST: Record<GestureCommand, InteractionRequest> = {
  zoom_in: { action: 'zoom_in' },
  zoom_out: { action: 'zoom_out' },
  crush: { action: 'crush' },
  theme_change: { action: 'theme_change' },
}

export function executeGestureCommand(
  command: GestureCommand,
  activeEnvironmentId: VisualEnvironmentId,
): GestureActionResult {
  if (!command) {
    return { command, ok: false, reason: 'empty_command', detail: 'Empty gesture command.' }
  }

  const request = COMMAND_TO_REQUEST[command]
  if (!request) {
    return { command, ok: false, reason: 'unknown_command', detail: `Unknown command: ${String(command)}.` }
  }

  const result = dispatchInteraction(request, activeEnvironmentId)
  return {
    command,
    ok: result.ok,
    reason: result.reason,
    detail: result.detail,
  }
}