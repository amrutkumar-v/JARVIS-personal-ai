import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AssistantEngine } from '../../src/engine/AssistantEngine'
import { MemoryTaskStorage } from '../../src/engine/tasks/TaskStore'
import { MemoryProjectContextStorage } from '../../src/memory/projectContext'
import { DevEngine } from '../../server/src/dev/DevEngine.js'
import { setGlobalDevExecutor } from '../../src/engine/dev/DevTools'
import { useConversationStore } from '../../src/state/conversation.store'

function stubBrowserStorage(): void {
  const store: Record<string, string> = {}
  const localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = String(value)
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k]
    },
    get length() {
      return Object.keys(store).length
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  }
  ;(globalThis as Record<string, unknown>).window = {
    localStorage,
    setTimeout: (_fn: () => void) => 0,
  }
}

describe('Workflow C — Autonomous Software Engineering: Expense Tracker', () => {
  const testDir = 'D:\\JARVIS-Test\\JARVIS-3.2'

  beforeAll(() => {
    stubBrowserStorage()
    mkdirSync(testDir, { recursive: true })
    for (const f of ['expense_tracker.py', 'test_expense_tracker.py', 'JARVIS_EXECUTION_REPORT.md', '__pycache__']) {
      try { rmSync(join(testDir, f), { recursive: true, force: true }) } catch {}
    }
  })

  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    setGlobalDevExecutor((action, params) => new DevEngine().execute(action, params))
  })

  afterEach(() => {
    setGlobalDevExecutor(null)
  })

  it('plans and executes full autonomous expense tracker creation, tests, and report in D:\\JARVIS-Test\\JARVIS-3.2', async () => {
    const taskStorage = new MemoryTaskStorage()
    const projectStorage = new MemoryProjectContextStorage()
    const engine = new AssistantEngine({
      taskStorage,
      projectContextStorage: projectStorage,
    })

    const command =
      'Inspect D:\\JARVIS-Test\\JARVIS-3.2. Create a working Python application for tracking expenses, add tests, run it, verify the results, and generate a completion report.'
    
    await engine.process(command)

    const tasks = await engine.getPersistentTasks()
    expect(tasks.length).toBeGreaterThan(0)
    const task = tasks[0]

    expect(task.objective).toContain('JARVIS-3.2')
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

    // Verify subtask titles reflect expense tracker creation
    expect(task.subtasks[3].title).toContain('expense_tracker.py')
    expect(task.subtasks[4].title).toContain('test_expense_tracker.py')
    expect(task.subtasks[5].title).toContain('Python Test Suite')

    // Run execution through orchestrator
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
    orchestrator.stop()

    const currentTask = await orchestrator.getTask(task.id)
    expect(currentTask?.state).toBe('COMPLETED')

    // 1. Verify files exist on disk
    const implFile = join(testDir, 'expense_tracker.py')
    const testFile = join(testDir, 'test_expense_tracker.py')
    const reportFile = join(testDir, 'JARVIS_EXECUTION_REPORT.md')

    expect(existsSync(implFile), 'expense_tracker.py must exist').toBe(true)
    expect(existsSync(testFile), 'test_expense_tracker.py must exist').toBe(true)
    expect(existsSync(reportFile), 'JARVIS_EXECUTION_REPORT.md must exist').toBe(true)

    // 2. Verify content of implementation
    const implContent = readFileSync(implFile, 'utf-8')
    expect(implContent).toContain('class ExpenseTracker:')
    expect(implContent).toContain('def add_expense(')
    expect(implContent).toContain('def get_total(')
    expect(implContent).toContain('def save_to_json(')

    // 3. Verify execution report evidence
    const reportContent = readFileSync(reportFile, 'utf-8')
    expect(reportContent).toContain('JARVIS Execution Report')
    expect(reportContent).toContain('expense_tracker.py')
    expect(reportContent).toContain('test_expense_tracker.py')
    expect(reportContent.toLowerCase()).toContain('sha256')
  }, 35_000)
})
