import { useEffect } from 'react'
import { dispatchInteraction } from '../interaction/controller'
import { ENVIRONMENT_DEFINITIONS } from '../environment/registry'

/**
 * HUD keyboard control surface.
 *
 * A single, central shortcut layer so environment/panel/zoom/theme shortcuts
 * live in one place. Every shortcut dispatches through the InteractionController
 * so mouse, touch and future webcam gestures share one verified action surface:
 *
 *   Ctrl+1..Ctrl+6  → jump to environment by registry index
 *   Ctrl+[  Ctrl+]   → previous / next environment
 *   Ctrl+0           → reset layout
 *   Ctrl+=  Ctrl+-   → zoom in / zoom out (active environment)
 *   Ctrl+9           → zoom reset
 *   Ctrl+T           → cycle theme
 *   Ctrl+Space       → CRUSH (close topmost open panel)
 *
 * Shortcuts are ignored while keyboard focus is inside an editable field
 * (input / textarea / contenteditable) so typing text never triggers them.
 */

interface ShortcutOptions {
  enabled?: boolean
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.closest('input, textarea, select, [contenteditable="true"]') !== null
}

export function useHudShortcuts(options: ShortcutOptions = {}): void {
  const enabled = options.enabled ?? true

  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      if (isEditableTarget(e.target)) return

      // Ctrl+1..6 — jump to environment by registry position
      if (e.key >= '1' && e.key <= '6' && !e.shiftKey) {
        const index = Number(e.key) - 1
        const def = ENVIRONMENT_DEFINITIONS[index]
        if (def) {
          e.preventDefault()
          dispatchInteraction({ action: 'select_environment', environment: def.id })
        }
        return
      }

      switch (e.key) {
        case '[':
          e.preventDefault()
          dispatchInteraction({ action: 'previous_environment' })
          break
        case ']':
          e.preventDefault()
          dispatchInteraction({ action: 'next_environment' })
          break
        case '=':
        case '+':
          e.preventDefault()
          dispatchInteraction({ action: 'zoom_in' })
          break
        case '-':
        case '_':
          e.preventDefault()
          dispatchInteraction({ action: 'zoom_out' })
          break
        case '9':
          e.preventDefault()
          dispatchInteraction({ action: 'zoom_reset' })
          break
        case '0':
          e.preventDefault()
          dispatchInteraction({ action: 'reset_layout' })
          break
        case 't':
        case 'T':
          e.preventDefault()
          dispatchInteraction({ action: 'theme_change' })
          break
        case ' ':
          e.preventDefault()
          dispatchInteraction({ action: 'crush' })
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}