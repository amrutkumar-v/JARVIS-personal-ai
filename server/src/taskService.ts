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
import {
  computeActionFingerprint,
  extractActionTarget,
  verifyApprovalForAction,
} from './tasks/approvalBinding.js'
import { DevEngine } from './dev/DevEngine.js'
import { DesktopEngine, verifyDesktopResult } from './desktop/DesktopEngine.js'
import { buildDevelopmentPlan, extractProjectPath } from './dev/DevelopmentPlanner.js'
import { childProcessRegistry } from './process/ChildProcessRegistry.js'
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

export interface ActionRiskClassification {
  category:
    | 'read_only'
    | 'file_creation'
    | 'file_modification'
    | 'file_deletion'
    | 'script_execution'
    | 'test_execution'
    | 'dependency_install'
    | 'system_modification'
    | 'git_operation'
    | 'network_operation'
    | 'browser_interaction'
    | 'desktop_control'
    | 'administrative'
    | 'unknown'
  sensitive: boolean
  impact: string
}

export function classifyActionRisk(action: string, subtask?: Subtask): ActionRiskClassification {
  const norm = (action || '').toLowerCase()

  if ((subtask as any)?.requiresPermission === true) {
    return { category: 'unknown', sensitive: true, impact: 'Subtask explicitly marked as requiring permission' }
  }

  if (
    norm.includes('delete') ||
    norm.includes('destroy') ||
    norm.includes('unlink') ||
    norm.includes('rmdir') ||
    norm.includes('remove') ||
    norm.includes('purge')
  ) {
    return { category: 'file_deletion', sensitive: true, impact: 'Permanently deletes files or directories' }
  }

  if (norm === 'dev.runscript' || norm.startsWith('shell.') || norm === 'system.exec' || norm === 'process.exec') {
    return { category: 'script_execution', sensitive: true, impact: 'Executes arbitrary shell scripts or system commands' }
  }

  if (norm === 'dev.runtests' || norm.includes('runtest')) {
    return { category: 'test_execution', sensitive: true, impact: 'Spawns child processes to run test suites' }
  }

  if (norm === 'dev.installdependencies' || norm.includes('install') || norm.includes('npm.install')) {
    return { category: 'dependency_install', sensitive: true, impact: 'Installs third-party packages or system dependencies' }
  }

  if (norm === 'dev.createfile') {
    return { category: 'file_creation', sensitive: true, impact: 'Creates new files on the filesystem' }
  }
  if (norm === 'dev.patchfile') {
    return { category: 'file_modification', sensitive: true, impact: 'Modifies existing source code or project files' }
  }

  if (norm.startsWith('desktop.click') || norm.startsWith('desktop.type') || norm.startsWith('desktop.key') || norm.startsWith('desktop.mouse')) {
    return { category: 'desktop_control', sensitive: true, impact: 'Injects mouse or keyboard input into desktop applications' }
  }

  if (norm.startsWith('system.registry') || norm.startsWith('system.service') || norm.startsWith('admin.')) {
    return { category: 'system_modification', sensitive: true, impact: 'Modifies system configuration or service settings' }
  }

  if (
    norm === 'dev.inspectproject' ||
    norm === 'dev.gitstatus' ||
    norm === 'dev.auditproject' ||
    norm === 'dev.generatereport' ||
    norm.startsWith('fs.read') ||
    norm.startsWith('window.list') ||
    norm.startsWith('desktop.screenshot') ||
    norm.startsWith('test.flakytool') ||
    norm === 'clock' ||
    norm === 'calculator'
  ) {
    return { category: 'read_only', sensitive: false, impact: 'Read-only inspection without persistent side effects' }
  }

  if (norm === 'dev.gitcheckpoint') {
    return { category: 'git_operation', sensitive: false, impact: 'Creates a safety backup git branch for recovery' }
  }

  if (norm.startsWith('browser.')) {
    const isSensitive = norm.includes('submit') || norm.includes('payment')
    return { category: 'browser_interaction', sensitive: isSensitive, impact: isSensitive ? 'Performs high-risk browser submission' : 'Standard browser navigation' }
  }

  return { category: 'unknown', sensitive: true, impact: `Unclassified action "${action}" requires explicit operator authorization under default-deny policy` }
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
  private readonly inFlightIdempotent = new Map<string, Promise<PersistentTask>>()
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
    // Direct dev.* execution via backend DevEngine. This runs BEFORE the
    // bundled AssistantEngine because the engine's browser-safe dev tools would
    // otherwise call back into this same HTTP endpoint.
    const action = subtask.toolId || subtask.capability

    // Check capability registration first: an unregistered capability must fail loudly
    const isDev =
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
    const isDesktopAction = Boolean(
      action?.startsWith('desktop.') ||
      action?.startsWith('browser.') ||
      action?.startsWith('window.')
    )
    const isAssistantTool = Boolean(this.engineInstance?.tools?.get(action) || this.engineInstance?.tools?.get(subtask.toolId))
    const isKnownAction = isDev || isDesktopAction || isAssistantTool || action === 'system.deleteFile'

    if (!isKnownAction) {
      return {
        success: false,
        error: `Capability or tool "${action}" is not registered in the backend task engine.`,
      }
    }

    // Default-deny approval gate (CRIT-02 & SEC-04): classify action risk
    const classification = classifyActionRisk(action, subtask)
    const isSensitive = classification.sensitive

    if (isSensitive) {
      // Server-enforced approval binding:
      // Verifies exact task ID, subtask ID, action, target, and argument payload via SHA-256 fingerprint.
      // Rejects missing, malformed, stale, expired, revoked, or consumed approvals.
      const target = extractActionTarget(subtask.payload)
      const verification = verifyApprovalForAction(task.requiredApprovals, {
        taskId: task.id,
        subtaskId: subtask.id,
        action,
        capability: subtask.capability,
        target,
        payload: subtask.payload,
      })

      if (!verification.valid || !verification.approval) {
        const fingerprint = computeActionFingerprint({
          taskId: task.id,
          subtaskId: subtask.id,
          action,
          capability: subtask.capability,
          target,
          payload: subtask.payload,
        })
        return {
          success: false,
          requiresPermission: {
            action: subtask.capability || action,
            description: subtask.title || `Permission required for ${subtask.capability || action}`,
            impact: classification.impact,
            toolId: action,
            taskId: task.id,
            subtaskId: subtask.id,
            target,
            payload: subtask.payload,
            fingerprint,
          },
        }
      }

      // Mark approval as consumed for this execution to prevent replay or duplicate dispatch
      verification.approval.consumed = true
      verification.approval.consumedAt = Date.now()
    }

    // Check system resources before heavy operations (bypassed in test runner environment)
    const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)
    if (!isTestEnv) {
      let resourceCheck = this.resourceMonitor.canExecuteTask()
      if (!resourceCheck.allowed) {
        // Wait briefly for transient CPU/memory spike to subside
        for (let attempt = 0; attempt < 5; attempt++) {
          await new Promise((r) => setTimeout(r, 400))
          resourceCheck = this.resourceMonitor.canExecuteTask()
          if (resourceCheck.allowed) break
        }
        if (!resourceCheck.allowed) {
          this.log.warn('taskService', `Resource constrained: ${resourceCheck.reason}. Retrying later.`)
          return {
            success: false,
            error: `Resource constrained: ${resourceCheck.reason}`,
          }
        }
      }
    }

    if (isDev) {
      const devEngine = new DevEngine()
      const payload = this.buildDevPayload(subtask, task, action)
      payload.taskId = task.id
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

    // Direct desktop.* / app.* / browser.* / web.* execution via backend DesktopEngine.
    const isDesktopOrBrowserAction =
      action?.startsWith('desktop.') ||
      action?.startsWith('window.') ||
      action?.startsWith('app.') ||
      action?.startsWith('browser.') ||
      action?.startsWith('web.') ||
      action?.startsWith('clipboard.') ||
      subtask.capability?.startsWith('desktop.') ||
      subtask.capability?.startsWith('browser') ||
      subtask.capability?.startsWith('web_') ||
      subtask.capability?.startsWith('clipboard') ||
      [
        'launch_app',
        'close_app',
        'focus_window',
        'minimize_window',
        'maximize_window',
        'restore_window',
        'desktop_screenshot',
        'list_windows',
        'calculate',
        'type_text',
        'browser_open',
        'browser_navigate',
        'browser_click',
        'browser_type',
        'browser_read_page',
        'browser_search',
        'browser_screenshot',
        'browser_close',
        'browser_back',
        'browser_forward',
        'browser_refresh',
        'web_search',
        'web_fetch',
        'web_download',
        'read_clipboard',
        'write_clipboard',
      ].includes(subtask.capability)

    if (isDesktopOrBrowserAction) {
      const desktopEngine = new DesktopEngine()
      const payload = subtask.payload || {}
      const res = await desktopEngine.execute(action, payload)
      const verification = verifyDesktopResult(action, res)
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
          const target = extractActionTarget(subtask.payload)
          const verification = verifyApprovalForAction(task.requiredApprovals, {
            taskId: task.id,
            subtaskId: subtask.id,
            action: tool.id,
            capability: subtask.capability || tool.id,
            target,
            payload: subtask.payload,
          })
          if (!verification.valid || !verification.approval) {
            const fingerprint = computeActionFingerprint({
              taskId: task.id,
              subtaskId: subtask.id,
              action: tool.id,
              capability: subtask.capability || tool.id,
              target,
              payload: subtask.payload,
            })
            return {
              success: false,
              requiresPermission: {
                action: `${tool.name} (${subtask.title})`,
                description: subtask.description,
                impact: tool.permission === 'high_risk' ? 'High risk action' : 'Requires user confirmation',
                toolId: tool.id,
                taskId: task.id,
                subtaskId: subtask.id,
                target,
                payload: subtask.payload,
                fingerprint,
              },
            }
          }
          verification.approval.consumed = true
          verification.approval.consumedAt = Date.now()
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

    if (action !== 'dev.generateReport' && action !== 'generateReport') {
      if ((action === 'dev.runTests' || action === 'runTests') && !payload.expectedOutput && metadata.expectedOutput) {
        payload.expectedOutput = metadata.expectedOutput
      }
      return payload
    }

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
    if (payload.demandsFileCreation === undefined && metadata.demandsFileCreation !== undefined) {
      payload.demandsFileCreation = metadata.demandsFileCreation
    }
    if (payload.demandsExecution === undefined && metadata.demandsExecution !== undefined) {
      payload.demandsExecution = metadata.demandsExecution
    }
    if (!payload.expectedOutput && metadata.expectedOutput) {
      payload.expectedOutput = metadata.expectedOutput
    }

    return payload
  }

  private handleTaskStateChange(task: PersistentTask): void {
    // 1. Broadcast over SSE EventBus so live UI mirrors update immediately
    this.bus.publish({
      type: 'task',
      at: Date.now(),
      data: task,
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
    projectPath?: string
    idempotencyKey?: string
    metadata?: Record<string, unknown>
  }): Promise<PersistentTask> {
    const rawMeta = { ...(params.metadata || {}) }
    // CRIT-02: Protect server-owned authorization metadata from client pollution
    const PROTECTED_METADATA_KEYS = new Set([
      'autoApprove',
      'authorizedScopes',
      'requiredApprovals',
      'isAuthorized',
      'grantedApprovals',
      'bypassedApprovals',
      'permissions',
      'fingerprint',
    ])
    const meta: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rawMeta)) {
      if (!PROTECTED_METADATA_KEYS.has(k) && !k.startsWith('__proto__') && k !== 'constructor' && k !== 'prototype') {
        meta[k] = v
      }
    }
    if (params.projectPath) meta.projectPath = params.projectPath
    if (params.idempotencyKey) {
      const inFlight = this.inFlightIdempotent.get(params.idempotencyKey)
      if (inFlight) {
        return inFlight
      }
      meta.idempotencyKey = params.idempotencyKey
    }

    const execPromise = (async () => {
      if (params.idempotencyKey) {
        const existing = (await this.store.listTasks()).find(
          (t) => (t.metadata as Record<string, unknown>)?.idempotencyKey === params.idempotencyKey,
        )
        if (existing) {
          return existing
        }
      }

      let subtasks = params.subtasks
      let title = params.title
      if ((!subtasks || subtasks.length === 0) && (params.projectPath || extractProjectPath(params.objective))) {
        const projPath = params.projectPath || extractProjectPath(params.objective)!
        try {
          const plan = buildDevelopmentPlan(params.objective, projPath)
          subtasks = plan.subtasks
          meta.developmentPlan = true
          meta.projectPath = projPath
          meta.requiredFiles = plan.requiredFiles
          meta.demandsFileCreation = plan.demandsFileCreation
          meta.demandsExecution = plan.demandsExecution
          meta.expectedOutput = plan.expectedOutput
          if (!params.title || params.title === params.objective.slice(0, 80)) {
            title = `Autonomous Task: ${plan.projectName || 'Project Development'}`
          }
        } catch {
          // Fall back to provided subtasks
        }
      }

      const task = await this.orchestrator.createTask({
        title,
        objective: params.objective,
        priority: params.priority,
        subtasks,
        tags: params.tags,
        metadata: meta,
      })
      await this.orchestrator.queueTask(task.id)
      return (await this.getTask(task.id)) ?? task
    })()

    if (params.idempotencyKey) {
      this.inFlightIdempotent.set(params.idempotencyKey, execPromise)
      try {
        return await execPromise
      } finally {
        this.inFlightIdempotent.delete(params.idempotencyKey)
      }
    }

    return await execPromise
  }

  async getTask(taskId: string): Promise<PersistentTask | null> {
    return this.store.getTask(taskId)
  }

  async listTasks(filter?: TaskFilter): Promise<PersistentTask[]> {
    return this.store.listTasks(filter)
  }

  async pauseTask(taskId: string): Promise<boolean> {
    await childProcessRegistry.killProcessTree(taskId)
    return this.orchestrator.pauseTask(taskId)
  }

  async resumeTask(taskId: string): Promise<boolean> {
    return this.orchestrator.resumeTask(taskId)
  }

  async cancelTask(taskId: string, reason?: string): Promise<boolean> {
    await childProcessRegistry.killProcessTree(taskId)
    try {
      const task = await this.orchestrator.getTask(taskId)
      if (task && (task.tags?.includes('browser') || task.subtasks.some((s) => s.capability?.startsWith('browser')))) {
        const desktopEngine = new DesktopEngine()
        await desktopEngine.execute('browser.close', {})
      }
    } catch {
      // Non-fatal
    }
    return this.orchestrator.cancelTask(taskId, reason)
  }

  async approveAction(taskId: string, approvalId: string): Promise<boolean> {
    return this.orchestrator.approveAction(taskId, approvalId)
  }

  async rejectAction(taskId: string, approvalId: string, reason?: string): Promise<boolean> {
    return this.orchestrator.rejectAction(taskId, approvalId, reason)
  }

  async revokeAction(taskId: string, approvalId: string, reason?: string): Promise<boolean> {
    return this.orchestrator.revokeAction(taskId, approvalId, reason)
  }

  getOrchestrator(): PersistentTaskOrchestrator {
    return this.orchestrator
  }

  stop(): void {
    this.orchestrator.stop()
  }
}
