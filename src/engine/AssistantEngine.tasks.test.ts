import { describe, it, expect, beforeEach } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import { MemoryTaskStorage } from './tasks/TaskStore'
import { MemoryProjectContextStorage } from '../memory/projectContext'
import { useConversationStore } from '../state/conversation.store'

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

describe('AssistantEngine — Persistent Tasks and Autonomous Dev', () => {
  let engine: AssistantEngine
  let taskStorage: MemoryTaskStorage
  let projectStorage: MemoryProjectContextStorage

  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    taskStorage = new MemoryTaskStorage()
    projectStorage = new MemoryProjectContextStorage()
    engine = new AssistantEngine({
      taskStorage,
      projectContextStorage: projectStorage,
    })
  })

  it('initializes persistent orchestrator and project context store', () => {
    expect(engine.getPersistentOrchestrator()).toBeDefined()
    expect(engine.getProjectContextStore()).toBeDefined()
  })

  it('plans and submits an autonomous development task with subtasks', async () => {
    const task = await engine.planAndSubmitAutonomousTask(
      'Audit and fix missing functionality in ProjectHub',
      'ProjectHub'
    )

    expect(task.id).toMatch(/^task-/)
    expect(task.objective).toBe('Audit and fix missing functionality in ProjectHub')
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
    expect(task.subtasks[0].id).toBeDefined()
    expect(task.subtasks[1].dependencies).toContain(task.subtasks[0].id)
  })

  it('handles natural language command "JARVIS, fix my ProjectHub project"', async () => {
    await engine.process('JARVIS, fix my ProjectHub project. Audit the repository and run tests.')

    const tasks = await engine.getPersistentTasks()
    expect(tasks.length).toBeGreaterThanOrEqual(1)
    const task = tasks[0]
    expect(task.objective).toContain('JARVIS, fix my ProjectHub')
    expect((task.metadata as any)?.projectId).toBe('ProjectHub')
  })

  it('handles continuity request "continue where you stopped"', async () => {
    // Record active project
    engine.getProjectContextStore().recordTaskRun({
      projectIdOrName: 'ProjectHub',
      rootPath: 'D:/repos/ProjectHub',
      taskId: 'task_prev_1',
      taskTitle: 'Previous work',
      status: 'PAUSED',
      checkpointSummary: 'Clean checkpoint created',
    })

    await engine.process('continue where you stopped')
    // Should process without errors
  })

  it('supports pause, resume, and cancel on persistent tasks', async () => {
    const task = await engine.submitPersistentTask({
      title: 'Manual Task',
      objective: 'Do something',
    })

    expect(task.state).toBe('QUEUED')
    const paused = await engine.pausePersistentTask(task.id)
    expect(paused).toBe(true)
    const afterPause = await engine.getPersistentTask(task.id)
    expect(afterPause?.state).toBe('PAUSED')

    const resumed = await engine.resumePersistentTask(task.id)
    expect(resumed).toBe(true)
    const afterResume = await engine.getPersistentTask(task.id)
    expect(afterResume?.state).toBe('QUEUED')

    const cancelled = await engine.cancelPersistentTask(task.id)
    expect(cancelled).toBe(true)
    const afterCancel = await engine.getPersistentTask(task.id)
    expect(afterCancel?.state).toBe('CANCELLED')
  })
})
