import type { JarvisStatus } from '../../engine/types'

const LABELS: Record<JarvisStatus, string> = {
  idle: 'IDLE',
  listening: 'LISTENING',
  thinking: 'THINKING',
  understanding: 'UNDERSTANDING',
  planning: 'PLANNING',
  executing: 'EXECUTING',
  observing: 'OBSERVING',
  verifying: 'VERIFYING',
  cancelling: 'CANCELLING',
  speaking: 'SPEAKING',
  waiting_for_confirmation: 'CONFIRMATION',
  recovering: 'RECOVERING',
  retrying: 'RETRYING',
  success: 'DONE',
  warning: 'WARNING',
  error: 'ERROR',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
}

export function StatusChip({ status }: { status: JarvisStatus }) {
  return (
    <span className="status-chip" data-status={status} role="status" aria-live="polite">
      <span className="status-dot" aria-hidden="true" />
      {LABELS[status]}
    </span>
  )
}