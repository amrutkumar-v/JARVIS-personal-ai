/**
 * Persistent task gateway seam.
 *
 * The HUD keeps AssistantEngine as its planning/orchestration authority, but
 * durable execution belongs to the persistent backend. When a gateway is
 * attached, task submission and control are delegated to the backend API
 * instead of the browser-scoped PersistentTaskOrchestrator. A gateway failure
 * is surfaced honestly; there is deliberately no silent fallback to
 * browser-only execution.
 */

import type {
  PersistentTask,
  TaskFilter,
} from './types'

export interface CreatePersistentTaskRequest {
  title: string
  objective: string
  priority?: number
  projectPath?: string
  subtasks?: Array<{
    title: string
    description?: string
    capability: string
    toolId?: string
    dependencies?: string[]
    payload?: Record<string, unknown>
    priority?: number
    maxRetries?: number
  }>
  tags?: string[]
  metadata?: Record<string, unknown>
  /**
   * Caller-supplied key that makes a retried submission idempotent. The
   * backend returns the original task instead of creating a duplicate.
   */
  idempotencyKey?: string
}

export interface CreatePersistentTaskResult {
  ok: boolean
  task?: PersistentTask
  error?: string
}

export interface PersistentTaskGateway {
  createTask(request: CreatePersistentTaskRequest): Promise<CreatePersistentTaskResult>
  listTasks(filter?: TaskFilter): Promise<PersistentTask[]>
  getTask(taskId: string): Promise<PersistentTask | null>
  pauseTask(taskId: string): Promise<boolean>
  resumeTask(taskId: string): Promise<boolean>
  cancelTask(taskId: string): Promise<boolean>
  approveTask(taskId: string, approvalId: string): Promise<boolean>
  rejectTask(taskId: string, approvalId: string, reason?: string): Promise<boolean>
}
