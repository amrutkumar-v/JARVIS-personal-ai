/**
 * Caller-facing JARVIS status. NOT an animation label — real application state.
 *
 * Phase 2.5 — the engine now emits the precise execution state it is really in
 * (understanding → planning → executing → observing → verifying), plus the
 * real terminal states (`success` / `failed` / `cancelled`). `thinking`,
 * `warning` and `error` remain for compatibility with older consumers and
 * auxiliary flows (provider reachability, memory-clear confirmations).
 */
export type JarvisStatus =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'understanding'
  | 'planning'
  | 'executing'
  | 'observing'
  | 'verifying'
  | 'cancelling'
  | 'speaking'
  | 'waiting_for_confirmation'
  | 'recovering'
  | 'retrying'
  | 'success'
  | 'warning'
  | 'error'
  | 'failed'
  | 'cancelled'

/** Audio engine states — talk to the OS audio layer, not the UI. */
export type TalkingState =
  | 'silent'
  | 'listening'
  | 'processing'
  | 'speaking'

export function talkingLabel(s: TalkingState): string {
  switch (s) {
    case 'listening':
      return 'LISTENING'
    case 'processing':
      return 'PROCESSING'
    case 'speaking':
      return 'SPEAKING'
    default:
      return 'SILENT'
  }
}