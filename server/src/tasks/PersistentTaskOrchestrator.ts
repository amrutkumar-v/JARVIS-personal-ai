/**
 * PersistentTaskOrchestrator (Phase B).
 *
 * Implements the full durable task lifecycle:
 * CREATED → PLANNING → VALIDATING → APPROVED → QUEUED → EXECUTING → OBSERVING → VERIFYING → COMPLETED
 *
 * Auxiliary states:
 * PAUSED, WAITING_FOR_PERMISSION, FAILED, CANCELLED, RECOVERY_REQUIRED
 */

import type {
  PersistentTask,
  Subtask,
  SubtaskState,
  TaskApproval,
  TaskCheckpoint,
  TaskFilter,
  TaskLifecycleState,
  TaskStorage,
} from './types.js'
import { TaskStore } from './TaskStore.js'

export interface SubtaskExecutionResult {
  success: boolean
  output?: unknown
  error?: string
  observation?: {
    kind: string
    summary: string
    data?: unknown
  }
  verification?: {
    passed: boolean
    evidence: string
  }
  requiresPermission?: {
    action: string
    description: string
    impact: string
    toolId: string
    payload?: Record<string, unknown>
  }
}

export type SubtaskExecutor = (
  subtask: Subtask,
  task: PersistentTask,
) => Promise<SubtaskExecutionResult>

export interface OrchestratorOptions {
  store?: TaskStore
  storage?: TaskStorage
  executor?: SubtaskExecutor
  maxConcurrentTasks?: number
  heartbeatIntervalMs?: number
  stallThresholdMs?: number
  onTaskStateChange?: (task: PersistentTask) => void
  onCheckpoint?: (checkpoint: TaskCheckpoint, task: PersistentTask) => void | Promise<void>
}

export class PersistentTaskOrchestrator {
  private readonly store: TaskStore
  private executor?: SubtaskExecutor
  private readonly maxConcurrentTasks: number
  private readonly stallThresholdMs: number
  private readonly onTaskStateChange?: (task: PersistentTask) => void
  private readonly onCheckpoint?: (checkpoint: TaskCheckpoint, task: PersistentTask) => void | Promise<void>
  private running = false
  private activeWorkers = new Set<string>()
  private loopTimer?: ReturnType<typeof setTimeout>

  constructor(options?: OrchestratorOptions) {
    this.store = options?.store ?? new TaskStore(options?.storage)
    this.executor = options?.executor
    this.maxConcurrentTasks = options?.maxConcurrentTasks ?? 1
    this.stallThresholdMs = options?.stallThresholdMs ?? 60_000
    this.onTaskStateChange = options?.onTaskStateChange
    this.onCheckpoint = options?.onCheckpoint
  }

  setExecutor(executor: SubtaskExecutor): void {
    this.executor = executor
  }

  getStore(): TaskStore {
    return this.store
  }

  async listTasks(filter?: TaskFilter): Promise<PersistentTask[]> {
    return this.store.listTasks(filter)
  }

  async getTask(taskId: string): Promise<PersistentTask | null> {
    return this.store.getTask(taskId)
  }

  async createTask(params: {
    title: string
    objective: string
    priority?: number
    subtasks?: Array<
      Omit<
        Subtask,
        | 'id'
        | 'taskId'
        | 'stepIndex'
        | 'state'
        | 'retries'
        | 'maxRetries'
      > & {
        maxRetries?: number
      }
    >
    tags?: string[]
    metadata?: Record<string, unknown>
  }): Promise<PersistentTask> {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = Date.now()

    const subtasks: Subtask[] = (params.subtasks || []).map((s, index) => ({
      ...s,
      id: `subtask-${taskId}-${index + 1}`,
      taskId,
      stepIndex: index,
      state: 'PENDING' as SubtaskState,
      retries: 0,
      maxRetries: s.maxRetries ?? 2,
      dependencies: s.dependencies ?? [],
      payload: s.payload ?? {},
    }))

    for (let i = 0; i < subtasks.length; i++) {
      subtasks[i].dependencies = subtasks[i].dependencies.map((dep) => {
        if (dep.startsWith('step-')) {
          const targetStep = parseInt(dep.replace('step-', ''), 10) - 1
          if (targetStep >= 0 && targetStep < subtasks.length) {
            return subtasks[targetStep].id
          }
        }
        return dep
      })
    }

    const task: PersistentTask = {
      id: taskId,
      title: params.title,
      objective: params.objective,
      priority: Math.min(100, Math.max(1, params.priority ?? 50)),
      state: 'CREATED',
      createdAt: now,
      updatedAt: now,
      subtasks,
      checkpoints: [],
      requiredApprovals: [],
      logs: [
        {
          id: `log-${now}-created`,
          taskId,
          timestamp: now,
          level: 'info',
          phase: 'CREATED',
          message: `Task created: ${params.title}`,
        },
      ],
      recoveryCount: 0,
      maxRecoveries: 3,
      lastHeartbeatAt: now,
      tags: params.tags ?? [],
      metadata: params.metadata ?? {},
    }

    await this.store.saveTask(task)
    this.notifyStateChange(task)
    return task
  }

  async transitionState(
    taskId: string,
    targetState: TaskLifecycleState,
    logMessage?: string,
    details?: Record<string, unknown>,
  ): Promise<PersistentTask | null> {
    const task = await this.store.getTask(taskId)
    if (!task) return null

    task.state = targetState
    task.updatedAt = Date.now()
    task.lastHeartbeatAt = Date.now()

    if (logMessage) {
      task.logs.push({
        id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        taskId,
        timestamp: Date.now(),
        level: targetState === 'FAILED' ? 'error' : 'info',
        phase: targetState,
        message: logMessage,
        details,
      })
    }

    await this.store.saveTask(task)
    this.notifyStateChange(task)
    return task
  }

  async queueTask(taskId: string): Promise<PersistentTask | null> {
    const task = await this.store.getTask(taskId)
    if (!task) return null

    for (const sub of task.subtasks) {
      if (sub.dependencies.length === 0 && sub.state === 'PENDING') {
        sub.state = 'READY'
      }
    }

    task.state = 'QUEUED'
    task.updatedAt = Date.now()
    task.lastHeartbeatAt = Date.now()
    task.logs.push({
      id: `log-${Date.now()}-queued`,
      taskId,
      timestamp: Date.now(),
      level: 'info',
      phase: 'QUEUED',
      message: 'Task queued for execution',
    })

    await this.store.saveTask(task)
    this.notifyStateChange(task)
    return task
  }

  async pauseTask(taskId: string): Promise<boolean> {
    const task = await this.store.getTask(taskId)
    if (!task) return false
    if (
      task.state !== 'EXECUTING' &&
      task.state !== 'QUEUED' &&
      task.state !== 'OBSERVING' &&
      task.state !== 'VERIFYING'
    ) {
      return false
    }

    task.state = 'PAUSED'
    task.updatedAt = Date.now()
    task.logs.push({
      id: `log-${Date.now()}-paused`,
      taskId,
      timestamp: Date.now(),
      level: 'info',
      phase: 'PAUSED',
      message: 'Task paused by user control',
    })

    await this.store.saveTask(task)
    this.activeWorkers.delete(taskId)
    this.notifyStateChange(task)
    return true
  }

  async resumeTask(taskId: string): Promise<boolean> {
    const task = await this.store.getTask(taskId)
    if (!task) return false
    if (task.state !== 'PAUSED' && task.state !== 'RECOVERY_REQUIRED') {
      return false
    }

    const verifiedIds = new Set(
      task.subtasks.filter((s: Subtask) => s.state === 'VERIFIED').map((s: Subtask) => s.id),
    )
    for (const sub of task.subtasks) {
      if (sub.state === 'PENDING') {
        const depsMet = sub.dependencies.every((d: string) => verifiedIds.has(d))
        if (depsMet) sub.state = 'READY'
      }
    }

    task.state = 'QUEUED'
    task.updatedAt = Date.now()
    task.lastHeartbeatAt = Date.now()
    task.logs.push({
      id: `log-${Date.now()}-resumed`,
      taskId,
      timestamp: Date.now(),
      level: 'info',
      phase: 'QUEUED',
      message: 'Task resumed and returned to queue',
    })

    await this.store.saveTask(task)
    this.notifyStateChange(task)
    return true
  }

  async cancelTask(taskId: string, reason = 'Cancelled by user'): Promise<boolean> {
    const task = await this.store.getTask(taskId)
    if (!task) return false
    if (task.state === 'COMPLETED' || task.state === 'CANCELLED') {
      return false
    }

    task.state = 'CANCELLED'
    task.completedAt = Date.now()
    task.updatedAt = Date.now()
    task.logs.push({
      id: `log-${Date.now()}-cancelled`,
      taskId,
      timestamp: Date.now(),
      level: 'warn',
      phase: 'CANCELLED',
      message: `Task cancelled: ${reason}`,
    })

    for (const sub of task.subtasks) {
      if (sub.state === 'EXECUTING' || sub.state === 'READY' || sub.state === 'PENDING') {
        sub.state = 'SKIPPED'
      }
    }

    await this.store.saveTask(task)
    this.activeWorkers.delete(taskId)
    this.notifyStateChange(task)
    return true
  }

  async approveAction(taskId: string, approvalId: string): Promise<boolean> {
    const task = await this.store.getTask(taskId)
    if (!task) return false

    const approval = task.requiredApprovals.find((a: TaskApproval) => a.id === approvalId)
    if (!approval || approval.granted !== undefined) return false

    approval.granted = true
    approval.resolvedAt = Date.now()
    approval.resolvedBy = 'user'

    task.logs.push({
      id: `log-${Date.now()}-approval-granted`,
      taskId,
      timestamp: Date.now(),
      level: 'security',
      phase: task.state,
      message: `Permission approved for: ${approval.action}`,
    })

    const remainingPending = task.requiredApprovals.some((a: TaskApproval) => a.granted === undefined)
    if (!remainingPending && task.state === 'WAITING_FOR_PERMISSION') {
      task.state = 'QUEUED'
      for (const sub of task.subtasks) {
        if (sub.state === 'WAITING_FOR_PERMISSION') {
          sub.state = 'READY'
        }
      }
    }

    task.updatedAt = Date.now()
    await this.store.saveTask(task)
    this.notifyStateChange(task)
    return true
  }

  async rejectAction(taskId: string, approvalId: string, reason = 'Rejected by user'): Promise<boolean> {
    const task = await this.store.getTask(taskId)
    if (!task) return false

    const approval = task.requiredApprovals.find((a: TaskApproval) => a.id === approvalId)
    if (!approval || approval.granted !== undefined) return false

    approval.granted = false
    approval.resolvedAt = Date.now()
    approval.resolvedBy = 'user'
    approval.note = reason

    task.logs.push({
      id: `log-${Date.now()}-approval-rejected`,
      taskId,
      timestamp: Date.now(),
      level: 'security',
      phase: task.state,
      message: `Permission rejected: ${reason}`,
    })

    task.state = 'FAILED'
    task.error = `Action denied: ${reason}`
    task.completedAt = Date.now()
    task.updatedAt = Date.now()

    await this.store.saveTask(task)
    this.activeWorkers.delete(taskId)
    this.notifyStateChange(task)
    return true
  }

  async recoverUnfinishedTasks(): Promise<PersistentTask[]> {
    const interruptedStates: TaskLifecycleState[] = [
      'EXECUTING',
      'OBSERVING',
      'VERIFYING',
      'PLANNING',
      'VALIDATING',
      'RECOVERY_REQUIRED',
    ]

    const candidates = await this.store.listTasks({ states: interruptedStates })
    const recovered: PersistentTask[] = []

    for (const task of candidates) {
      task.recoveryCount += 1
      const now = Date.now()

      if (task.recoveryCount > task.maxRecoveries) {
        task.state = 'FAILED'
        task.error = `Exceeded maximum recovery limit (${task.maxRecoveries})`
        task.completedAt = now
        task.updatedAt = now
        task.logs.push({
          id: `log-${now}-recovery-failed`,
          taskId: task.id,
          timestamp: now,
          level: 'error',
          phase: 'FAILED',
          message: task.error,
        })
        await this.store.saveTask(task)
        this.notifyStateChange(task)
        continue
      }

      const latestCheckpoint = task.checkpoints.length > 0
        ? task.checkpoints[task.checkpoints.length - 1]
        : null

      const verifiedIds = new Set(latestCheckpoint?.completedSubtaskIds || [])

      for (const sub of task.subtasks) {
        if (verifiedIds.has(sub.id)) {
          sub.state = 'VERIFIED'
        } else if (
          sub.state === 'EXECUTING' ||
          sub.state === 'OBSERVING' ||
          sub.state === 'VERIFYING'
        ) {
          sub.state = 'READY'
        }
      }

      task.state = 'QUEUED'
      task.lastHeartbeatAt = now
      task.updatedAt = now
      task.logs.push({
        id: `log-${now}-recovered`,
        taskId: task.id,
        timestamp: now,
        level: 'warn',
        phase: 'QUEUED',
        message: `Task recovered from restart. Checkpoint: ${latestCheckpoint?.checkpointId || 'initial'} (${verifiedIds.size} subtasks preserved)`,
      })

      await this.store.saveTask(task)
      this.notifyStateChange(task)
      recovered.push(task)
    }

    return recovered
  }

  async detectStalledTasks(): Promise<PersistentTask[]> {
    const activeTasks = await this.store.listTasks({
      states: ['EXECUTING', 'OBSERVING', 'VERIFYING'],
    })

    const now = Date.now()
    const stalled: PersistentTask[] = []

    for (const task of activeTasks) {
      if (now - task.lastHeartbeatAt > this.stallThresholdMs) {
        task.state = 'RECOVERY_REQUIRED'
        task.updatedAt = now
        task.logs.push({
          id: `log-${now}-stalled`,
          taskId: task.id,
          timestamp: now,
          level: 'warn',
          phase: 'RECOVERY_REQUIRED',
          message: `Stall detected: no heartbeat for ${Math.round((now - task.lastHeartbeatAt) / 1000)}s`,
        })

        await this.store.saveTask(task)
        this.activeWorkers.delete(task.id)
        this.notifyStateChange(task)
        stalled.push(task)
      }
    }

    return stalled
  }

  async tick(): Promise<void> {
    await this.detectStalledTasks()

    if (this.activeWorkers.size >= this.maxConcurrentTasks) {
      return
    }

    const queuedTasks = await this.store.listTasks({
      states: ['QUEUED'],
      limit: this.maxConcurrentTasks - this.activeWorkers.size,
    })

    const executions: Promise<void>[] = []
    for (const task of queuedTasks) {
      if (this.activeWorkers.has(task.id)) continue
      this.activeWorkers.add(task.id)
      const promise = this.executeTask(task.id).finally(() => {
        this.activeWorkers.delete(task.id)
      })
      executions.push(promise)
    }

    await Promise.all(executions)
  }

  start(pollIntervalMs = 1000): void {
    if (this.running) return
    this.running = true

    const runLoop = async () => {
      if (!this.running) return
      try {
        await this.tick()
      } catch {
        // Suppress tick errors to keep runner alive
      }
      if (this.running) {
        this.loopTimer = setTimeout(runLoop, pollIntervalMs)
      }
    }

    this.loopTimer = setTimeout(runLoop, 10)
  }

  stop(): void {
    this.running = false
    if (this.loopTimer) {
      clearTimeout(this.loopTimer)
      this.loopTimer = undefined
    }
  }

  private async executeTask(taskId: string): Promise<void> {
    const task = await this.store.getTask(taskId)
    if (!task || task.state !== 'QUEUED') return

    task.state = 'EXECUTING'
    task.startedAt = task.startedAt ?? Date.now()
    task.lastHeartbeatAt = Date.now()
    task.updatedAt = Date.now()
    task.logs.push({
      id: `log-${Date.now()}-executing`,
      taskId,
      timestamp: Date.now(),
      level: 'info',
      phase: 'EXECUTING',
      message: 'Starting execution of task subtasks',
    })
    await this.store.saveTask(task)
    this.notifyStateChange(task)

    while (true) {
      const currentTask = await this.store.getTask(taskId)
      if (!currentTask) break
      if (
        currentTask.state === 'PAUSED' ||
        currentTask.state === 'CANCELLED' ||
        currentTask.state === 'FAILED' ||
        currentTask.state === 'WAITING_FOR_PERMISSION'
      ) {
        break
      }

      currentTask.lastHeartbeatAt = Date.now()
      await this.store.saveTask(currentTask)

      const verifiedIds = new Set(
        currentTask.subtasks
          .filter((s: Subtask) => s.state === 'VERIFIED')
          .map((s: Subtask) => s.id),
      )

      for (const sub of currentTask.subtasks) {
        if (sub.state === 'PENDING' || sub.state === 'WAITING_FOR_PERMISSION') {
          const allDepsMet = sub.dependencies.every((d: string) => verifiedIds.has(d))
          if (allDepsMet) {
            sub.state = 'READY'
          }
        }
      }

      const nextSubtask = currentTask.subtasks.find((s: Subtask) => s.state === 'READY')
      if (!nextSubtask) {
        const allDone = currentTask.subtasks.every((s: Subtask) => s.state === 'VERIFIED')
        const anyFailed = currentTask.subtasks.some((s: Subtask) => s.state === 'FAILED')

        if (allDone) {
          currentTask.state = 'VERIFYING'
          currentTask.logs.push({
            id: `log-${Date.now()}-verifying`,
            taskId,
            timestamp: Date.now(),
            level: 'info',
            phase: 'VERIFYING',
            message: 'All subtasks verified. Running final task verification.',
          })
          await this.store.saveTask(currentTask)
          this.notifyStateChange(currentTask)

          currentTask.state = 'COMPLETED'
          currentTask.completedAt = Date.now()
          currentTask.updatedAt = Date.now()
          currentTask.logs.push({
            id: `log-${Date.now()}-completed`,
            taskId,
            timestamp: Date.now(),
            level: 'info',
            phase: 'COMPLETED',
            message: `Task successfully completed (${currentTask.subtasks.length} subtasks verified).`,
          })
          await this.store.saveTask(currentTask)
          this.notifyStateChange(currentTask)
          break
        }

        if (anyFailed) {
          currentTask.state = 'FAILED'
          currentTask.error = 'One or more required subtasks failed'
          currentTask.completedAt = Date.now()
          currentTask.updatedAt = Date.now()
          await this.store.saveTask(currentTask)
          this.notifyStateChange(currentTask)
          break
        }

        if (currentTask.subtasks.length === 0) {
          currentTask.state = 'COMPLETED'
          currentTask.completedAt = Date.now()
          await this.store.saveTask(currentTask)
          this.notifyStateChange(currentTask)
          break
        }

        currentTask.state = 'FAILED'
        currentTask.error = 'Unresolvable circular or unmet dependencies'
        currentTask.completedAt = Date.now()
        await this.store.saveTask(currentTask)
        this.notifyStateChange(currentTask)
        break
      }

      currentTask.currentSubtaskId = nextSubtask.id
      nextSubtask.state = 'EXECUTING'
      nextSubtask.startedAt = Date.now()
      await this.store.saveTask(currentTask)
      this.notifyStateChange(currentTask)

      if (!this.executor) {
        nextSubtask.state = 'FAILED'
        nextSubtask.result = { success: false, error: 'No executor registered' }
        await this.store.saveTask(currentTask)
        break
      }

      try {
        const result = await this.executor(nextSubtask, currentTask)

        if (result.requiresPermission) {
          const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
          const approval: TaskApproval = {
            id: approvalId,
            action: result.requiresPermission.action,
            description: result.requiresPermission.description,
            impact: result.requiresPermission.impact,
            toolId: result.requiresPermission.toolId,
            payload: result.requiresPermission.payload,
            createdAt: Date.now(),
          }
          currentTask.requiredApprovals.push(approval)
          currentTask.state = 'WAITING_FOR_PERMISSION'
          nextSubtask.state = 'WAITING_FOR_PERMISSION'
          currentTask.logs.push({
            id: `log-${Date.now()}-permission-req`,
            taskId,
            timestamp: Date.now(),
            level: 'security',
            phase: 'WAITING_FOR_PERMISSION',
            subtaskId: nextSubtask.id,
            message: `Approval required for action: ${approval.action}`,
          })
          await this.store.saveTask(currentTask)
          this.notifyStateChange(currentTask)
          break
        }

        nextSubtask.state = 'OBSERVING'
        if (result.observation) {
          nextSubtask.observation = result.observation
        }

        nextSubtask.state = 'VERIFYING'
        const passedVerification =
          result.success &&
          result.verification?.passed === true &&
          Boolean(result.verification?.evidence)

        if (passedVerification) {
          nextSubtask.state = 'VERIFIED'
          nextSubtask.completedAt = Date.now()
          nextSubtask.result = {
            success: true,
            output: result.output,
          }
          nextSubtask.verification = {
            passed: true,
            evidence: result.verification!.evidence,
            timestamp: Date.now(),
          }

          const completedIds = currentTask.subtasks
            .filter((s: Subtask) => s.state === 'VERIFIED')
            .map((s: Subtask) => s.id)

          const checkpoint: Omit<
            TaskCheckpoint,
            'checkpointId' | 'taskId' | 'timestamp'
          > = {
            state: 'EXECUTING',
            subtaskIndex: nextSubtask.stepIndex,
            completedSubtaskIds: completedIds,
            verifiedArtifacts: {
              ...(currentTask.checkpoints[currentTask.checkpoints.length - 1]
                ?.verifiedArtifacts || {}),
              [nextSubtask.id]: result.output,
            },
            summary: `Subtask ${nextSubtask.title} verified: ${result.verification!.evidence}`,
            executionStateHash: `hash-${completedIds.length}-${Date.now()}`,
          }

          const cp = await this.store.appendCheckpoint(taskId, checkpoint)
          if (cp) {
            currentTask.checkpoints.push(cp)
            if (this.onCheckpoint) {
              await this.onCheckpoint(cp, currentTask)
            }
          }

          currentTask.logs.push({
            id: `log-${Date.now()}-subtask-verified`,
            taskId,
            timestamp: Date.now(),
            level: 'info',
            phase: 'EXECUTING',
            subtaskId: nextSubtask.id,
            message: `Subtask verified: ${nextSubtask.title} (${result.verification!.evidence})`,
          })
        } else {
          nextSubtask.retries += 1
          if (nextSubtask.retries <= nextSubtask.maxRetries) {
            nextSubtask.state = 'READY'
            currentTask.logs.push({
              id: `log-${Date.now()}-subtask-retry`,
              taskId,
              timestamp: Date.now(),
              level: 'warn',
              phase: 'EXECUTING',
              subtaskId: nextSubtask.id,
              message: `Subtask verification failed. Retrying (${nextSubtask.retries}/${nextSubtask.maxRetries}): ${result.error || 'Verification not satisfied'}`,
            })
          } else {
            nextSubtask.state = 'FAILED'
            nextSubtask.result = {
              success: false,
              error: result.error || 'Verification failed after maximum retries',
            }
            currentTask.state = 'RECOVERY_REQUIRED'
            currentTask.logs.push({
              id: `log-${Date.now()}-subtask-failed`,
              taskId,
              timestamp: Date.now(),
              level: 'error',
              phase: 'RECOVERY_REQUIRED',
              subtaskId: nextSubtask.id,
              message: `Subtask failed after ${nextSubtask.maxRetries} retries: ${result.error || 'Verification unsatisfied'}`,
            })
            await this.store.saveTask(currentTask)
            this.notifyStateChange(currentTask)
            break
          }
        }

        currentTask.updatedAt = Date.now()
        await this.store.saveTask(currentTask)
        this.notifyStateChange(currentTask)
      } catch (err) {
        nextSubtask.state = 'FAILED'
        nextSubtask.result = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }
        currentTask.state = 'RECOVERY_REQUIRED'
        currentTask.updatedAt = Date.now()
        await this.store.saveTask(currentTask)
        this.notifyStateChange(currentTask)
        break
      }
    }
  }

  private notifyStateChange(task: PersistentTask): void {
    if (this.onTaskStateChange) {
      try {
        this.onTaskStateChange(task)
      } catch {
        // Suppress listener error
      }
    }
  }
}

