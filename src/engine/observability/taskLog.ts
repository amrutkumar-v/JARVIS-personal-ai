import type { AutonomyLevel } from '../autonomy/policy'
import type { OrchestrationExecutionStatus } from '../orchestrator/execution'

/**
 * Phase 3.0 — structured task-execution log (§14 observability).
 *
 * Every orchestrated task (executed OR refused before execution) is recorded
 * as one bounded, content-free entry: goal text, the autonomy level it ran
 * under, which capabilities were resolved, which concrete steps ran (with
 * success/failure/skip), observed failures and the final verdict. Entries
 * never contain prompts sent to a model, chain-of-thought, typed secrets,
 * screenshots or raw tool payloads.
 *
 * The log is a pure, injectable seam so tests (and any future server sync)
 * can observe what really happened without reaching into engine internals.
 */

export type TaskVerdict = OrchestrationExecutionStatus | 'interrupted'

export interface TaskLogStep {
  capability: string
  toolId: string
  status: 'success' | 'failed' | 'skipped'
}

export interface TaskLogFailure {
  toolId: string
  errorKind?: string
  summary: string
}

export interface TaskLogResolution {
  capability: string
  toolId: string
  fallback?: boolean
}

export interface TaskLogEntry {
  taskId: string
  startedAt: string
  finishedAt: string
  goal: string
  autonomy: AutonomyLevel
  resolutions: TaskLogResolution[]
  steps: TaskLogStep[]
  failures: TaskLogFailure[]
  verdict: TaskVerdict
  reason?: string
}

export interface TaskLog {
  record(entry: TaskLogEntry): void
  entries(): readonly TaskLogEntry[]
}

/** Bounded, in-memory task log. Keeps only the most recent `maxEntries`. */
export class InMemoryTaskLog implements TaskLog {
  private readonly log: TaskLogEntry[] = []
  private readonly maxEntries: number

  constructor(maxEntries = 20) {
    this.maxEntries = maxEntries
  }

  record(entry: TaskLogEntry): void {
    this.log.push(entry)
    while (this.log.length > Math.max(1, this.maxEntries)) this.log.shift()
  }

  entries(): readonly TaskLogEntry[] {
    return this.log
  }
}

export function createTaskId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}