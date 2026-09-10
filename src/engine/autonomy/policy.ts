import type { Tool } from '../../tools/Tool'

/**
 * Phase 3.0 — autonomy policy (bounded, engine-owned, never model-controlled).
 *
 * Defines how much action-approval JARVIS may waive for a single run. The
 * policy ONLY derates the `user_confirmation` permission tier of NON-DESTRUCTIVE,
 * NON-COMMUNICATING, LOCAL tools. It can never:
 *   - auto-run a `high_risk` tool (those are refused outright by the permission
 *     layer — no autonomy level creates an approval that does not exist), or
 *   - bypass the HARD FLOOR: tools whose category is `communication`, `system`
 *     or `future` keep their explicit user confirmation at EVERY level.
 *
 * Rationale for the floor:
 *   - `communication`  → external side effects (contacts, sends) always confirm.
 *   - `system`         → the destructive file/OS operations live here
 *                       (e.g. the delete tool); deleting user data is never
 *                       something a level may waive.
 *   - `future`         → unknown semantics; confirm by default.
 *
 * Default is `assisted`: today's behavior, nothing is waived.
 */

export type AutonomyLevel = 'assisted' | 'safe_automation' | 'controlled_autonomy'

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = [
  'assisted',
  'safe_automation',
  'controlled_autonomy',
]

export const AUTONOMY_LEVEL_LABELS: Record<AutonomyLevel, string> = {
  assisted: 'Assisted — every impactful action asks first',
  safe_automation: 'Safe automation — bounded local actions auto-run, destructive/external still ask',
  controlled_autonomy: 'Controlled autonomy — bounded local actions auto-run; approval rails stay intact',
}

/** Categories that NO autonomy level may auto-approve. */
export const AUTONOMY_HARD_FLOOR_CATEGORIES: ReadonlySet<string> = new Set([
  'communication',
  'system',
  'future',
])

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return typeof value === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(value)
}

/**
 * Whether the given level may auto-approve a tool that the permission layer
 * classified as `user_confirmation`. Every other permission tier is untouched:
 * readers already auto-run, `high_risk` stays refused.
 */
export function autonomyAllowsAuto(level: AutonomyLevel, tool: Pick<Tool, 'permission' | 'category'>): boolean {
  if (tool.permission !== 'user_confirmation') return false
  if (level === 'assisted') return false
  if (AUTONOMY_HARD_FLOOR_CATEGORIES.has(tool.category)) return false
  return true
}

export function defaultAutonomy(): AutonomyLevel {
  return 'assisted'
}