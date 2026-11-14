import { describe, expect, it, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import { execSync } from 'node:child_process'
import { ChildProcessRegistry } from '../../server/src/process/ChildProcessRegistry'
import { PersistentTaskOrchestrator } from '../../server/src/tasks/PersistentTaskOrchestrator'
import { MemoryTaskStorage, TaskStore } from '../../server/src/tasks/TaskStore'
import { TaskService } from '../../server/src/taskService'
import { EventBus } from '../../server/src/events'
import { createLogger } from '../../server/src/log'
import type { PersistentTask, Subtask } from '../../server/src/tasks/types'

describe('Gate G10: Recovery, Process Isolation & Long-Run Autonomy', () => {
  let registry: ChildProcessRegistry
  let store: TaskStore
  let orchestrator: PersistentTaskOrchestrator

  beforeEach(() => {
    registry = new ChildProcessRegistry()
    store = new TaskStore(new MemoryTaskStorage())
    orchestrator = new PersistentTaskOrchestrator({ store })
  })

  it('guarantees child process tree termination on Windows (taskkill /F /T)', async () => {
    // Spawn a long-running Node subprocess simulating a background dev server or worker
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      windowsHide: true,
      stdio: 'ignore',
    })

    const pid = child.pid
    expect(pid).toBeDefined()
    expect(pid).toBeGreaterThan(0)

    // Register with ChildProcessRegistry under a synthetic taskId
    const taskId = 'task-proc-test-1'
    registry.register(taskId, child, 'Simulated background worker')

    const activeBefore = registry.getActiveProcesses(taskId)
    expect(activeBefore.length).toBe(1)
    expect(activeBefore[0].pid).toBe(pid)

    // Kill entire process tree via taskkill /F /T
    const killedCount = await registry.killProcessTree(taskId)
    expect(killedCount).toBe(1)

    // Verify registry is cleaned
    const activeAfter = registry.getActiveProcesses(taskId)
    expect(activeAfter.length).toBe(0)

    // Verify process is physically dead in Windows OS process table
    await new Promise((r) => setTimeout(r, 200))
    const isProcessAlive = () => {
      try {
        const out = execSync(`powershell -NoProfile -Command "Get-Process -Id ${pid} -ErrorAction SilentlyContinue"`, {
          encoding: 'utf-8',
        })
        return out.trim().length > 0
      } catch {
        return false
      }
    }
    expect(isProcessAlive()).toBe(false)
  })

  it('recovers interrupted tasks from disk checkpoints after unexpected crash', async () => {
    const task = await orchestrator.createTask({
      title: 'Crash Recovery Test Task',
      objective: 'Verify checkpoint resumption after crash',
      subtasks: [
        {
          title: 'Step 1: Ingest Data',
          capability: 'dev.inspectProject',
          dependencies: [],
        },
        {
          title: 'Step 2: Transform Features',
          capability: 'dev.patchFile',
          dependencies: ['step-1'],
        },
        {
          title: 'Step 3: Generate Summary Model',
          capability: 'dev.generateReport',
          dependencies: ['step-2'],
        },
      ],
    })

    const sub1Id = task.subtasks[0].id
    const sub2Id = task.subtasks[1].id
    const sub3Id = task.subtasks[2].id

    // Simulate task in flight when power cut occurs
    task.state = 'EXECUTING'
    task.subtasks[0].state = 'VERIFIED'
    task.subtasks[0].verification = {
      passed: true,
      evidence: 'Verified data input 100 records ingested',
    }
    task.subtasks[1].state = 'EXECUTING' // Crashed while executing
    task.subtasks[2].state = 'PENDING'

    task.checkpoints = [
      {
        id: 'chk-1',
        taskId: task.id,
        timestamp: Date.now() - 5000,
        subtaskId: sub1Id,
        completedSubtaskIds: [sub1Id],
        stateSnapshot: { sub1: 'done' },
        summary: 'Completed data ingestion',
      },
    ]
    await store.saveTask(task)

    // Trigger crash recovery
    const recovered = await orchestrator.recoverUnfinishedTasks()
    expect(recovered.length).toBe(1)
    expect(recovered[0].id).toBe(task.id)

    const updatedTask = await store.getTask(task.id)
    expect(updatedTask).not.toBeNull()
    expect(updatedTask?.state).toBe('QUEUED')
    expect(updatedTask?.recoveryCount).toBe(1)

    // Subtask 1 had verified evidence, so it remains VERIFIED
    const sub1 = updatedTask?.subtasks.find((s) => s.id === sub1Id)
    expect(sub1?.state).toBe('VERIFIED')

    // Subtask 2 was interrupted in EXECUTING: its dependencies (sub-1) are satisfied, so it becomes READY
    const sub2 = updatedTask?.subtasks.find((s) => s.id === sub2Id)
    expect(sub2?.state).toBe('READY')

    // Subtask 3 was PENDING and depends on sub-2 (which is not yet verified), so it stays PENDING
    const sub3 = updatedTask?.subtasks.find((s) => s.id === sub3Id)
    expect(sub3?.state).toBe('PENDING')
  })

  it('halts infinite recovery loops by failing tasks that exceed maxRecoveries', async () => {
    const task = await orchestrator.createTask({
      title: 'Corrupted Task Loop',
      objective: 'Task that crashes repeatedly',
      subtasks: [
        {
          id: 'sub-loop-1',
          title: 'Unstable action',
          capability: 'dev.inspectProject',
          dependencies: [],
          state: 'EXECUTING',
        },
      ],
    })

    task.state = 'EXECUTING'
    task.recoveryCount = 3 // Exceeded maxRecoveries (default 3)
    task.maxRecoveries = 3
    await store.saveTask(task)

    const recovered = await orchestrator.recoverUnfinishedTasks()
    expect(recovered.length).toBe(0)

    const updatedTask = await store.getTask(task.id)
    expect(updatedTask?.state).toBe('FAILED')
    expect(updatedTask?.error).toContain('Exceeded maximum recovery limit')
  })

  it('deduplicates concurrent and sequential task submissions using idempotency keys', async () => {
    const bus = new EventBus()
    const log = createLogger({ level: 'silent' })
    const service = new TaskService({
      dataDir: 'D:/JARVIS-Test/JARVIS-3.3',
      bus,
      log,
      useMemoryStorage: true,
    })

    const idempotencyKey = 'task-idempotent-deploy-987'

    // First submission
    const task1Promise = service.createTask({
      title: 'Idempotent Build & Deploy',
      objective: 'Build container and deploy artifact',
      idempotencyKey,
      subtasks: [
        {
          id: 's1',
          title: 'Compile assets',
          capability: 'dev.inspectProject',
          dependencies: [],
        },
      ],
    })

    // Second submission with identical key
    const task2Promise = service.createTask({
      title: 'Idempotent Build & Deploy Duplicate',
      objective: 'Build container and deploy artifact duplicate',
      idempotencyKey,
      subtasks: [
        {
          id: 's1',
          title: 'Compile assets',
          capability: 'dev.inspectProject',
          dependencies: [],
        },
      ],
    })

    const [task1, task2] = await Promise.all([task1Promise, task2Promise])
    expect(task1.id).toBe(task2.id)

    // Third submission after initial promises settled
    const task3 = await service.createTask({
      title: 'Idempotent Build & Deploy Triplicate',
      objective: 'Build container and deploy artifact triplicate',
      idempotencyKey,
    })

    expect(task3.id).toBe(task1.id)

    const allTasks = await service.listTasks()
    expect(allTasks.filter((t) => (t.metadata as Record<string, unknown>)?.idempotencyKey === idempotencyKey).length).toBe(1)
  })

  it('cancels tasks cleanly and skips pending subtasks without leaking resources', async () => {
    const task = await orchestrator.createTask({
      title: 'Cancellable Task',
      objective: 'Test clean cancellation',
      subtasks: [
        { id: 'sub-c1', title: 'Step 1', capability: 'dev.inspectProject', dependencies: [], state: 'EXECUTING' },
        { id: 'sub-c2', title: 'Step 2', capability: 'dev.patchFile', dependencies: ['sub-c1'], state: 'PENDING' },
      ],
    })

    task.state = 'EXECUTING'
    await store.saveTask(task)

    const cancelled = await orchestrator.cancelTask(task.id, 'User clicked emergency abort')
    expect(cancelled).toBe(true)

    const updated = await store.getTask(task.id)
    expect(updated?.state).toBe('CANCELLED')
    expect(updated?.subtasks[0].state).toBe('SKIPPED')
    expect(updated?.subtasks[1].state).toBe('SKIPPED')
    expect(updated?.logs.some((l) => l.message.includes('emergency abort'))).toBe(true)
  })
})
