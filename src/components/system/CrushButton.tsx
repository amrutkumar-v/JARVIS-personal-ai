import { usePanelLayoutStore } from '../../panel/panelStore'
import { dispatchInteraction } from '../../interaction/controller'

/**
 * Crush button — a dock FAB that collapses a floating panel back to its docked
 * right-edge slot (same `crush` action as Ctrl+Space and the webcam CRUSH
 * gesture, all routed through InteractionController into the layout store).
 *
 * It only exists while at least one panel is actually open, so it never offers
 * a dead action. It reads the layout store directly but never writes to it.
 */
export function CrushButton() {
  const openFloatingCount = usePanelLayoutStore(
    (s) =>
      Object.values(s.panels).filter((p) => p.open && p.placement === 'floating').length,
  )

  if (openFloatingCount === 0) {
    return null
  }

  return (
    <button
      type="button"
      className="crush-button"
      aria-label="Close topmost panel"
      title="Crush — close topmost panel"
      onClick={() => {
        dispatchInteraction({ action: 'crush' })
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="7" width="18" height="10" rx="2" />
        <line x1="12" y1="7" x2="12" y2="17" />
        <path d="M8 7v10" />
        <path d="M16 7v10" />
      </svg>
    </button>
  )
}