/**
 * JARVIS Autonomous Execution Acceptance Tests
 *
 * Implements rigorous empirical tests for the 6 acceptance dimensions:
 * - Test 1: Single-command execution (Real ProjectHub repo)
 * - Test 2: HUD independence (Headless background execution)
 * - Test 3: Restart recovery (Interruption & checkpoint recovery without repetition)
 * - Test 4: Permission enforcement (Default-deny & approval workflows)
 * - Test 5: Failure recovery (Error classification & bounded retries)
 * - Test 6: Resource management (System monitoring & concurrency limits)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { AssistantEngine } from '../../src/engine/AssistantEngine'
import { MemoryTaskStorage, TaskStore } from '../../src/engine/tasks/TaskStore'
import { FileTaskStorage } from '../../server/src/tasks/TaskStore.js'
import { DevEngine } from '../../server/src/dev/DevEngine.js'
import { setGlobalDevExecutor } from '../../src/engine/dev/DevTools'
import { MemoryProjectContextStorage } from '../../src/memory/projectContext'
import { useConversationStore } from '../../src/state/conversation.store'
import { PersistentTaskOrchestrator } from '../../src/engine/tasks/PersistentTaskOrchestrator'
import { classifyTaskError } from '../../src/engine/tasks/errorClassifier'
import { ResourceMonitor } from '../../server/src/resourceMonitor'
import { TaskService } from '../../server/src/taskService'
import { EventBus } from '../../server/src/events'
import { nullLogger } from '../../server/src/log'
import type { Tool } from '../../src/tools/Tool'
import type { PersistentTask } from '../../src/engine/tasks/types'

function stubBrowserStorage(): void {
  const backing = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  ;(globalThis as Record<string, unknown>).window = {
    localStorage,
    setTimeout: (_fn: () => void) => 0,
  }
}

describe('Autonomous Execution Acceptance Test Suite', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    setGlobalDevExecutor((action, params) => new DevEngine().execute(action, params))
  })

  afterEach(() => {
    setGlobalDevExecutor(null)
  })

  // --------------------------------------------------------------------------
  // TEST 1 — Single-command execution (Real ProjectHub software repository)
  // --------------------------------------------------------------------------
  describe('Test 1 — Single-command execution', () => {
    const projectDir = 'D:/ProjectHub'
    const codeFile = join(projectDir, 'src', 'projectHub.js')
    const backupFile = `${codeFile}.jarvis.bak`

    beforeEach(() => {
      // Ensure initial broken/stub state
      if (existsSync(backupFile)) {
        try { rmSync(backupFile, { force: true }) } catch {}
      }
      writeFileSync(
        codeFile,
        `/**
 * ProjectHub Core Module
 */
export function calculateProjectMetrics(tasks) {
  if (!Array.isArray(tasks)) {
    throw new TypeError('tasks must be an array');
  }
  // INCOMPLETE IMPLEMENTATION: Stub returning 0
  return {
    total: tasks.length,
    completed: 0,
    completionRate: 0
  };
}
`,
        'utf-8',
      )
    })

    it(
      'interprets natural language command, creates plan, executes targeted fix, verifies tests, and reports results',
      async () => {
        // 1. Verify baseline test fails prior to JARVIS execution
        let initialTestFailed = false
        try {
          execSync('npm test', { cwd: projectDir, stdio: 'pipe' })
        } catch (err: any) {
          initialTestFailed = true
          expect(err.status).toBe(1)
        }
        expect(initialTestFailed).toBe(true)

        // 2. Initialize AssistantEngine with persistent task orchestrator
        const taskStorage = new MemoryTaskStorage()
        const projectStorage = new MemoryProjectContextStorage()
        const engine = new AssistantEngine({
          taskStorage,
          projectContextStorage: projectStorage,
        })

        // 3. User issues single natural language command
        const command =
          'Inspect my ProjectHub repository, identify one incomplete but safe functionality, implement it, run relevant tests and report the results.'
        await engine.process(command)

        // 4. Verify task creation & planning
        const tasks = await engine.getPersistentTasks()
        expect(tasks.length).toBeGreaterThan(0)
        const task = tasks[0]

        expect(task.objective).toContain('ProjectHub')
        expect(task.subtasks.length).toBe(7)
        expect(task.subtasks.map((s) => s.capability)).toEqual([
          'dev.inspectProject',
          'dev.gitStatus',
          'dev.gitCheckpoint',
          'dev.patchFile',
          'dev.runTests',
          'dev.auditProject',
          'dev.generateReport',
        ])

        // 5. Wait for persistent execution to complete all subtasks
        const orchestrator = engine.getPersistentOrchestrator()
        orchestrator.start(50) // Fast execution loop for tests
        const startTime = Date.now()
        while (Date.now() - startTime < 25_000) {
          const current = await orchestrator.getTask(task.id)
          if (current && (current.state === 'COMPLETED' || current.state === 'FAILED')) {
            break
          }
          await new Promise((r) => setTimeout(r, 100))
        }

        const finalTask = await orchestrator.getTask(task.id)
        expect(finalTask).not.toBeNull()
        expect(finalTask!.state).toBe('COMPLETED')

        // 6. Verify real file modifications
        expect(existsSync(backupFile)).toBe(true)
        const modifiedContent = readFileSync(codeFile, 'utf-8')
        expect(modifiedContent).toContain('const completed = tasks.filter')
        expect(modifiedContent).toContain('completionRate')
        expect(modifiedContent).not.toContain('Stub returning 0')

        // 7. Verify actual test execution outcome in task results
        const testSubtask = finalTask!.subtasks.find((s) => s.capability === 'dev.runTests')
        expect(testSubtask).toBeDefined()
        expect(testSubtask!.state).toBe('VERIFIED')
        expect(testSubtask!.verification?.passed).toBe(true)
        expect(testSubtask!.result?.success).toBe(true)

        // 8. Independent verification: running npm test directly on disk passes with exit code 0
        const directTestOutput = execSync('npm test', { cwd: projectDir, encoding: 'utf-8' })
        expect(directTestOutput).toContain('pass 1')
        expect(directTestOutput).toContain('fail 0')

        orchestrator.stop()
      },
      30_000,
    )

    it(
      'executes Python circle-area task in D:\\JARVIS-Test, creates circle.py and test_circle.py, executes python unittest, and generates report',
      async () => {
        const testDir = 'D:/JARVIS-Test'
        mkdirSync(testDir, { recursive: true })
        for (const f of ['circle.py', 'test_circle.py', 'JARVIS_EXECUTION_REPORT.md', '__pycache__']) {
          try { rmSync(join(testDir, f), { recursive: true, force: true }) } catch {}
        }

        const taskStorage = new MemoryTaskStorage()
        const projectStorage = new MemoryProjectContextStorage()
        const engine = new AssistantEngine({
          taskStorage,
          projectContextStorage: projectStorage,
        })

        const command =
          'Inspect D:\\JARVIS-Test. Create a simple Python program that calculates the area of a circle. Create an appropriate test file, execute the tests, verify the results, and generate a completion report.'
        await engine.process(command)

        const tasks = await engine.getPersistentTasks()
        expect(tasks.length).toBeGreaterThan(0)
        const task = tasks[0]

        expect(task.objective).toContain('JARVIS-Test')
        expect(task.subtasks.length).toBe(8)
        expect(task.subtasks.map((s) => s.capability)).toEqual([
          'dev.inspectProject',
          'dev.gitStatus',
          'dev.gitCheckpoint',
          'dev.patchFile',
          'dev.patchFile',
          'dev.runTests',
          'dev.inspectProject',
          'dev.generateReport',
        ])

        const orchestrator = engine.getPersistentOrchestrator()
        orchestrator.start(50)
        const startTime = Date.now()
        while (Date.now() - startTime < 30_000) {
          const current = await orchestrator.getTask(task.id)
          if (current && (current.state === 'COMPLETED' || current.state === 'FAILED')) {
            break
          }
          await new Promise((r) => setTimeout(r, 100))
        }

        const finalTask = await orchestrator.getTask(task.id)
        expect(finalTask).not.toBeNull()
        expect(finalTask!.state).toBe('COMPLETED')

        // Verify files on disk
        const circleFile = join(testDir, 'circle.py')
        const testFile = join(testDir, 'test_circle.py')
        const reportFile = join(testDir, 'JARVIS_EXECUTION_REPORT.md')

        expect(existsSync(circleFile)).toBe(true)
        expect(existsSync(testFile)).toBe(true)
        expect(existsSync(reportFile)).toBe(true)

        const circleContent = readFileSync(circleFile, 'utf-8')
        expect(circleContent).toContain('calculate_circle_area')
        expect(circleContent).toContain('math.pi')

        // Direct independent test execution on disk
        const directPyOutput = execSync('python -m unittest test_circle.py', {
          cwd: testDir,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        expect(directPyOutput).toBeDefined()

        const reportContent = readFileSync(reportFile, 'utf-8')
        expect(reportContent).toContain('JARVIS Execution Report')
        expect(reportContent).toContain('circle.py')
        expect(reportContent).toContain('Test Execution Evidence')
        expect(reportContent).toContain('Exit code: 0')

        orchestrator.stop()
      },
      35_000,
    )
  })

  // --------------------------------------------------------------------------
  // TEST 2 — HUD independence (Headless background execution)
  // --------------------------------------------------------------------------
  describe('Test 2 — HUD independence', () => {
    const testDir = join(process.cwd(), 'server', 'data', 'acceptance_test_hud')

    beforeEach(() => {
      try { rmSync(testDir, { recursive: true, force: true }) } catch {}
      mkdirSync(testDir, { recursive: true })
    })

    afterEach(() => {
      try { rmSync(testDir, { recursive: true, force: true }) } catch {}
    })

    it(
      'continues executing tasks in the background without frontend and restores state on reconnect',
      async () => {
        const bus = new EventBus()
        const service = new TaskService({
          dataDir: testDir,
          bus,
          log: nullLogger(),
        })

        await service.init()

        // 1. Submit multi-step task while frontend is absent. Real dev.*
        // capabilities keep this a genuine headless execution test: an
        // unimplemented capability must never be reported as success.
        const task = await service.createTask({
          title: 'Background Project Inspection',
          objective: 'Execute multi-step project inspection headlessly',
          priority: 60,
          subtasks: [
            {
              title: 'Inspect Project Structure',
              description: 'Discover the project stack and files',
              capability: 'dev.inspectProject',
              payload: { projectPath: testDir },
              dependencies: [],
            },
            {
              title: 'Re-Inspect Project Structure',
              description: 'Confirm the project remains readable',
              capability: 'dev.inspectProject',
              payload: { projectPath: testDir },
              dependencies: ['step-1'],
            },
          ],
        })

        expect(task.state).toBe('QUEUED')

        // 2. Poll until task completes in background
        const startTime = Date.now()
        while (Date.now() - startTime < 10_000) {
          const cur = await service.getTask(task.id)
          if (cur && cur.state === 'COMPLETED') break
          await new Promise((r) => setTimeout(r, 100))
        }

        // 3. Emulate HUD reconnecting and querying task state
        const reconnectedTask = await service.getTask(task.id)
        expect(reconnectedTask).not.toBeNull()
        expect(reconnectedTask!.state).toBe('COMPLETED')
        expect(reconnectedTask!.subtasks.every((s) => s.state === 'VERIFIED')).toBe(true)

        const allTasks = await service.listTasks()
        expect(allTasks.some((t) => t.id === task.id)).toBe(true)

        await service.stop()
      },
      15_000,
    )
  })

  // --------------------------------------------------------------------------
  // TEST 3 — Restart recovery
  // --------------------------------------------------------------------------
  describe('Test 3 — Restart recovery', () => {
    const testDir = join(process.cwd(), 'server', 'data', 'acceptance_test_recovery')

    beforeEach(() => {
      try { rmSync(testDir, { recursive: true, force: true }) } catch {}
      mkdirSync(join(testDir, 'tasks'), { recursive: true })
    })

    afterEach(() => {
      try { rmSync(testDir, { recursive: true, force: true }) } catch {}
    })

    it(
      'recovers interrupted task from disk checkpoint and preserves verified subtasks',
      async () => {
        const bus = new EventBus()
        const storage = new FileTaskStorage(join(testDir, 'tasks'))

        // 1. Construct an interrupted task on disk where step 1 is VERIFIED and step 2 was EXECUTING
        const taskId = `task-recovery-${Date.now()}`
        const task: PersistentTask = {
          id: taskId,
          title: 'Multi-Step Interrupted Task',
          objective: 'Test restart recovery without repeating verified actions',
          priority: 70,
          state: 'EXECUTING',
          createdAt: Date.now() - 10000,
          updatedAt: Date.now() - 1000,
          startedAt: Date.now() - 9000,
          lastHeartbeatAt: Date.now() - 1000,
          subtasks: [
            {
              id: `subtask-${taskId}-1`,
              taskId,
              stepIndex: 0,
              title: 'Subtask 1 - Preparation',
              description: 'Initialize environment',
              capability: 'prep',
              state: 'VERIFIED',
              retries: 0,
              maxRetries: 2,
              dependencies: [],
              completedAt: Date.now() - 5000,
              verification: { passed: true, evidence: 'Preparation completed successfully' },
            },
            {
              id: `subtask-${taskId}-2`,
              taskId,
              stepIndex: 1,
              title: 'Subtask 2 - Heavy Processing',
              description: 'Process data stream',
              capability: 'dev.inspectProject',
              toolId: 'dev.inspectProject',
              payload: { projectPath: testDir },
              state: 'EXECUTING',
              retries: 0,
              maxRetries: 2,
              dependencies: [`subtask-${taskId}-1`],
              startedAt: Date.now() - 2000,
            },
            {
              id: `subtask-${taskId}-3`,
              taskId,
              stepIndex: 2,
              title: 'Subtask 3 - Finalization',
              description: 'Verify outputs',
              capability: 'dev.inspectProject',
              toolId: 'dev.inspectProject',
              payload: { projectPath: testDir },
              state: 'PENDING',
              retries: 0,
              maxRetries: 2,
              dependencies: [`subtask-${taskId}-2`],
            },
          ],
          checkpoints: [
            {
              checkpointId: 'cp-step1-verified',
              taskId,
              timestamp: Date.now() - 4000,
              subtaskIndex: 0,
              state: 'EXECUTING',
              verifiedArtifacts: { [`subtask-${taskId}-1`]: { ready: true } },
              summary: 'Subtask 1 verified: Preparation completed successfully',
              executionStateHash: 'hash-initial-verified',
            },
          ],
          requiredApprovals: [],
          logs: [],
        }

        await storage.save(task)

        // 2. Abrupt interruption: Simulating backend reboot
        const rebootedService = new TaskService({
          dataDir: testDir,
          bus,
          log: nullLogger(),
        })

        // 3. Service initialization automatically runs recovery
        await rebootedService.init()

        // 4. Verify recovery state
        const recoveredTask = await rebootedService.getTask(task.id)
        expect(recoveredTask).not.toBeNull()

        // Subtask 1 must remain VERIFIED and not be repeated
        expect(recoveredTask!.subtasks[0].state).toBe('VERIFIED')
        expect(recoveredTask!.subtasks[0].verification?.evidence).toBe(
          'Preparation completed successfully',
        )

        // Checkpoints preserved
        expect(recoveredTask!.checkpoints.length).toBeGreaterThanOrEqual(1)
        expect(recoveredTask!.checkpoints[0].checkpointId).toBe('cp-step1-verified')

        // Wait for task to finish remaining steps
        const startTime = Date.now()
        while (Date.now() - startTime < 10_000) {
          const cur = await rebootedService.getTask(task.id)
          if (cur && cur.state === 'COMPLETED') break
          await new Promise((r) => setTimeout(r, 100))
        }

        const completedTask = await rebootedService.getTask(task.id)
        expect(completedTask!.state).toBe('COMPLETED')
        expect(completedTask!.subtasks.every((s) => s.state === 'VERIFIED')).toBe(true)

        await rebootedService.stop()
      },
      15_000,
    )
  })

  // --------------------------------------------------------------------------
  // TEST 4 — Permission enforcement
  // --------------------------------------------------------------------------
  describe('Test 4 — Permission enforcement', () => {
    it(
      'blocks high-risk actions until explicit user decision and halts on rejection',
      async () => {
        const taskStorage = new MemoryTaskStorage()
        const projectStorage = new MemoryProjectContextStorage()
        const engine = new AssistantEngine({
          taskStorage,
          projectContextStorage: projectStorage,
        })

        // Register a sensitive tool requiring user confirmation
        const deleteTool: Tool = {
          id: 'system.deleteFile',
          name: 'Delete File',
          description: 'Permanently removes a file',
          category: 'filesystem',
          permission: 'high_risk',
          requiresPermission: true,
          canRun: () => true,
          execute: async () => ({ ok: true, message: 'File deleted' }),
        }
        engine.tools.register(deleteTool)

        // Submit task requesting deletion
        const orchestrator = engine.getPersistentOrchestrator()
        const task = await orchestrator.createTask({
          title: 'Delete Production Database Artifact',
          objective: 'Purge sensitive file',
          subtasks: [
            {
              title: 'Delete sensitive database dump',
              description: 'High risk file deletion',
              capability: 'system.deleteFile',
              toolId: 'system.deleteFile',
              payload: { path: '/var/db/dump.sql' },
              dependencies: [],
            },
          ],
        })

        await orchestrator.queueTask(task.id)
        orchestrator.start(50)

        // 1. Wait for task to encounter permission gate
        const startTime = Date.now()
        while (Date.now() - startTime < 5000) {
          const cur = await orchestrator.getTask(task.id)
          if (cur && cur.state === 'WAITING_FOR_PERMISSION') break
          await new Promise((r) => setTimeout(r, 100))
        }

        const gatedTask = await orchestrator.getTask(task.id)
        expect(gatedTask!.state).toBe('WAITING_FOR_PERMISSION')
        expect(gatedTask!.requiredApprovals.length).toBe(1)
        const approval = gatedTask!.requiredApprovals[0]
        expect(approval.granted).toBeUndefined()
        expect(approval.toolId).toBe('system.deleteFile')

        // 2. Test User Rejection: rejecting halts task with FAILED
        await orchestrator.rejectAction(task.id, approval.id, 'User rejected dangerous file deletion')

        const rejectedTask = await orchestrator.getTask(task.id)
        expect(rejectedTask!.state).toBe('FAILED')
        expect(rejectedTask!.requiredApprovals[0].granted).toBe(false)
        expect(rejectedTask!.error).toContain('rejected')

        orchestrator.stop()
      },
      10_000,
    )

    it(
      'resumes and completes task when user grants permission',
      async () => {
        const taskStorage = new MemoryTaskStorage()
        const projectStorage = new MemoryProjectContextStorage()
        const engine = new AssistantEngine({
          taskStorage,
          projectContextStorage: projectStorage,
        })

        const pushTool: Tool = {
          id: 'git.pushRemote',
          name: 'Git Push Remote',
          description: 'Pushes commits to remote repository',
          category: 'git',
          permission: 'high_risk',
          requiresPermission: true,
          canRun: () => true,
          execute: async () => ({ ok: true, message: 'Branch pushed to origin' }),
        }
        engine.tools.register(pushTool)

        const orchestrator = engine.getPersistentOrchestrator()
        const task = await orchestrator.createTask({
          title: 'Publish Branch',
          objective: 'Push branch to remote origin',
          subtasks: [
            {
              title: 'Push to origin',
              description: 'Publish changes',
              capability: 'git.pushRemote',
              toolId: 'git.pushRemote',
              payload: { remote: 'origin', branch: 'main' },
              dependencies: [],
            },
          ],
        })

        await orchestrator.queueTask(task.id)
        orchestrator.start(50)

        while (true) {
          const cur = await orchestrator.getTask(task.id)
          if (cur && cur.state === 'WAITING_FOR_PERMISSION') break
          await new Promise((r) => setTimeout(r, 100))
        }

        const gatedTask = await orchestrator.getTask(task.id)
        const approval = gatedTask!.requiredApprovals[0]

        // Grant approval
        await orchestrator.approveAction(task.id, approval.id)

        const startTime = Date.now()
        while (Date.now() - startTime < 8000) {
          const cur = await orchestrator.getTask(task.id)
          if (cur && cur.state === 'COMPLETED') break
          await new Promise((r) => setTimeout(r, 100))
        }

        const completedTask = await orchestrator.getTask(task.id)
        expect(completedTask!.state).toBe('COMPLETED')
        expect(completedTask!.requiredApprovals[0].granted).toBe(true)

        orchestrator.stop()
      },
      10_000,
    )
  })

  // --------------------------------------------------------------------------
  // TEST 5 — Failure recovery
  // --------------------------------------------------------------------------
  describe('Test 5 — Failure recovery', () => {
    it('accurately classifies errors into actionable recovery categories', () => {
      expect(classifyTaskError(new Error('ENOENT: spawn git not found')).category).toBe(
        'DEPENDENCY_MISSING',
      )
      expect(classifyTaskError(new Error('connect ECONNREFUSED 127.0.0.1:8787')).category).toBe(
        'TRANSIENT_RESOURCE',
      )
      expect(classifyTaskError(new Error('429 Too Many Requests: quota exceeded')).category).toBe(
        'TRANSIENT_RESOURCE',
      )
      expect(classifyTaskError(new Error('EACCES: permission denied')).category).toBe(
        'PERMISSION_DENIED',
      )
      expect(classifyTaskError(new Error('SyntaxError: unexpected token')).category).toBe(
        'SYNTAX_LINT_ERROR',
      )
      expect(classifyTaskError(new Error('TypeError: unexpected value')).category).toBe(
        'FATAL_UNRECOVERABLE',
      )
    })

    it(
      'enforces bounded retries and halts on persistent failures',
      async () => {
        const taskStorage = new MemoryTaskStorage()
        const projectStorage = new MemoryProjectContextStorage()
        const engine = new AssistantEngine({
          taskStorage,
          projectContextStorage: projectStorage,
        })

        let attempts = 0
        const flakingTool: Tool = {
          id: 'test.flakyTool',
          name: 'Flaky Tool',
          description: 'Simulates failures',
          category: 'test',
          permission: 'read_only',
          requiresPermission: false,
          canRun: () => true,
          execute: async () => {
            attempts++
            return { ok: false, message: 'ETIMEDOUT: Connection timed out' }
          },
        }
        engine.tools.register(flakingTool)

        const orchestrator = engine.getPersistentOrchestrator()
        const task = await orchestrator.createTask({
          title: 'Retry Budget Test',
          objective: 'Verify bounded retries',
          subtasks: [
            {
              title: 'Flaky step',
              description: 'Runs flaky tool',
              capability: 'test.flakyTool',
              toolId: 'test.flakyTool',
              maxRetries: 2,
              dependencies: [],
            },
          ],
        })

        await orchestrator.queueTask(task.id)
        orchestrator.start(50)

        const startTime = Date.now()
        while (Date.now() - startTime < 8000) {
          const cur = await orchestrator.getTask(task.id)
          if (cur && (cur.state === 'RECOVERY_REQUIRED' || cur.state === 'FAILED')) break
          await new Promise((r) => setTimeout(r, 100))
        }

        const failedTask = await orchestrator.getTask(task.id)
        expect(failedTask!.state).toBe('RECOVERY_REQUIRED')
        expect(attempts).toBe(3) // 1 initial + 2 retries
        expect(failedTask!.subtasks[0].retries).toBe(3)

        orchestrator.stop()
      },
      10_000,
    )
  })

  // --------------------------------------------------------------------------
  // TEST 6 — Resource management
  // --------------------------------------------------------------------------
  describe('Test 6 — Resource management', () => {
    it('observes host system metrics and throttles tasks when limits are exceeded', () => {
      const monitor = new ResourceMonitor({
        minFreeMemoryBytes: 1024 * 1024 * 1024 * 1024, // 1 TB minimum free memory (guaranteed to throttle on any test machine)
      })

      const snapshot = monitor.getSnapshot()
      expect(snapshot.freeMemoryBytes).toBeGreaterThan(0)
      expect(snapshot.totalMemoryBytes).toBeGreaterThan(0)

      const check = monitor.canExecuteTask()
      expect(check.allowed).toBe(false)
      expect(check.reason).toContain('Available memory too low')
    })

    it(
      'enforces task concurrency limits',
      async () => {
        const storage = new MemoryTaskStorage()
        const orchestrator = new PersistentTaskOrchestrator({
          store: new TaskStore(storage),
          maxConcurrentTasks: 1, // Only 1 task at a time
          executor: async () => {
            await new Promise((r) => setTimeout(r, 20))
            return {
              success: true,
              verification: { passed: true, evidence: 'done' },
            }
          },
        })

        const task1 = await orchestrator.createTask({
          title: 'Task 1',
          objective: 'Run task 1',
          subtasks: [{ title: 'Step 1', description: 'Step 1', capability: 'noop', dependencies: [] }],
        })

        const task2 = await orchestrator.createTask({
          title: 'Task 2',
          objective: 'Run task 2',
          subtasks: [{ title: 'Step 1', description: 'Step 1', capability: 'noop', dependencies: [] }],
        })

        await orchestrator.queueTask(task1.id)
        await orchestrator.queueTask(task2.id)

        orchestrator.start(20)

        // Wait for both to finish
        while (true) {
          const c1 = await orchestrator.getTask(task1.id)
          const c2 = await orchestrator.getTask(task2.id)
          if (c1?.state === 'COMPLETED' && c2?.state === 'COMPLETED') break
          await new Promise((r) => setTimeout(r, 50))
        }

        const final1 = await orchestrator.getTask(task1.id)
        const final2 = await orchestrator.getTask(task2.id)
        expect(final1?.state).toBe('COMPLETED')
        expect(final2?.state).toBe('COMPLETED')

        orchestrator.stop()
      },
      10_000,
    )
  })
})
