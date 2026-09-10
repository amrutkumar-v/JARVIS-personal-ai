/**
 * Per-run visual budgets (Phase 1.7) — pure decision helpers.
 *
 * Mirrors src/desktop/budget.ts: the vision providers are stateless across
 * requests, so the Web engine enforces the per-JARVIS-run ceiling
 * (`MAX_VISUAL_ACTIONS_PER_RUN`): no more than that many visual actions
 * (inspect/click/type) per task. Crossing the ceiling is an
 * `orchestration_limit` — the engine refuses BEFORE the action runs.
 *
 * Visual actions are budgeted SEPARATELY from the desktop mouse/key buckets:
 * a visual click still runs through the real desktop provider, but the model
 * is charged a visual action, not a raw mouse action, because it reasoned
 * through the eyes first.
 */
import { VISUAL_LIMITS } from './limits'

export type VisualBudgetBucket = 'visual' | undefined

/** Which per-run bucket (if any) a tool id consumes. */
export function visualBudgetBucket(toolId: string): VisualBudgetBucket {
  return toolId === 'desktop.visualInspect' || toolId === 'desktop.visualClick' || toolId === 'desktop.visualType'
    ? 'visual'
    : undefined
}

/** True when the visual bucket has already hit its per-run ceiling. */
export function visualBudgetExceeded(visualCount: number): boolean {
  return visualCount >= VISUAL_LIMITS.MAX_VISUAL_ACTIONS_PER_RUN
}

/** Human label for the blocked-action message. */
export function visualBudgetLabel(): string {
  return 'actions'
}