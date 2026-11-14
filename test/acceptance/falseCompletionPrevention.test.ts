/**
 * False Completion Prevention Acceptance Suite (JARVIS 4.0).
 *
 * Mathematically and operationally proves that JARVIS can NEVER claim a task
 * is COMPLETED without concrete on-disk and execution evidence fulfilling the
 * user's actual objective.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { PersistentTaskOrchestrator } from '../../server/src/tasks/PersistentTaskOrchestrator.js'
import { TaskStore, MemoryTaskStorage } from '../../server/src/tasks/TaskStore.js'
import { buildDevelopmentPlan, extractObjectiveRequirements } from '../../server/src/dev/DevelopmentPlanner.js'
import { DevEngine } from '../../server/src/dev/DevEngine.js'
import type { Subtask } from '../../server/src/tasks/types.js'

describe('False Completion Prevention Suite', () => {
  const testDir = join(process.cwd(), 'temp', 'test-false-completion')

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('Scenario 1: Planner extracts file creation, execution, and expected output from natural language', () => {
    const objective =
      'Create a Python file named hello_jarvis.py in D:\\JARVIS-Test. The file must print: Hello! JARVIS 4.0 autonomous execution is working. Run the file, verify its output, and report the exact file path and execution result. Do not modify any existing project files.'

    const req = extractObjectiveRequirements(objective, 'D:\\JARVIS-Test')
    expect(req.demandsFileCreation).toBe(true)
    expect(req.demandsExecution).toBe(true)
    expect(req.filesToCreate.length).toBe(1)
    expect(req.filesToCreate[0].relativePath).toBe('hello_jarvis.py')
    expect(req.filesToCreate[0].content).toContain('Hello! JARVIS 4.0 autonomous execution is working')
    expect(req.expectedOutput).toContain('Hello! JARVIS 4.0 autonomous execution is working')

    const plan = buildDevelopmentPlan(objective, 'D:\\JARVIS-Test')
    expect(plan.requiredFiles).toEqual(['hello_jarvis.py'])
    expect(plan.demandsFileCreation).toBe(true)
    expect(plan.demandsExecution).toBe(true)

    // Verify subtask graph contains creation, disk verification, execution, and honest report
    const patchStep = plan.subtasks.find((s) => s.capability === 'dev.patchFile')
    expect(patchStep).toBeDefined()
    expect(patchStep?.payload.filePath).toBe('hello_jarvis.py')

    const inspectStep = plan.subtasks.find(
      (s) => s.capability === 'dev.inspectProject' && Array.isArray(s.payload.expectedFiles),
    )
    expect(inspectStep).toBeDefined()
    expect(inspectStep?.payload.expectedFiles).toContain('hello_jarvis.py')

    const runStep = plan.subtasks.find((s) => s.capability === 'dev.runTests')
    expect(runStep).toBeDefined()
    expect(runStep?.payload.testFile).toBe('hello_jarvis.py')
    expect(runStep?.payload.expectedOutput).toBe('Hello! JARVIS 4.0 autonomous execution is working')

    const reportStep = plan.subtasks.find((s) => s.capability === 'dev.generateReport')
    expect(reportStep).toBeDefined()
    expect(reportStep?.payload.requiredFiles).toEqual(['hello_jarvis.py'])
  })

  it('Scenario 2: Task with demanded file missing on disk is BLOCKED and marked FAILED', async () => {
    const store = new TaskStore(new MemoryTaskStorage())
    const orchestrator = new PersistentTaskOrchestrator({ store })

    // Simulate all subtasks passing superficially, but the required file does NOT exist on disk
    orchestrator.setExecutor(async (subtask) => {
      return {
        success: true,
        output: { dummy: true },
        verification: { passed: true, evidence: 'Mocked step passed' },
      }
    })

    const task = await orchestrator.createTask({
      title: 'Create hello_jarvis.py',
      objective: 'Create a Python file named hello_jarvis.py in ' + testDir + '. Run the file.',
      subtasks: [
        {
          title: 'Step 1: Mock step',
          capability: 'dev.inspectProject',
          toolId: 'dev.inspectProject',
          payload: { projectPath: testDir },
          dependencies: [],
          priority: 50,
        },
      ],
      metadata: {
        projectPath: testDir,
        requiredFiles: ['hello_jarvis.py'],
        demandsFileCreation: true,
      },
    })

    await orchestrator.queueTask(task.id)
    await orchestrator.tick()

    // File was NEVER created in testDir
    expect(existsSync(join(testDir, 'hello_jarvis.py'))).toBe(false)

    // Poll until settled
    let settled = await orchestrator.getTask(task.id)
    let retries = 0
    while (settled && settled.state !== 'COMPLETED' && settled.state !== 'FAILED' && retries < 20) {
      await new Promise((r) => setTimeout(r, 50))
      settled = await orchestrator.getTask(task.id)
      retries++
    }

    expect(settled?.state).toBe('FAILED')
    expect(settled?.error).toContain('Required file on disk verification failed')
    expect(settled?.error).toContain('hello_jarvis.py')
  })

  it('Scenario 3: File exists with 0 bytes is BLOCKED and marked FAILED', async () => {
    const store = new TaskStore(new MemoryTaskStorage())
    const orchestrator = new PersistentTaskOrchestrator({ store })

    // Create empty file (0 bytes)
    writeFileSync(join(testDir, 'empty_script.py'), '', 'utf-8')

    orchestrator.setExecutor(async () => ({
      success: true,
      output: {},
      verification: { passed: true, evidence: 'Superficial step pass' },
    }))

    const task = await orchestrator.createTask({
      title: 'Empty File Check',
      objective: 'Create empty_script.py in ' + testDir,
      subtasks: [
        {
          title: 'Mock step',
          capability: 'dev.inspectProject',
          toolId: 'dev.inspectProject',
          payload: { projectPath: testDir },
          dependencies: [],
          priority: 50,
        },
      ],
      metadata: {
        projectPath: testDir,
        requiredFiles: ['empty_script.py'],
        demandsFileCreation: true,
      },
    })

    await orchestrator.queueTask(task.id)
    await orchestrator.tick()

    let settled = await orchestrator.getTask(task.id)
    let retries = 0
    while (settled && settled.state !== 'COMPLETED' && settled.state !== 'FAILED' && retries < 20) {
      await new Promise((r) => setTimeout(r, 50))
      settled = await orchestrator.getTask(task.id)
      retries++
    }

    expect(settled?.state).toBe('FAILED')
    expect(settled?.error).toContain('empty')
  })

  it('Scenario 4: Objective demanded execution but no execution was planned/performed -> FAILED', async () => {
    const store = new TaskStore(new MemoryTaskStorage())
    const orchestrator = new PersistentTaskOrchestrator({ store })

    // Valid file created on disk
    writeFileSync(join(testDir, 'hello.py'), 'print("hello")', 'utf-8')

    orchestrator.setExecutor(async () => ({
      success: true,
      output: {},
      verification: { passed: true, evidence: 'Inspected file ok' },
    }))

    // Subtasks only do inspection, NO execution
    const task = await orchestrator.createTask({
      title: 'Execution Demanded Check',
      objective: 'Create hello.py in ' + testDir + '. Run the file and verify its output.',
      subtasks: [
        {
          title: 'Inspect file',
          capability: 'dev.inspectProject',
          toolId: 'dev.inspectProject',
          payload: { projectPath: testDir, expectedFiles: ['hello.py'] },
          dependencies: [],
          priority: 50,
        },
      ],
      metadata: {
        projectPath: testDir,
        requiredFiles: ['hello.py'],
        demandsFileCreation: true,
        demandsExecution: true,
      },
    })

    await orchestrator.queueTask(task.id)
    await orchestrator.tick()

    let settled = await orchestrator.getTask(task.id)
    let retries = 0
    while (settled && settled.state !== 'COMPLETED' && settled.state !== 'FAILED' && retries < 20) {
      await new Promise((r) => setTimeout(r, 50))
      settled = await orchestrator.getTask(task.id)
      retries++
    }

    expect(settled?.state).toBe('FAILED')
    expect(settled?.error).toContain('no execution subtask was planned or run')
  })

  it('Scenario 5: Execution nonzero exit code blocks task completion', async () => {
    const devEngine = new DevEngine()
    writeFileSync(join(testDir, 'bad_script.py'), 'import sys\nsys.exit(42)\n', 'utf-8')

    const result = await devEngine.runTests(testDir, undefined, 'bad_script.py')
    expect(result.ok).toBe(false)
    expect((result.data as any).exitCode).toBe(42)
    expect(result.error).toBe('tests_failed')
  })

  it('Scenario 6: Execution stdout mismatch fails verification honestly', async () => {
    const devEngine = new DevEngine()
    writeFileSync(join(testDir, 'wrong_output.py'), 'print("Goodbye world")\n', 'utf-8')

    const result = await devEngine.runTests(testDir, undefined, 'wrong_output.py', {
      expectedOutput: 'Hello! JARVIS 4.0',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('output_mismatch')
    expect(result.message).toContain('output did not contain expected text')
    expect((result.data as any).expectedOutputMatched).toBe(false)
  })

  it('Scenario 7: Standalone Python script execution directly runs file and matches output', async () => {
    const devEngine = new DevEngine()
    writeFileSync(
      join(testDir, 'standalone.py'),
      'print("Hello! JARVIS 4.0 autonomous execution is working.")\n',
      'utf-8',
    )

    const result = await devEngine.runTests(testDir, undefined, 'standalone.py', {
      expectedOutput: 'Hello! JARVIS 4.0 autonomous execution is working.',
    })

    expect(result.ok).toBe(true)
    expect((result.data as any).exitCode).toBe(0)
    expect((result.data as any).expectedOutputMatched).toBe(true)
    expect((result.data as any).stdout).toContain('Hello! JARVIS 4.0 autonomous execution is working.')
  })

  it('Scenario 8: Report generator honestly flags missing files and rejects false PASS', async () => {
    const devEngine = new DevEngine()

    // Generate report demanding a file that does NOT exist
    const reportRes = await devEngine.generateReport(testDir, 'Test Report', 'Create missing.py', {
      requiredFiles: ['missing.py'],
      demandsFileCreation: true,
    })

    expect(reportRes.ok).toBe(false)
    expect(reportRes.error).toBe('report_verification_failed')

    const reportContent = readFileSync(join(testDir, 'JARVIS_EXECUTION_REPORT.md'), 'utf-8')
    expect(reportContent).toContain('- Required files on disk: FAIL')
    expect(reportContent).toContain('- **Objective Status:** FAILED / UNVERIFIED')
    expect(reportContent).not.toContain('- Required files on disk: PASS')
  })

  it('Scenario 9: Objective demanding files with empty requiredFiles list is marked FAIL in report', async () => {
    const devEngine = new DevEngine()

    const reportRes = await devEngine.generateReport(testDir, 'Empty Check', 'Create files', {
      requiredFiles: [],
      demandsFileCreation: true,
    })

    expect(reportRes.ok).toBe(false)
    const reportContent = readFileSync(join(testDir, 'JARVIS_EXECUTION_REPORT.md'), 'utf-8')
    expect(reportContent).toContain('FAIL (required files missing)')
    expect(reportContent).toContain('FAILED / UNVERIFIED')
  })

  it('Scenario 10: Complete real pipeline (create -> inspect -> execute -> audit -> report) passes with affirmative proof', async () => {
    const devEngine = new DevEngine()
    const store = new TaskStore(new MemoryTaskStorage())
    const orchestrator = new PersistentTaskOrchestrator({ store })

    // Build real plan for hello_jarvis.py
    const objective =
      'Create a Python file named hello_jarvis.py in ' +
      testDir +
      '. The file must print: Hello! JARVIS 4.0 autonomous execution is working. Run the file, verify its output, and report the exact file path and execution result.'

    const plan = buildDevelopmentPlan(objective, testDir)

    // Hook orchestrator to real DevEngine
    orchestrator.setExecutor(async (subtask, task) => {
      const payload = { ...subtask.payload }
      if (subtask.capability === 'dev.generateReport') {
        const testSub = task.subtasks.find((s) => s.capability === 'dev.runTests')
        payload.evidence = {
          testResults: testSub?.result?.output,
        }
      }
      const res = await devEngine.execute(subtask.capability, payload)
      return {
        success: res.ok,
        output: res.data,
        error: res.ok ? undefined : res.message,
        observation: {
          kind: subtask.capability,
          summary: res.message,
          data: res.data,
        },
        verification: {
          passed: res.ok,
          evidence: res.message,
        },
      }
    })

    const task = await orchestrator.createTask({
      title: 'Create and verify hello_jarvis.py',
      objective,
      subtasks: plan.subtasks,
      metadata: {
        projectPath: testDir,
        requiredFiles: plan.requiredFiles,
        demandsFileCreation: plan.demandsFileCreation,
        demandsExecution: plan.demandsExecution,
        expectedOutput: plan.expectedOutput,
      },
    })

    await orchestrator.queueTask(task.id)
    await orchestrator.tick()

    let settled = await orchestrator.getTask(task.id)
    let retries = 0
    while (settled && settled.state !== 'COMPLETED' && settled.state !== 'FAILED' && retries < 30) {
      await new Promise((r) => setTimeout(r, 100))
      settled = await orchestrator.getTask(task.id)
      retries++
    }

    if (settled?.state !== 'COMPLETED') {
      console.log('SCENARIO 10 FAILED WITH:', settled?.state, settled?.error)
      console.log('SCENARIO 10 SUBTASKS:', settled?.subtasks.map((s) => ({ title: s.title, state: s.state, error: s.result?.error, obs: s.observation?.summary })))
    }

    expect(settled?.state).toBe('COMPLETED')
    expect(existsSync(join(testDir, 'hello_jarvis.py'))).toBe(true)

    const content = readFileSync(join(testDir, 'hello_jarvis.py'), 'utf-8')
    expect(content).toContain('Hello! JARVIS 4.0 autonomous execution is working')

    const reportContent = readFileSync(join(testDir, 'JARVIS_EXECUTION_REPORT.md'), 'utf-8')
    expect(reportContent).toContain('- Required files on disk: PASS')
    expect(reportContent).toContain('- **Objective Status:** VERIFIED')

    const completionEvidence = (settled?.metadata as any)?.completionEvidence
    expect(completionEvidence).toBeDefined()
    expect(completionEvidence.files.length).toBeGreaterThan(0)
    expect(completionEvidence.files[0].path).toBe('hello_jarvis.py')
    expect(completionEvidence.executions[0].passed).toBe(true)
  }, 30000)

  it('Scenario 11: Task cannot be completed on subtask status labels without verification evidence', async () => {
    const store = new TaskStore(new MemoryTaskStorage())
    const orchestrator = new PersistentTaskOrchestrator({ store })

    // Subtask claims success but verification evidence is missing/empty
    orchestrator.setExecutor(async () => ({
      success: true,
      output: {},
      verification: { passed: true, evidence: '   ' }, // empty evidence
    }))

    const task = await orchestrator.createTask({
      title: 'Unproven task',
      objective: 'Inspect project',
      subtasks: [
        {
          title: 'Empty evidence step',
          capability: 'dev.inspectProject',
          toolId: 'dev.inspectProject',
          payload: { projectPath: testDir },
          dependencies: [],
          priority: 50,
        },
      ],
    })

    await orchestrator.queueTask(task.id)
    await orchestrator.tick()

    let settled = await orchestrator.getTask(task.id)
    let retries = 0
    while (settled && settled.state !== 'COMPLETED' && settled.state !== 'FAILED' && retries < 20) {
      await new Promise((r) => setTimeout(r, 50))
      settled = await orchestrator.getTask(task.id)
      retries++
    }

    expect(['FAILED', 'RECOVERY_REQUIRED']).toContain(settled?.state)
    expect(settled?.state).not.toBe('COMPLETED')
  })

  it('Scenario 12: Interrupted task recovered preserves actual evidence and only completes with full proof', async () => {
    const store = new TaskStore(new MemoryTaskStorage())
    const orchestrator = new PersistentTaskOrchestrator({ store })

    // Simulate task interrupted halfway
    const task = await orchestrator.createTask({
      title: 'Interrupted task',
      objective: 'Create file in ' + testDir,
      subtasks: [
        {
          title: 'Step 1',
          capability: 'dev.inspectProject',
          toolId: 'dev.inspectProject',
          payload: { projectPath: testDir },
          dependencies: [],
          priority: 50,
        },
        {
          title: 'Step 2',
          capability: 'dev.patchFile',
          toolId: 'dev.patchFile',
          payload: { projectPath: testDir, filePath: 'real.txt' },
          dependencies: ['step-1'],
          priority: 50,
        },
      ],
    })

    task.state = 'EXECUTING'
    task.subtasks[0].state = 'VERIFIED'
    task.subtasks[0].verification = { passed: true, evidence: 'Step 1 verified', timestamp: Date.now() }
    task.subtasks[1].state = 'EXECUTING' // interrupted during execution
    await store.saveTask(task)

    const recovered = await orchestrator.recoverUnfinishedTasks()
    expect(recovered.length).toBe(1)
    expect(recovered[0].state).toBe('QUEUED')

    // Step 1 preserved because it had valid verification evidence
    expect(recovered[0].subtasks[0].state).toBe('VERIFIED')
    // Step 2 was rolled back to READY/PENDING to ensure it is re-executed
    expect(['READY', 'PENDING']).toContain(recovered[0].subtasks[1].state)
  })
})
