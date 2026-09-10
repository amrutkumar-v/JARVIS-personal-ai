/**
 * Explicit agent execution state machine (Phase 1.0).
 *
 * Replaces "scattered booleans" (`running`, `cancelRequested`, …) with a small
 * explicit model the engine drives each request, so agent state is observable
 * and testable. The states mirror the agent loop:
 *
 *   idle
 *     → understanding        (text received, context being prepared)
 *     → planning             (provider chooses: answer directly or use tools)
 *     → executing            (tool batch being run)
 *     → observing            (observations/verifications collected)
 *     → verifying            (final result; nothing left to execute)
 *     → completed
 *
 * Any non-terminal state may go to `failed` (error/limit) or `cancelled`.
 * Terminal states never leave.
 */

export type AgentState =
  | 'idle'
  | 'understanding'
  | 'planning'
  | 'executing'
  | 'observing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'

const TERMINAL: ReadonlySet<AgentState> = new Set<AgentState>([
  'completed',
  'failed',
  'cancelled',
])

/** True once the run has ended (completed / failed / cancelled). */
export function stateTerminal(state: AgentState): boolean {
  return TERMINAL.has(state)
}

/**
 * Pure transition rule. Returns the target state when the transition is legal,
 * `undefined` otherwise. Terminal states accept no outgoing transitions.
 * Any non-terminal state may still be cancelled or fail, so cancellation and
 * short-circuit errors are always legal.
 */
export function canTransition(from: AgentState, to: AgentState): AgentState | undefined {
  if (TERMINAL.has(from)) return undefined
  if (from === to) return to
  switch (from) {
    case 'idle':
      return to === 'understanding' ? to : undefined
    case 'understanding':
      return to === 'planning' || to === 'failed' || to === 'cancelled' ? to : undefined
    case 'planning':
      return to === 'executing' || to === 'verifying' || to === 'failed' || to === 'cancelled' ? to : undefined
    case 'executing':
      return to === 'observing' || to === 'failed' || to === 'cancelled' ? to : undefined
    case 'observing':
      return to === 'planning' || to === 'verifying' || to === 'failed' || to === 'cancelled' ? to : undefined
    case 'verifying':
      return to === 'completed' || to === 'failed' || to === 'cancelled' ? to : undefined
    default:
      return undefined
  }
}

/** Tiny mutable wrapper the engine drives; pure rules live in `canTransition`. */
export class AgentStateMachine {
  private current: AgentState = 'idle'

  get state(): AgentState {
    return this.current
  }

  get active(): boolean {
    return !stateTerminal(this.current)
  }

  /** Move to `next` only when the transition rule allows it. */
  transition(next: AgentState): boolean {
    const allowed = canTransition(this.current, next)
    if (!allowed) return false
    this.current = next
    return true
  }

  /** Force a terminal state (used when the run must stop at any point). */
  finish(status: 'completed' | 'failed' | 'cancelled'): void {
    this.current = status
  }

  reset(): void {
    this.current = 'idle'
  }
}