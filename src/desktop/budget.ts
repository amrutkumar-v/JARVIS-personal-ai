import { DESKTOP_LIMITS } from './limits'

/**
 * Per-run desktop budgets (Phase 1.5) — pure decision helpers.
 *
 * The native agent is stateless across requests, so the Web engine enforces
 * the per-JARVIS-run input ceilings: no more than `MAX_MOUSE_ACTIONS_PER_RUN`
 * mouse actions (move/click/double/right/scroll) and no more than
 * `MAX_KEY_ACTIONS_PER_RUN` key actions (key_press/hotkey/type) per task.
 * Crossing a ceiling is an `orchestration_limit` — the engine refuses to
 * inject before the action runs. A single agent run can stay well under
 * these ceilings in practice (AGENT_LIMITS caps steps first); these are the
 * hard ceiling a malformed model could otherwise drive past.
 */
export type DesktopBudgetBucket = 'mouse' | 'keys' | undefined

export const DESKTOP_BUDGET = {
  mouse: DESKTOP_LIMITS.MAX_MOUSE_ACTIONS_PER_RUN,
  keys: DESKTOP_LIMITS.MAX_KEY_ACTIONS_PER_RUN,
} as const

/** Which per-run bucket (if any) a tool id consumes. */
export function desktopBudgetBucket(toolId: string): DesktopBudgetBucket {
  switch (toolId) {
    case 'desktop.move':
    case 'desktop.click':
    case 'desktop.double_click':
    case 'desktop.right_click':
    case 'desktop.scroll':
      return 'mouse'
    case 'desktop.key_press':
    case 'desktop.hotkey':
    case 'desktop.type':
      return 'keys'
    default:
      return undefined
  }
}

/** True when the given bucket has already hit its per-run ceiling. */
export function desktopBudgetExceeded(
  bucket: DesktopBudgetBucket,
  mouseCount: number,
  keyCount: number,
): boolean {
  if (bucket === 'mouse') return mouseCount >= DESKTOP_BUDGET.mouse
  if (bucket === 'keys') return keyCount >= DESKTOP_BUDGET.keys
  return false
}

/** Human label for the blocked-action message. */
export function desktopBudgetLabel(bucket: Exclude<DesktopBudgetBucket, undefined>): string {
  return bucket === 'mouse' ? 'mouse' : 'keyboard'
}