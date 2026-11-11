/**
 * Persistent Task Architecture — Type Definitions (Phase B).
 *
 * Formalizes the durable task lifecycle, subtask DAG dependencies,
 * execution checkpoints, and recovery states for autonomous background execution.
 */

export type TaskLifecycleState =
  | 'CREATED'
  | 'PLANNING'
  | 'VALIDATING'
  | 'APPROVED'
  | 'QUEUED'
  | 'EXECUTING'
  | 'OBSERVING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'PAUSED'
  | 'WAITING_FOR_PERMISSION'
  | 'FAILED'
  | 'CANCELLED'
  | 'RECOVERY_REQUIRED'

export type SubtaskState =
  | 'PENDING'
  | 'READY'
  | 'EXECUTING'
  | 'OBSERVING'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'FAILED'
  | 'SKIPPED'
  | 'WAITING_FOR_PERMISSION'

export interface TaskApproval {
  id: string
  action: string
  description: string
  impact: string
  toolId?: string
  payload?: Record<string, unknown>
  createdAt: number
  granted?: boolean
  resolvedAt?: number
  resolvedBy?: 'user' | 'policy'
  note?: string
}

export interface Subtask {
  id: string
  taskId: string
  stepIndex: number
  title: string
  description: string
  capability: string
  toolId: string
  payload: Record<string, unknown>
  priority: number
  dependencies: string[]
  state: SubtaskState
  retries: number
  maxRetries: number
  startedAt?: number
  completedAt?: number
  result?: {
    success: boolean
    output?: unknown
    error?: string
  }
  observation?: {
    kind: string
    summary: string
    data?: unknown
  }
  verification?: {
    passed: boolean
    evidence: string
    timestamp: number
  }
}

export interface TaskCheckpoint {
  checkpointId: string
  taskId: string
  timestamp: number
  state: TaskLifecycleState
  subtaskIndex: number
  completedSubtaskIds: string[]
  verifiedArtifacts: Record<string, unknown>
  summary: string
  executionStateHash: string
}

export interface TaskLogEntry {
  id: string
  taskId: string
  timestamp: number
  level: 'info' | 'warn' | 'error' | 'security'
  phase: TaskLifecycleState
  subtaskId?: string
  message: string
  details?: Record<string, unknown>
}

export interface PersistentTask {
  id: string
  title: string
  objective: string
  priority: number
  state: TaskLifecycleState
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  subtasks: Subtask[]
  currentSubtaskId?: string
  checkpoints: TaskCheckpoint[]
  requiredApprovals: TaskApproval[]
  logs: TaskLogEntry[]
  error?: string
  recoveryCount: number
  maxRecoveries: number
  lastHeartbeatAt: number
  tags: string[]
  metadata: Record<string, unknown>
}

export interface TaskFilter {
  states?: TaskLifecycleState[]
  tags?: string[]
  limit?: number
  offset?: number
}

export interface TaskStorage {
  save(task: PersistentTask): Promise<void>
  get(taskId: string): Promise<PersistentTask | null>
  list(filter?: TaskFilter): Promise<PersistentTask[]>
  delete(taskId: string): Promise<boolean>
  saveCheckpoint(taskId: string, checkpoint: TaskCheckpoint): Promise<void>
}

