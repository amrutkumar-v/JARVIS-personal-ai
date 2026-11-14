/**
 * Regression coverage for backend-owned autonomous task execution.
 *
 * These tests pin the properties the HUD must be able to trust:
 *  - AssistantEngine planning is available inside the backend process;
 *  - duplicate submissions are idempotent / deduped while active;
 *  - SSE carries the FULL task (subtasks + evidence), not a summary;
 *  - only evidence-backed subtasks can make a task COMPLETED;
 *  - restart recovery never promotes a checkpoint id to VERIFIED;
 *  - pausing an in-flight executor cannot duplicate work or be overwritten.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus } from '../../server/src/events.js'
import { nullLogger } from '../../server/src/log.js'
import { TaskService } from '../../server/src/taskService.js'
import { PersistentTaskOrchestrator } from '../../server/src/tasks/PersistentTaskOrchestrator.js'
import { MemoryTaskStorage } from '../../server/src/tasks/TaskStore.js'
import type { PersistentTask, Subtask } from '../../server/src/tasks/types.js'

function craftedTask(overrides: Partial<PersistentTask>): PersistentTask {
  const now = Date.now()
  const taskId = overrides.id ?? `task-crafted-${now}`
  const subtasks: Subtask[] = overrides.subtasks ?? []
  return {
    id: taskId,
    title: 'Crafted task',
    objective: 'Crafted objective',
    priority: 50,
    state: 'EXECUTING',
    createdAt: now - 1_000,
    updatedAt: now - 500,
    startedAt: now - 900,
    lastHeartbeatAt: now - 500,
    subtasks,
    checkpoints: [],
    requiredApprovals: [],
    logs: [],
    recoveryCount: 0,
    maxRecoveries: 3,
    tags: [],
    metadata: {},
    ...overrides,
  }
}

function subtask(overrides: Partial<Subtask> & Pick<Subtask, 'id' | 'taskId'>): Subtask {
  return {
    stepIndex: 0,
    title: overrides.id,
    description: overrides.id,
    capability: overrides.capability ?? 'test.capability',
    toolId: overrides.toolId ?? 'test.capability',
    payload: {},
    priority: 50,
    dependencies: [],
    state: 'PENDING',
    retries: 0,
    maxRetries: 2,
    ...overrides,
  }
}

describe('Backend-owned autonomous task execution', () => {
  let scratch: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'jarvis-backend-task-'))
  })

  afterEach(() => {
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      // Ignore Windows file locks from an unfinished child process.
    }
  })

  it('plans an objective inside the backend and persists the AssistantEngine DAG', async () => {
    const service = new TaskService({
      dataDir: join(scratch, 'data'),
      bus: new EventBus(),
      log: nullLogger(),
      useMemoryStorage: true,
    })
    await service.init()
    service.stop()

    const task = await service.createTask({
      objective:
        'Create a simple Python program that calculates the area of a circle. Create an appropriate test file, execute the tests, verify the results, and generate a completion report.',
      projectPath: join(scratch, 'circle'),
    })

    expect(task.subtasks).toHaveLength(8)
    expect(task.subtasks.map((s) => s.toolId)).toEqual([
      'dev.inspectProject',
      'dev.gitStatus',
      'dev.gitCheckpoint',
      'dev.patchFile',
      'dev.patchFile',
      'dev.runTests',
      'dev.inspectProject',
      'dev.generateReport',
    ])
    expect(task.metadata.projectPath).toBe(join(scratch, 'circle'))
    expect(task.metadata.developmentPlan).toBe(true)
    expect(task.state).toBe('QUEUED')
  })

  it('returns the original task for a repeated idempotency key', async () => {
    const service = new TaskService({
      dataDir: join(scratch, 'data'),
      bus: new EventBus(),
      log: nullLogger(),
      useMemoryStorage: true,
    })
    await service.init()
    service.stop()

    const request = {
      objective: 'Idempotent explicit task',
      projectPath: scratch,
      idempotencyKey: 'key-123',
      subtasks: [
        {
          title: 'Inspect',
          capability: 'dev.inspectProject',
          payload: { projectPath: scratch },
          dependencies: [],
        },
      ],
    }

    const first = await service.createTask(request)
    const second = await service.createTask(request)
    expect(second.id).toBe(first.id)
    expect(await service.listTasks()).toHaveLength(1)
  })

  it('serializes concurrent identical submissions with the same idempotency key', async () => {
    const service = new TaskService({
      dataDir: join(scratch, 'concurrent-data'),
      bus: new EventBus(),
      log: nullLogger(),
      useMemoryStorage: true,
    })
    await service.init()
    // Stop the execution loop: this test isolates the submission transaction.
    service.stop()

    const request = {
      objective: 'Concurrent idempotent task',
      projectPath: scratch,
      idempotencyKey: 'concurrent-key-1',
      subtasks: [
        {
          title: 'Inspect',
          capability: 'dev.inspectProject',
          payload: { projectPath: scratch },
          dependencies: [],
        },
      ],
    }

    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.createTask(request)),
    )
    const ids = new Set(results.map((task) => task.id))
    expect(ids.size).toBe(1)
    expect(await service.listTasks()).toHaveLength(1)
  })

  it('does not dedupe a completed run, so an operator may ask again', async () => {
    const service = new TaskService({
      dataDir: join(scratch, 'data'),
      bus: new EventBus(),
      log: nullLogger(),
      useMemoryStorage: true,
    })
    await service.init()
    service.stop()

    const first = await service.createTask({
      objective: 'Repeatable explicit task',
      projectPath: scratch,
      subtasks: [
        {
          title: 'Inspect',
          capability: 'dev.inspectProject',
          payload: { projectPath: scratch },
          dependencies: [],
        },
      ],
    })
    await service.cancelTask(first.id)
    const second = await service.createTask({
      objective: 'Repeatable explicit task',
      projectPath: scratch,
      subtasks: [
        {
          title: 'Inspect',
          capability: 'dev.inspectProject',
          payload: { projectPath: scratch },
          dependencies: [],
        },
      ],
    })
    expect(second.id).not.toBe(first.id)
  })

  it('publishes the full task over SSE so the HUD keeps subtasks and evidence', async () => {
    const bus = new EventBus()
    const service = new TaskService({
      dataDir: join(scratch, 'data'),
      bus,
      log: nullLogger(),
      useMemoryStorage: true,
    })
    await service.init()
    service.stop()

    const events: PersistentTask[] = []
    bus.subscribe({
      id: 'test-sse',
      send: (type, data) => {
        if (type === 'task') events.push(data as PersistentTask)
      },
    })

    const task = await service.createTask({
      objective: 'SSE payload task',
      projectPath: scratch,
      subtasks: [
        {
          title: 'Inspect',
          capability: 'dev.inspectProject',
          payload: { projectPath: scratch },
          dependencies: [],
        },
      ],
    })

    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]
    expect(last.id).toBe(task.id)
    expect(Array.isArray(last.subtasks)).toBe(true)
    expect(last.subtasks[0].id).toBe(task.subtasks[0].id)
  })

  it('default-denies a sensitive backend capability until an approval is recorded', async () => {
    const service = new TaskService({
      dataDir: join(scratch, 'data'),
      bus: new EventBus(),
      log: nullLogger(),
      useMemoryStorage: true,
    })
    await service.init()

    const projectPath = join(scratch, 'sensitive')
    mkdirSync(projectPath, { recursive: true })
    const task = await service.createTask({
      title: 'Sensitive backend action',
      objective: 'Write a file under a sensitive capability',
      projectPath,
      subtasks: [
        {
          title: 'Sensitive write',
          capability: 'dev.patchFile.deleteProbe',
          toolId: 'dev.patchFile',
          payload: {
            projectPath,
            filePath: 'approved.txt',
            createIfMissing: true,
            target: '',
            replacement: 'approved only after explicit consent\n',
          },
          dependencies: [],
        },
      ],
    })

    let pending = await service.getTask(task.id)
    const deadline = Date.now() + 5_000
    while (pending?.state !== 'WAITING_FOR_PERMISSION' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      pending = await service.getTask(task.id)
    }

    expect(pending?.state).toBe('WAITING_FOR_PERMISSION')
    expect(existsSync(join(projectPath, 'approved.txt'))).toBe(false)
    const approval = pending!.requiredApprovals.find((a) => a.granted === undefined)
    expect(approval).toBeDefined()

    expect(await service.approveAction(task.id, approval!.id)).toBe(true)
    const after = Date.now() + 5_000
    let final = await service.getTask(task.id)
    while (final?.state !== 'COMPLETED' && Date.now() < after) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      final = await service.getTask(task.id)
    }
    expect(final?.state).toBe('COMPLETED')
    expect(final!.subtasks[0].verification?.passed).toBe(true)
    expect(existsSync(join(projectPath, 'approved.txt'))).toBe(true)
    service.stop()
  }, 20_000)

  it('persists a pending approval across a task-service restart', async () => {
    const dataDir = join(scratch, 'restart-data')
    const projectPath = join(scratch, 'restart-sensitive')
    mkdirSync(projectPath, { recursive: true })
    const first = new TaskService({
      dataDir,
      bus: new EventBus(),
      log: nullLogger(),
    })
    await first.init()
    const task = await first.createTask({
      title: 'Approval restart probe',
      objective: 'Hold a sensitive action across restart',
      projectPath,
      subtasks: [
        {
          title: 'Sensitive write after restart',
          capability: 'dev.patchFile.deleteProbe',
          toolId: 'dev.patchFile',
          payload: {
            projectPath,
            filePath: 'after-restart.txt',
            createIfMissing: true,
            target: '',
            replacement: 'written after approval\n',
          },
          dependencies: [],
        },
      ],
    })
    let pending = await first.getTask(task.id)
    const deadline = Date.now() + 5_000
    while (pending?.state !== 'WAITING_FOR_PERMISSION' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      pending = await first.getTask(task.id)
    }
    expect(pending?.state).toBe('WAITING_FOR_PERMISSION')
    const approval = pending!.requiredApprovals.find((a) => a.granted === undefined)
    expect(approval).toBeDefined()
    first.stop()

    const second = new TaskService({
      dataDir,
      bus: new EventBus(),
      log: nullLogger(),
    })
    await second.init()
    const reopened = await second.getTask(task.id)
    expect(reopened?.state).toBe('WAITING_FOR_PERMISSION')
    const reopenedApproval = reopened!.requiredApprovals.find((a) => a.id === approval!.id)
    expect(reopenedApproval?.granted).toBeUndefined()
    expect(existsSync(join(projectPath, 'after-restart.txt'))).toBe(false)

    expect(await second.approveAction(task.id, approval!.id)).toBe(true)
    const after = Date.now() + 5_000
    let final = await second.getTask(task.id)
    while (final?.state !== 'COMPLETED' && Date.now() < after) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      final = await second.getTask(task.id)
    }
    expect(final?.state).toBe('COMPLETED')
    expect(existsSync(join(projectPath, 'after-restart.txt'))).toBe(true)
    second.stop()
  }, 30_000)

  it('records a concrete error when exhausted retries require recovery', async () => {
    const storage = new MemoryTaskStorage()
    const orchestrator = new PersistentTaskOrchestrator({
      storage,
      executor: async () => ({ success: false, error: 'deterministic executor failure' }),
    })
    const task = await orchestrator.createTask({
      title: 'Retry exhaustion',
      objective: 'Surface the real failure reason',
      subtasks: [
        {
          title: 'Always fails',
          description: 'Always fails',
          capability: 'test.fail',
          toolId: 'test.fail',
          dependencies: [],
          maxRetries: 0,
        },
      ],
    })
    await orchestrator.queueTask(task.id)
    await orchestrator.tick()

    const final = await orchestrator.getTask(task.id)
    expect(final!.state).toBe('RECOVERY_REQUIRED')
    expect(final!.error).toContain('deterministic executor failure')
    expect(final!.subtasks[0].state).toBe('FAILED')
  })

  it('refuses COMPLETED when a VERIFIED label has no evidence', async () => {
    const storage = new MemoryTaskStorage()
    const orchestrator = new PersistentTaskOrchestrator({ storage })
    const now = Date.now()
    const task = craftedTask({
      id: 'task-unproven',
      state: 'QUEUED',
      subtasks: [
        subtask({
          id: 'sub-unproven',
          taskId: 'task-unproven',
          state: 'VERIFIED',
          completedAt: now,
          // Deliberately no verification record.
        }),
      ],
    })
    await storage.save(task)

    await orchestrator.tick()
    const final = await orchestrator.getTask(task.id)
    expect(final).not.toBeNull()
    expect(final!.state).not.toBe('COMPLETED')
    expect(final!.state).toBe('FAILED')
    expect(final!.error).toContain('no passing verification evidence')
  })

  it('does not restore VERIFIED from a checkpoint id during restart recovery', async () => {
    const storage = new MemoryTaskStorage()
    const orchestrator = new PersistentTaskOrchestrator({ storage })
    const task = craftedTask({
      id: 'task-no-evidence-recovery',
      state: 'EXECUTING',
      subtasks: [
        subtask({ id: 'sub-1', taskId: 'task-no-evidence-recovery', state: 'VERIFIED' }),
        subtask({
          id: 'sub-2',
          taskId: 'task-no-evidence-recovery',
          stepIndex: 1,
          state: 'EXECUTING',
          dependencies: ['sub-1'],
        }),
      ],
      checkpoints: [
        {
          checkpointId: 'cp-1',
          taskId: 'task-no-evidence-recovery',
          timestamp: Date.now() - 1000,
          state: 'EXECUTING',
          subtaskIndex: 0,
          completedSubtaskIds: ['sub-1'],
          verifiedArtifacts: { 'sub-1': { ok: true } },
          summary: 'checkpoint without evidence',
          executionStateHash: 'hash-1',
        },
      ],
    })
    await storage.save(task)

    const recovered = await orchestrator.recoverUnfinishedTasks()
    expect(recovered).toHaveLength(1)
    const recoveredTask = await orchestrator.getTask(task.id)
    expect(recoveredTask!.subtasks[0].state).not.toBe('VERIFIED')
    expect(recoveredTask!.subtasks[0].state).toBe('READY')
    expect(recoveredTask!.subtasks[1].state).toBe('PENDING')
    expect(recoveredTask!.state).toBe('QUEUED')
  })

  it('pausing an in-flight executor neither duplicates work nor overwrites PAUSED', async () => {
    const storage = new MemoryTaskStorage()
    let executions = 0
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const orchestrator = new PersistentTaskOrchestrator({
      storage,
      executor: async () => {
        executions += 1
        await gate
        return {
          success: true,
          output: { ok: true },
          observation: { kind: 'test', summary: 'done' },
          verification: { passed: true, evidence: 'executor produced real evidence' },
        }
      },
    })

    const task = await orchestrator.createTask({
      title: 'Pause race',
      objective: 'Pause while the executor is in flight',
      subtasks: [
        {
          title: 'Slow step',
          description: 'Slow step',
          capability: 'test.slow',
          toolId: 'test.slow',
          dependencies: [],
        },
      ],
    })
    await orchestrator.queueTask(task.id)

    const running = orchestrator.tick()
    const deadline = Date.now() + 2_000
    while (executions === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(executions).toBe(1)

    expect(await orchestrator.pauseTask(task.id)).toBe(true)
    release!()
    await running

    const paused = await orchestrator.getTask(task.id)
    expect(paused!.state).toBe('PAUSED')
    expect(paused!.subtasks[0].state).toBe('PENDING')
    expect(paused!.subtasks[0].verification).toBeUndefined()

    // The paused task must not be picked up again until explicitly resumed.
    await orchestrator.tick()
    expect(executions).toBe(1)
    expect((await orchestrator.getTask(task.id))!.state).toBe('PAUSED')
  })
})

