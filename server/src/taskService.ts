/**
 * Backend Task Service (Phase C Background Execution).
 *
 * Runs persistent tasks headlessly in the persistent background backend.
 * Features:
 * - Durable task queue using FileTaskStorage (server/data/tasks).
 * - Automatic startup recovery for tasks interrupted by PC or app restarts.
 * - Resource monitoring (throttling when CPU/RAM is constrained).
 * - SSE event broadcasting over EventBus.
 * - Windows native balloon/toast notifications.
 * - AssistantEngine as the single execution authority.
 */

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { EventBus } from './events.js'
import type { Logger } from './log.js'
import { ResourceMonitor } from './resourceMonitor.js'
import { sendWindowsNotification } from './notify.js'
import {
  FileTaskStorage,
  MemoryTaskStorage,
  TaskStore,
} from './tasks/TaskStore.js'
import {
  PersistentTaskOrchestrator,
} from './tasks/PersistentTaskOrchestrator.js'
import { DevEngine } from './dev/DevEngine.js'
import type {
  PersistentTask,
  Subtask,
  TaskFilter,
} from './tasks/types.js'

export interface TaskServiceOptions {
  dataDir: string
  bus: EventBus
  log: Logger
  useMemoryStorage?: boolean
}

/**
 * Confirm a dev.* result against the evidence the backend actually produced.
 * `ok: true` alone is never sufficient for a verified subtask.
 */
function verifyDevResult(
  action: string,
  res: { ok: boolean; message: string; data?: unknown; error?: string },
): { passed: boolean; evidence: string } {
  const data = (res.data ?? {}) as Record<string, unknown>
  let passed = res.ok

  switch (action) {
    case 'dev.inspectProject':
    case 'inspectProject':
      passed = res.ok && typeof data.path === 'string' && data.verified !== false
      break
    case 'dev.gitStatus':
    case 'gitStatus':
      passed = res.ok && typeof data.branch !== 'undefined'
      break
    case 'dev.gitCheckpoint':
    case 'gitCheckpoint':
      passed =
        res.ok &&
        typeof data.checkpointBranch === 'string' &&
        data.checkpointBranch.length > 0 &&
        data.verified === true
      break
    case 'dev.patchFile':
    case 'patchFile':
      passed = res.ok && data.verified === true
      break
    case 'dev.runTests':
    case 'runTests':
      passed = res.ok && data.passed === true && data.exitCode === 0
      break
    case 'dev.auditProject':
    case 'auditProject':
      passed = res.ok && data.passed === true
      break
    case 'dev.generateReport':
    case 'generateReport':
      passed = res.ok && data.verified === true && typeof data.report === 'string'
      break
    default:
      passed = res.ok
      break
  }

  return {
    passed,
    evidence: passed ? res.message : res.message || 'Verification failed',
  }
}

export class TaskService {
  private readonly store: TaskStore
  private readonly orchestrator: PersistentTaskOrchestrator
  private readonly resourceMonitor: ResourceMonitor
  private readonly bus: EventBus
  private readonly log: Logger
  private engineInstance: any = null

  constructor(opts: TaskServiceOptions) {
    this.bus = opts.bus
    this.log = opts.log
    this.resourceMonitor = new ResourceMonitor()

    const storage = opts.useMemoryStorage
      ? new MemoryTaskStorage()
      : new FileTaskStorage(join(opts.dataDir, 'tasks'))

    this.store = new TaskStore(storage)
    this.orchestrator = new PersistentTaskOrchestrator({
      store: this.store,
      onTaskStateChange: (task) => this.handleTaskStateChange(task),
    })

    this.orchestrator.setExecutor(async (subtask, task) => {
      return this.executeSubtask(subtask, task)
    })
  }

  async init(): Promise<void> {
    // 1. Initialize engine
    await this.initEngine()

    // 2. Recover any tasks interrupted by PC shutdown/restart
    try {
      const recovered = await this.orchestrator.recoverUnfinishedTasks()
      if (recovered.length > 0) {
        this.log.info('taskService', `Recovered ${recovered.length} interrupted task(s) from disk checkpoints`, {
          taskIds: recovered.map((t) => t.id),
        })
      }
    } catch (err) {
      this.log.error('taskService', 'Failed to recover interrupted tasks', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // 3. Start background runner loop
    this.orchestrator.start(1000)
    this.log.info('taskService', 'Persistent task service initialized and running in background')
  }

  private async initEngine(): Promise<void> {
    const engineBundlePath = join(process.cwd(), 'server', 'dist', 'engine.mjs')
    if (existsSync(engineBundlePath)) {
      try {
        // Windows absolute paths must be converted to a file:// URL before
        // dynamic import; otherwise Node parses "D:" as a URL protocol.
        const mod = await import(pathToFileURL(engineBundlePath).href)
        if (typeof mod.AssistantEngine === 'function') {
          this.engineInstance = new mod.AssistantEngine()
          this.log.info('taskService', 'Headless AssistantEngine loaded for background execution')
        }
      } catch (err) {
        this.log.warn('taskService', 'Could not load bundled AssistantEngine, using direct executor', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  private async executeSubtask(
    subtask: Subtask,
    task: PersistentTask,
  ) {
    // Check system resources before heavy operations
    const resourceCheck = this.resourceMonitor.canExecuteTask()
    if (!resourceCheck.allowed) {
      this.log.warn('taskService', `Resource constrained: ${resourceCheck.reason}. Retrying later.`)
      return {
        success: false,
        error: `Resource constrained: ${resourceCheck.reason}`,
      }
    }

    // Direct dev.* execution via backend DevEngine. This runs BEFORE the
    // bundled AssistantEngine because the engine's browser-safe dev tools would
    // otherwise call back into this same HTTP endpoint.
    const action = subtask.toolId || subtask.capability
    const isDevAction =
      action?.startsWith('dev.') ||
      subtask.capability?.startsWith('dev.') ||
      [
        'inspect_project',
        'git_status',
        'git_checkpoint',
        'patch_file',
        'run_project_tests',
        'audit_project',
        'generate_project_report',
      ].includes(subtask.capability)

    if (isDevAction) {
      const devEngine = new DevEngine()
      const payload = this.buildDevPayload(subtask, task, action)
      const res = await devEngine.execute(action, payload)
      const verification = verifyDevResult(action, res)
      return {
        success: res.ok && verification.passed,
        output: res.data,
        error: res.ok && verification.passed ? undefined : res.message,
        observation: {
          kind: action,
          summary: res.message,
          data: res.data,
        },
        verification: {
          passed: verification.passed,
          evidence: res.message,
        },
      }
    }

    // Execute through AssistantEngine if available
    if (this.engineInstance) {
      const tool = this.engineInstance.tools?.get(subtask.toolId)
      if (tool) {
        // Permission check
        if (tool.permission === 'high_risk' || tool.permission === 'user_confirmation') {
          const approved = task.requiredApprovals.find(
            (a) => a.toolId === tool.id && a.granted === true,
          )
          if (!approved) {
            return {
              success: false,
              requiresPermission: {
                action: `${tool.name} (${subtask.title})`,
                description: subtask.description,
                impact: tool.permission === 'high_risk' ? 'High risk action' : 'Requires user confirmation',
                toolId: tool.id,
                payload: subtask.payload,
              },
            }
          }
        }

        try {
          const ctx = {
            requestId: subtask.id,
          }
          const toolInput = {
            query: subtask.title,
            params: subtask.payload || {},
          }
          const result = await tool.execute(toolInput, ctx)
          let verificationPassed = result.ok
          let evidence = result.message || 'Execution completed'

          if (tool.verifiable && typeof tool.verify === 'function') {
            const v = await tool.verify(toolInput, result, ctx)
            verificationPassed = v.ok
            evidence = v.message || evidence
          }

          return {
            success: result.ok && verificationPassed,
            output: result.data,
            error: result.ok && verificationPassed ? undefined : result.message,
            observation: {
              kind: tool.id,
              summary: result.message,
              data: result.data,
            },
            verification: {
              passed: verificationPassed,
              evidence,
            },
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }
    }

    // No real executor exists for this capability. Never fabricate success:
    // an unregistered tool must fail the subtask so the orchestrator can
    // recover or surface the gap to the user.
    return {
      success: false,
      error: `Capability "${subtask.capability}" is not registered with the backend executor; no action was taken.`,
    }
  }

  /**
   * Build the payload for a dev.* action, attaching observed evidence to the
   * final report step. Evidence comes only from already executed subtasks.
   */
  private buildDevPayload(
    subtask: Subtask,
    task: PersistentTask,
    action: string,
  ): Record<string, unknown> {
    const payload = { ...(subtask.payload || {}) }
    const metadata = (task.metadata || {}) as Record<string, unknown>
    if (typeof payload.projectPath !== 'string' && typeof metadata.projectPath === 'string') {
      payload.projectPath = metadata.projectPath
    }

    if (action !== 'dev.generateReport' && action !== 'generateReport') return payload

    const outputs = task.subtasks
      .filter((s) => s.result?.output !== undefined)
      .map((s) => ({
        capability: s.capability,
        toolId: s.toolId,
        output: s.result?.output as Record<string, unknown>,
      }))

    const testOutput = [...outputs]
      .reverse()
      .find((o) => o.capability === 'dev.runTests' || o.toolId === 'dev.runTests')?.output
    const checkpointOutput = [...outputs]
      .reverse()
      .find((o) => o.capability === 'dev.gitCheckpoint' || o.toolId === 'dev.gitCheckpoint')?.output
    const fileChanges = outputs
      .filter((o) => o.capability === 'dev.patchFile' || o.toolId === 'dev.patchFile')
      .map((o) => o.output)

    payload.evidence = {
      ...(payload.evidence && typeof payload.evidence === 'object'
        ? (payload.evidence as Record<string, unknown>)
        : {}),
      testResults: testOutput,
      checkpoint: checkpointOutput,
      fileChanges,
    }

    if (!Array.isArray(payload.requiredFiles) && Array.isArray(metadata.requiredFiles)) {
      payload.requiredFiles = metadata.requiredFiles
    }

    return payload
  }

  private handleTaskStateChange(task: PersistentTask): void {
    // 1. Broadcast over SSE EventBus so live UI mirrors update immediately
    this.bus.publish({
      type: 'task',
      at: Date.now(),
      data: {
        event: 'state_changed',
        taskId: task.id,
        state: task.state,
        title: task.title,
        priority: task.priority,
        updatedAt: task.updatedAt,
        checkpointsCount: task.checkpoints.length,
        subtasksTotal: task.subtasks.length,
        subtasksVerified: task.subtasks.filter((s) => s.state === 'VERIFIED').length,
        currentSubtaskId: task.currentSubtaskId,
        pendingApprovals: task.requiredApprovals.filter((a) => a.granted === undefined),
      },
    })

    // 2. Trigger native Windows notifications for significant events
    if (task.state === 'COMPLETED') {
      sendWindowsNotification({
        title: 'JARVIS Task Completed',
        message: `${task.title} has completed successfully.`,
        level: 'info',
      })
    } else if (task.state === 'FAILED') {
      sendWindowsNotification({
        title: 'JARVIS Task Failed',
        message: `${task.title} failed: ${task.error || 'Unknown error'}`,
        level: 'error',
      })
    } else if (task.state === 'WAITING_FOR_PERMISSION') {
      sendWindowsNotification({
        title: 'JARVIS Approval Required',
        message: `Task "${task.title}" requires permission to proceed with a restricted action.`,
        level: 'security',
      })
    }
  }

  // --- Public API for HTTP endpoints ---

  async createTask(params: {
    title: string
    objective: string
    priority?: number
    subtasks?: any[]
    tags?: string[]
  }): Promise<PersistentTask> {
    const task = await this.orchestrator.createTask(params)
    await this.orchestrator.queueTask(task.id)
    return (await this.getTask(task.id)) ?? task
  }

  async getTask(taskId: string): Promise<PersistentTask | null> {
    return this.store.getTask(taskId)
  }

  async listTasks(filter?: TaskFilter): Promise<PersistentTask[]> {
    return this.store.listTasks(filter)
  }

  async pauseTask(taskId: string): Promise<boolean> {
    return this.orchestrator.pauseTask(taskId)
  }

  async resumeTask(taskId: string): Promise<boolean> {
    return this.orchestrator.resumeTask(taskId)
  }

  async cancelTask(taskId: string, reason?: string): Promise<boolean> {
    return this.orchestrator.cancelTask(taskId, reason)
  }

  async approveAction(taskId: string, approvalId: string): Promise<boolean> {
    return this.orchestrator.approveAction(taskId, approvalId)
  }

  async rejectAction(taskId: string, approvalId: string, reason?: string): Promise<boolean> {
    return this.orchestrator.rejectAction(taskId, approvalId, reason)
  }

  stop(): void {
    this.orchestrator.stop()
  }
}
