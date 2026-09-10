import type { MemoryConfirmRequest } from '../../hooks/useAssistant'

interface Props {
  request: MemoryConfirmRequest | null
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirmation gate for destructive memory operations (clear-all).
 * Rendered app-wide so a tool- or settings-driven clear is never silent.
 */
export function MemoryConfirmDialog({ request, onConfirm, onCancel }: Props) {
  if (!request) return null
  return (
    <div className="confirm-overlay" role="alertdialog" aria-modal="true" aria-label="Confirm action">
      <div className="confirm-dialog">
        <h3>Confirm memory clear</h3>
        <p>{request.text}</p>
        <div className="confirm-actions">
          <button type="button" className="btn is-danger" onClick={onConfirm} aria-label="Confirm">
            Yes, clear everything
          </button>
          <button type="button" className="btn is-ghost" onClick={onCancel} aria-label="Cancel">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}