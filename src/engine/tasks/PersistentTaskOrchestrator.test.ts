import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  PersistentTaskOrchestrator,
  type SubtaskExecutor,
} from './PersistentTaskOrchestrator'
import { MemoryTaskStorage, TaskStore } from './TaskStore'
import type { Subtask } from './types'

describe('PersistentTaskOrchestrator (Phase B)', () => {
  let store: TaskStore
  let orchestrator: PersistentTaskOrchestrator

  beforeEach(() => {
    store = new TaskStore(new MemoryTaskStorage())
    orchestrator = new PersistentTaskOrchestrator({
      store,
      stallThresholdMs: 2000,
    })
  })

  it('creates tasks with subtasks, DAG dependencies, and priorities', async () => {
    const task = await orchestrator.createTask({
      title: 'Audit and Fix ProjectHub',
      objective: 'Run audit and fix missing components',
      priority: 85,
      subtasks: [
        {
          title: 'Audit Repository',
          description: 'Inspect structure and files',
          capability: 'dev.auditRepo',
          toolId: 'dev.auditRepo',
          payload: { repoPath: 'D:/Projects/ProjectHub' },
          priority: 90,
          dependencies: [],
        },
        {
          title: 'Apply Fixes',
          description: 'Patch missing exports',
          capability: 'dev.patchFile',
          toolId: 'dev.patchFile',
          payload: { file: 'src/index.ts' },
          priority: 80,
          dependencies: ['subtask-1'], // Will be mapped to correct ID
        },
      ],
      tags: ['dev', 'projecthub'],
    })

    expect(task.id).toMatch(/^task-/)
    expect(task.state).toBe('CREATED')
    expect(task.priority).toBe(85)
    expect(task.subtasks).toHaveLength(2)
    expect(task.subtasks[0].state).toBe('PENDING')
    expect(task.logs).toHaveLength(1)
  })

  it('executes full task lifecycle to COMPLETED only with verified evidence', async () => {
    const executor: SubtaskExecutor = vi.fn(async (subtask: Subtask) => {
      return {
        success: true,
        output: { audited: true, files: 12 },
        observation: { kind: 'audit', summary: '12 files inspected' },
        verification: {
          passed: true,
          evidence: `Verified exit code 0 and artifact exists for ${subtask.title}`,
        },
      }
    })

    orchestrator.setExecutor(executor)

    const task = await orchestrator.createTask({
      title: 'Build and Verify',
      objective: 'Run build and test',
      subtasks: [
        {
          title: 'Step 1: Build',
          description: 'Compile code',
          capability: 'dev.build',
          toolId: 'dev.build',
          payload: {},
          priority: 50,
          dependencies: [],
        },
        {
          title: 'Step 2: Test',
          description: 'Run unit tests',
          capability: 'dev.test',
          toolId: 'dev.test',
          payload: {},
          priority: 50,
          dependencies: [], // Will run in sequence
        },
      ],
    })

    // Update dependency of step 2 to step 1
    task.subtasks[1].dependencies = [task.subtasks[0].id]
    await store.saveTask(task)

    await orchestrator.queueTask(task.id)
    await orchestrator.tick()

    const finalTask = await store.getTask(task.id)
    expect(finalTask?.state).toBe('COMPLETED')
    expect(finalTask?.subtasks[0].state).toBe('VERIFIED')
    expect(finalTask?.subtasks[1].state).toBe('VERIFIED')
    expect(finalTask?.checkpoints).toHaveLength(2)
    expect(finalTask?.checkpoints[1].completedSubtaskIds).toContain(task.subtasks[1].id)
    expect(executor).toHaveBeenCalledTimes(2)
  })

  it('refuses to mark a subtask verified if verification evidence is missing', async () => {
    // Agent returns success: true, but verification passed: false or missing evidence
    const executor: SubtaskExecutor = vi.fn(async () => {
      return {
        success: true,
        output: 'I did it!',
        // Verification NOT passed
        verification: {
          passed: false,
          evidence: '',
        },
      }
    })

    orchestrator.setExecutor(executor)

    const task = await orchestrator.createTask({
      title: 'Unverified Step',
      objective: 'Attempt unverified completion',
      subtasks: [
        {
          title: 'Unverified Action',
          description: 'Fakes completion',
          capability: 'fake',
          toolId: 'fake',
          payload: {},
          priority: 50,
          dependencies: [],
          maxRetries: 1,
        },
      ],
    })

    await orchestrator.queueTask(task.id)
    await orchestrator.tick()

    const updatedTask = await store.getTask(task.id)
    // Should NOT be completed! Should be RECOVERY_REQUIRED because verification failed after retries
    expect(updatedTask?.state).toBe('RECOVERY_REQUIRED')
    expect(updatedTask?.subtasks[0].state).toBe('FAILED')
    expect(updatedTask?.checkpoints).toHaveLength(0)
  })

  it('recovers interrupted tasks from last verified checkpoint without repeating work', async () => {
    const task = await orchestrator.createTask({
      title: 'Long Migration Task',
      objective: 'Run three-phase migration',
      subtasks: [
        {
          title: 'Subtask 1',
          description: 'Phase 1',
          capability: 'dev.step1',
          toolId: 'dev.step1',
          payload: {},
          priority: 50,
          dependencies: [],
        },
        {
          title: 'Subtask 2',
          description: 'Phase 2',
          capability: 'dev.step2',
          toolId: 'dev.step2',
          payload: {},
          priority: 50,
          dependencies: [],
        },
      ],
    })

    // Simulate Subtask 1 was verified and checkpoint saved
    task.subtasks[0].state = 'VERIFIED'
    task.subtasks[0].verification = {
      passed: true,
      evidence: 'Phase 1 completed and verified',
      timestamp: Date.now() - 5000,
    }
    task.subtasks[1].dependencies = [task.subtasks[0].id]
    task.checkpoints.push({
      checkpointId: 'cp-step1',
      taskId: task.id,
      timestamp: Date.now() - 5000,
      state: 'EXECUTING',
      subtaskIndex: 0,
      completedSubtaskIds: [task.subtasks[0].id],
      verifiedArtifacts: { step1: 'done' },
      summary: 'Subtask 1 verified',
      executionStateHash: 'hash-1',
    })

    // Simulate PC crashed while Subtask 2 was in EXECUTING
    task.subtasks[1].state = 'EXECUTING'
    task.state = 'EXECUTING'
    await store.saveTask(task)

    // Crash recovery on boot
    const recovered = await orchestrator.recoverUnfinishedTasks()
    expect(recovered).toHaveLength(1)

    const recoveredTask = await store.getTask(task.id)
    expect(recoveredTask?.state).toBe('QUEUED')
    // Subtask 1 MUST stay VERIFIED!
    expect(recoveredTask?.subtasks[0].state).toBe('VERIFIED')
    // Subtask 2 is reset to READY so it can safely execute
    expect(recoveredTask?.subtasks[1].state).toBe('READY')

    // Now execute remaining work
    const executor: SubtaskExecutor = vi.fn(async () => ({
      success: true,
      verification: { passed: true, evidence: 'Step 2 verified' },
    }))
    orchestrator.setExecutor(executor)

    await orchestrator.tick()

    const completedTask = await store.getTask(task.id)
    expect(completedTask?.state).toBe('COMPLETED')
    // Executor was only called ONCE (for step 2)! Step 1 was NEVER re-run!
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it('supports pause, resume, and cancellation controls', async () => {
    const task = await orchestrator.createTask({
      title: 'Controllable Task',
      objective: 'Test pause/resume/cancel',
      subtasks: [
        {
          title: 'Step 1',
          description: 'First step',
          capability: 'test',
          toolId: 'test',
          payload: {},
          priority: 50,
          dependencies: [],
        },
      ],
    })

    await orchestrator.queueTask(task.id)
    let t = await store.getTask(task.id)
    expect(t?.state).toBe('QUEUED')

    // Pause
    const paused = await orchestrator.pauseTask(task.id)
    expect(paused).toBe(true)
    t = await store.getTask(task.id)
    expect(t?.state).toBe('PAUSED')

    // Resume
    const resumed = await orchestrator.resumeTask(task.id)
    expect(resumed).toBe(true)
    t = await store.getTask(task.id)
    expect(t?.state).toBe('QUEUED')

    // Cancel
    const cancelled = await orchestrator.cancelTask(task.id, 'User stopped it')
    expect(cancelled).toBe(true)
    t = await store.getTask(task.id)
    expect(t?.state).toBe('CANCELLED')
  })

  it('handles permission gating and explicit approval / rejection', async () => {
    const executor: SubtaskExecutor = vi.fn(async () => ({
      success: false,
      requiresPermission: {
        action: 'Delete production database',
        description: 'Drop table users',
        impact: 'High data loss risk',
        toolId: 'db.drop',
      },
    }))

    orchestrator.setExecutor(executor)

    const task = await orchestrator.createTask({
      title: 'Dangerous Operation',
      objective: 'Requires permission',
      subtasks: [
        {
          title: 'Drop DB',
          description: 'Destructive action',
          capability: 'db.drop',
          toolId: 'db.drop',
          payload: {},
          priority: 50,
          dependencies: [],
        },
      ],
    })

    await orchestrator.queueTask(task.id)
    await orchestrator.tick()

    let t = await store.getTask(task.id)
    expect(t?.state).toBe('WAITING_FOR_PERMISSION')
    expect(t?.requiredApprovals).toHaveLength(1)
    const approvalId = t!.requiredApprovals[0].id

    // Rejecting the dangerous action
    const rejected = await orchestrator.rejectAction(task.id, approvalId, 'Denied by security policy')
    expect(rejected).toBe(true)

    t = await store.getTask(task.id)
    expect(t?.state).toBe('FAILED')
    expect(t?.error).toContain('Action denied')
  })

  it('detects stalled tasks when heartbeat exceeds threshold', async () => {
    const task = await orchestrator.createTask({
      title: 'Frozen Task',
      objective: 'Simulate worker hang',
      subtasks: [
        {
          title: 'Hanging step',
          description: 'Never returns',
          capability: 'hang',
          toolId: 'hang',
          payload: {},
          priority: 50,
          dependencies: [],
        },
      ],
    })

    task.state = 'EXECUTING'
    // Heartbeat was 5 seconds ago (threshold is 2000ms)
    task.lastHeartbeatAt = Date.now() - 5000
    await store.saveTask(task)

    const stalled = await orchestrator.detectStalledTasks()
    expect(stalled).toHaveLength(1)

    const updated = await store.getTask(task.id)
    expect(updated?.state).toBe('RECOVERY_REQUIRED')
  })
})
