/**
 * Orchestration safety limits. Sensible dev defaults; a single place to tune
 * before a real agent is pointed at long-running tasks.
 */

export const AGENT_LIMITS = {
  /** Hard cap on total tool steps across ALL rounds of one task. */
  MAX_AGENT_STEPS: 8,
  /** Hard cap on provider reasoning rounds (each round may hold several steps). */
  MAX_TOOL_ROUNDS: 5,
  /** Wall-clock budget for one task, in milliseconds. */
  MAX_TOTAL_EXECUTION_TIME_MS: 30_000,
  /** Identical (tool, payload) executions allowed per run before blocking. */
  MAX_REPEATED_ACTIONS: 3,
} as const

export type AgentLimits = typeof AGENT_LIMITS