import type { ToolConfirmationRequest, MemoryConfirmRequest } from '../../engine/contracts'

type ConfirmRequest = ToolConfirmationRequest | MemoryConfirmRequest

interface Props {
  request: ConfirmRequest | null
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Unified confirmation dialog for tool operations and memory clear-all.
 * Shows WHAT, WHY, WHICH tool, and DATA IMPACT.
 */
export function ConfirmDialog({ request, onConfirm, onCancel }: Props) {
  if (!request) return null

  const isMemory = 'reason' in request
  const title = isMemory ? 'Confirm memory clear' : request.title
  const description = isMemory ? request.text : request.description
  const why = isMemory ? '' : request.why
  const impact = isMemory ? '' : request.impact

  return (
    <div className="confirm-overlay" role="alertdialog" aria-modal="true" aria-label="Confirm action">
      <div className="confirm-dialog">
        <h3>{title}</h3>
        <p>{description}</p>
        {why && <p className="confirm-why"><strong>Why:</strong> {why}</p>}
        {impact && <p className="confirm-impact"><strong>Data impact:</strong> {impact}</p>}
        <div className="confirm-actions">
          <button type="button" className="btn is-danger" onClick={onConfirm} aria-label="Confirm">
            {isMemory ? 'Yes, clear everything' : 'Yes, proceed'}
          </button>
          <button type="button" className="btn is-ghost" onClick={onCancel} aria-label="Cancel">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}