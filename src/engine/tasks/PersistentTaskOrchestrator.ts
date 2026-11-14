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
} from './types'
import { TaskStore } from './TaskStore'
import { SpecialistDelegator } from './SpecialistWorkerPool'

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
  onCheckpoint?: (checkpoint: TaskCheckpoint, task: PersistentTask) => Promise<void> | void
}

export class PersistentTaskOrchestrator {
  private readonly store: TaskStore
  private readonly delegator = new SpecialistDelegator()
  private executor?: SubtaskExecutor
  private readonly maxConcurrentTasks: number
  private readonly stallThresholdMs: number
  private readonly onTaskStateChange?: (task: PersistentTask) => void
  private readonly onCheckpoint?: (checkpoint: TaskCheckpoint, task: PersistentTask) => Promise<void> | void
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

  getDelegator(): SpecialistDelegator {
    return this.delegator
  }

  async getTask(id: string): Promise<PersistentTask | null> {
    return this.store.getTask(id)
  }

  async listTasks(filter?: TaskFilter): Promise<PersistentTask[]> {
    return this.store.listTasks(filter)
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

    // Resolve relative step dependencies (e.g. 'step-1' or 'subtask-0' -> subtask-${taskId}-1)
    for (const subtask of subtasks) {
      subtask.dependencies = subtask.dependencies.map((dep) => {
        const stepMatch = dep.match(/^step-(\d+)$/i)
        if (stepMatch) {
          const stepIdx = parseInt(stepMatch[1], 10) - 1
          if (stepIdx >= 0 && stepIdx < subtasks.length) {
            return subtasks[stepIdx].id
          }
        }
        const subMatch = dep.match(/^subtask-(\d+)$/i)
        if (subMatch) {
          const raw = parseInt(subMatch[1], 10)
          const stepIdx = raw < subtasks.length ? raw : raw - 1
          if (stepIdx >= 0 && stepIdx < subtasks.length) {
            return subtasks[stepIdx].id
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
    for (const sub of task.subtasks) {
      if (
        sub.state === 'EXECUTING' ||
        sub.state === 'OBSERVING' ||
        sub.state === 'VERIFYING'
      ) {
        sub.state = 'PENDING'
      }
    }
    task.logs.push({
      id: `log-${Date.now()}-paused`,
      taskId,
      timestamp: Date.now(),
      level: 'info',
      phase: 'PAUSED',
      message: 'Task paused by user control',
    })

    await this.store.saveTask(task)
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
      if (
        sub.state === 'EXECUTING' ||
        sub.state === 'OBSERVING' ||
        sub.state === 'VERIFYING'
      ) {
        sub.state = 'PENDING'
      }
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
        const hasEvidence =
          sub.state === 'VERIFIED' &&
          sub.verification?.passed === true &&
          Boolean(sub.verification.evidence?.trim())
        if (hasEvidence) continue
        if (
          verifiedIds.has(sub.id) ||
          sub.state === 'VERIFIED' ||
          sub.state === 'EXECUTING' ||
          sub.state === 'OBSERVING' ||
          sub.state === 'VERIFYING'
        ) {
          sub.state = 'PENDING'
        }
      }
      const verifiedNow = new Set(
        task.subtasks
          .filter(
            (sub) =>
              sub.state === 'VERIFIED' &&
              sub.verification?.passed === true &&
              Boolean(sub.verification.evidence?.trim()),
          )
          .map((sub) => sub.id),
      )
      for (const sub of task.subtasks) {
        if (
          sub.state === 'PENDING' &&
          sub.dependencies.every((dependency) => verifiedNow.has(dependency))
        ) {
          sub.state = 'READY'
        }
      }
      const preserved = task.subtasks.filter(
        (sub) =>
          sub.state === 'VERIFIED' &&
          sub.verification?.passed === true &&
          Boolean(sub.verification.evidence?.trim()),
      ).length

      task.state = 'QUEUED'
      task.lastHeartbeatAt = now
      task.updatedAt = now
      task.logs.push({
        id: `log-${now}-recovered`,
        taskId: task.id,
        timestamp: now,
        level: 'warn',
        phase: 'QUEUED',
        message: `Task recovered from restart. Checkpoint: ${latestCheckpoint?.checkpointId || 'initial'} (${preserved} subtasks preserved with evidence)`,
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
      if (this.activeWorkers.has(task.id)) continue
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
      let currentTask = await this.store.getTask(taskId)
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

      let nextSubtask = currentTask.subtasks.find((s: Subtask) => s.state === 'READY')
      if (!nextSubtask) {
        const allDone =
          currentTask.subtasks.length > 0 &&
          currentTask.subtasks.every((s: Subtask) => s.state === 'VERIFIED')
        const anyFailed = currentTask.subtasks.some((s: Subtask) => s.state === 'FAILED')
        const unproven = currentTask.subtasks.find(
          (s: Subtask) =>
            s.state === 'VERIFIED' &&
            !(s.verification?.passed === true && Boolean(s.verification.evidence?.trim())),
        )

        if (allDone && unproven) {
          currentTask.state = 'FAILED'
          currentTask.error = `Completion blocked: subtask "${unproven.title}" has no passing verification evidence.`
          currentTask.completedAt = Date.now()
          currentTask.updatedAt = Date.now()
          currentTask.logs.push({
            id: `log-${Date.now()}-completion-blocked`,
            taskId,
            timestamp: Date.now(),
            level: 'error',
            phase: 'FAILED',
            subtaskId: unproven.id,
            message: currentTask.error,
          })
          await this.store.saveTask(currentTask)
          this.notifyStateChange(currentTask)
          break
        }

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

          const verification = await this.verifyObjectiveCompletion(currentTask)
          if (!verification.satisfied) {
            currentTask.state = 'FAILED'
            currentTask.error = `Completion blocked: ${verification.reason}`
            currentTask.completedAt = Date.now()
            currentTask.updatedAt = Date.now()
            currentTask.logs.push({
              id: `log-${Date.now()}-completion-blocked`,
              taskId,
              timestamp: Date.now(),
              level: 'error',
              phase: 'FAILED',
              message: currentTask.error,
              details: verification.evidence,
            })
            await this.store.saveTask(currentTask)
            this.notifyStateChange(currentTask)
            break
          }

          currentTask.state = 'COMPLETED'
          currentTask.completedAt = Date.now()
          currentTask.updatedAt = Date.now()
          const aggregation = this.delegator.aggregateResults(currentTask.subtasks)
          currentTask.metadata = {
            ...(currentTask.metadata || {}),
            specialistSummary: aggregation.summary,
            specialistAggregation: aggregation,
            completionEvidence: verification.evidence,
            objectiveVerified: true,
          }
          currentTask.logs.push({
            id: `log-${Date.now()}-completed`,
            taskId,
            timestamp: Date.now(),
            level: 'info',
            phase: 'COMPLETED',
            message: `Task successfully completed and objective verified (${currentTask.subtasks.length} subtasks verified).`,
            details: verification.evidence,
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
          currentTask.state = 'FAILED'
          currentTask.error = 'Task has no executable subtasks; nothing was verified.'
          currentTask.completedAt = Date.now()
          currentTask.updatedAt = Date.now()
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

      // Specialist worker delegation & authorization gate (Phase 10)
      if (!nextSubtask.workerRole || !nextSubtask.lineage) {
        const delegated = this.delegator.delegateSubtask(nextSubtask, currentTask.id)
        Object.assign(nextSubtask, delegated)
      }

      const auth = this.delegator.validateSubtaskExecution(nextSubtask)
      if (!auth.allowed) {
        nextSubtask.state = 'FAILED'
        nextSubtask.result = { success: false, error: auth.reason }
        currentTask.state = 'FAILED'
        currentTask.error = auth.reason
        await this.store.saveTask(currentTask)
        this.notifyStateChange(currentTask)
        break
      }

      await this.store.saveTask(currentTask)
      this.notifyStateChange(currentTask)

      if (!this.executor) {
        nextSubtask.state = 'FAILED'
        nextSubtask.result = { success: false, error: 'No executor registered' }
        await this.store.saveTask(currentTask)
        break
      }

      try {
        const executingSubtaskId = nextSubtask.id
        const result = await this.executor(nextSubtask, currentTask)

        const latest = await this.store.getTask(taskId)
        if (!latest || latest.state !== 'EXECUTING') break
        currentTask = latest
        const activeSubtask = currentTask.subtasks.find(
          (s: Subtask) => s.id === executingSubtaskId,
        )
        if (!activeSubtask || activeSubtask.state !== 'EXECUTING') break
        nextSubtask = activeSubtask

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
          typeof result.verification.evidence === 'string' &&
          result.verification.evidence.trim().length > 0

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
            currentTask.error = `Subtask "${nextSubtask.title}" failed after ${nextSubtask.maxRetries} retries: ${result.error || 'Verification unsatisfied'}`
            currentTask.updatedAt = Date.now()
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
        currentTask.error = `Subtask "${nextSubtask.title}" threw: ${nextSubtask.result.error}`
        currentTask.updatedAt = Date.now()
        await this.store.saveTask(currentTask)
        this.notifyStateChange(currentTask)
        break
      }
    }
  }

  private async verifyObjectiveCompletion(task: PersistentTask): Promise<{
    satisfied: boolean
    reason?: string
    evidence?: Record<string, unknown>
  }> {
    // 1. All subtasks must have valid passing verification evidence
    for (const sub of task.subtasks) {
      if (sub.state !== 'VERIFIED') {
        return {
          satisfied: false,
          reason: `Subtask "${sub.title}" is in state "${sub.state}", not VERIFIED.`,
        }
      }
      if (!sub.verification?.passed || !sub.verification?.evidence?.trim()) {
        return {
          satisfied: false,
          reason: `Subtask "${sub.title}" has no passing verification evidence.`,
        }
      }
    }

    const meta = (task.metadata || {}) as Record<string, unknown>
    let projectPath = typeof meta.projectPath === 'string' ? meta.projectPath : undefined
    if (!projectPath) {
      for (const sub of task.subtasks) {
        if (typeof sub.payload?.projectPath === 'string') {
          projectPath = sub.payload.projectPath
          break
        }
      }
    }

    // Collect declared required files
    const declaredFiles = new Set<string>()
    if (Array.isArray(meta.requiredFiles)) {
      for (const f of meta.requiredFiles) {
        if (typeof f === 'string' && f.trim()) declaredFiles.add(f.trim())
      }
    }
    for (const sub of task.subtasks) {
      if (Array.isArray(sub.payload?.expectedFiles)) {
        for (const f of sub.payload.expectedFiles) {
          if (typeof f === 'string' && f.trim()) declaredFiles.add(f.trim())
        }
      }
      if (typeof sub.payload?.filePath === 'string' && sub.payload.filePath.trim()) {
        declaredFiles.add(sub.payload.filePath.trim())
      }
    }

    const objText = String(task.objective ?? '')
    const demandsFileCreation =
      Boolean(meta.demandsFileCreation) ||
      /\b(create|write|make|generate|implement)\s+(?:a\s+)?(?:new\s+)?(?:[a-zA-Z]+\s+)?(?:file\s+)?(?:named\s+)?([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)/i.test(objText) ||
      /file\s+named\s+([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)/i.test(objText)

    if (demandsFileCreation && declaredFiles.size === 0) {
      return {
        satisfied: false,
        reason: 'Objective demanded file creation, but no required files were planned or created on disk.',
      }
    }

    const verifiedFilesEvidence: Array<{ path: string; bytes: number; exists: boolean }> = []
    if (declaredFiles.size > 0 && projectPath) {
      for (const file of declaredFiles) {
        let fullPath = file
        if (!/^[a-zA-Z]:[\\/]/.test(file)) {
          const sep = projectPath.includes('/') ? '/' : '\\'
          fullPath = `${projectPath.replace(/[\\/]+$/, '')}${sep}${file.replace(/^[\\/]+/, '')}`
        }

        let exists = false
        let bytes = 0
        let nodeChecked = false

        if (typeof process !== 'undefined' && process.versions?.node && typeof window === 'undefined') {
          try {
            const fsModule = 'node:fs'
            const fs = await import(/* @vite-ignore */ fsModule)
            nodeChecked = true
            exists = fs.existsSync(fullPath)
            if (exists) {
              bytes = fs.statSync(fullPath).size
            }
          } catch {
            nodeChecked = false
          }
        }

        if (nodeChecked) {
          if (!exists || bytes === 0) {
            return {
              satisfied: false,
              reason: `Required file on disk verification failed: "${file}" does not exist or is empty at ${fullPath}.`,
            }
          }
        } else {
          const normFile = file.replace(/\\/g, '/').toLowerCase().replace(/^\.?\//, '')
          const fileVerifiedInSubtask = task.subtasks.some((s) => {
            const dataSources = [
              s.observation?.data as Record<string, unknown> | undefined,
              s.result?.output as Record<string, unknown> | undefined,
            ]
            for (const obs of dataSources) {
              if (!obs) continue
              if (Array.isArray(obs?.expectedFiles)) {
                const matched = obs.expectedFiles.some((ef: any) => {
                  const normEf = String(ef.path ?? '').replace(/\\/g, '/').toLowerCase().replace(/^\.?\//, '')
                  return (normEf === normFile || normEf.endsWith('/' + normFile)) && ef.exists && ef.bytes > 0
                })
                if (matched) return true
              }
              if (obs?.filePath && obs?.verified === true) {
                const normFp = String(obs.filePath).replace(/\\/g, '/').toLowerCase().replace(/^\.?\//, '')
                if (normFp === normFile || normFp.endsWith('/' + normFile)) return true
              }
            }
            return false
          })
          if (!fileVerifiedInSubtask) {
            return {
              satisfied: false,
              reason: `Required file verification evidence missing for: "${file}".`,
            }
          }
          bytes = 1
          exists = true
        }

        verifiedFilesEvidence.push({ path: file, bytes, exists })
      }
    }

    const demandsExecution =
      Boolean(meta.demandsExecution) ||
      /\b(run|execute)\b.*\b(file|script|code|it|tests?)\b/i.test(objText)

    const executionSubtasks = task.subtasks.filter(
      (s) =>
        s.capability === 'dev.runTests' ||
        s.capability === 'runTests' ||
        s.capability === 'dev.test' ||
        s.capability === 'test' ||
        s.capability === 'dev.build' ||
        s.toolId === 'dev.runTests' ||
        s.toolId === 'dev.test' ||
        s.toolId === 'dev.build' ||
        s.capability?.includes('test') ||
        s.capability?.includes('execute') ||
        s.capability === 'run_project_tests',
    )

    if (demandsExecution && executionSubtasks.length === 0) {
      return {
        satisfied: false,
        reason: 'Objective demanded code execution, but no execution subtask was planned or run.',
      }
    }

    const executionEvidence: Array<{ command: string; exitCode: number; passed: boolean; stdoutSnippet?: string }> = []
    if (executionSubtasks.length > 0) {
      for (const sub of executionSubtasks) {
        const obsData = (sub.observation?.data ?? sub.result?.output ?? {}) as Record<string, unknown>
        const exitCode = typeof obsData.exitCode === 'number' ? obsData.exitCode : (sub.verification?.passed ? 0 : -1)
        const passed = (typeof obsData.exitCode === 'number' ? obsData.exitCode === 0 : sub.verification?.passed === true) && (obsData.passed !== false)
        const expectedMatched = obsData.expectedOutputMatched !== false

        executionEvidence.push({
          command: String(obsData.command ?? sub.title),
          exitCode,
          passed,
          stdoutSnippet: String(obsData.stdout ?? obsData.outputSnippet ?? '').slice(-500),
        })

        if (!passed) {
          return {
            satisfied: false,
            reason: `Execution subtask "${sub.title}" failed with exit code ${exitCode}.`,
          }
        }
        if (!expectedMatched) {
          return {
            satisfied: false,
            reason: `Execution subtask "${sub.title}" failed output verification: expected output did not match.`,
          }
        }
      }
    }

    const reportSubtask = task.subtasks.find(
      (s) => s.capability === 'dev.generateReport' || s.toolId === 'dev.generateReport',
    )
    if (reportSubtask) {
      const repData = (reportSubtask.observation?.data ?? reportSubtask.result?.output ?? {}) as Record<string, unknown>
      if (repData.verified !== true) {
        return {
          satisfied: false,
          reason: 'Execution report could not be verified on disk.',
        }
      }
      if (repData.requiredFilesVerified === false) {
        return {
          satisfied: false,
          reason: 'Execution report recorded required files verification failure.',
        }
      }
    }

    return {
      satisfied: true,
      evidence: {
        verifiedAt: Date.now(),
        projectPath,
        files: verifiedFilesEvidence,
        executions: executionEvidence,
      },
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
