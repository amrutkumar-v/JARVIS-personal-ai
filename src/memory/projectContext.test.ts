import { describe, it, expect, beforeEach } from 'vitest'
import {
  ProjectContextStore,
  MemoryProjectContextStorage,
} from './projectContext'

describe('ProjectContextStore', () => {
  let store: ProjectContextStore

  beforeEach(() => {
    store = new ProjectContextStore(new MemoryProjectContextStorage())
  })

  it('stores and retrieves a project context by id, name, and rootPath', () => {
    store.set({
      projectId: 'proj_hub',
      name: 'ProjectHub',
      rootPath: 'D:/repos/ProjectHub',
      stack: {
        languages: ['TypeScript'],
        frameworks: ['React', 'Node'],
        packageManager: 'npm',
        testRunner: 'vitest',
        hasGit: true,
      },
    })

    expect(store.get('proj_hub')?.name).toBe('ProjectHub')
    expect(store.find('ProjectHub')?.projectId).toBe('proj_hub')
    expect(store.find('projecthub')?.projectId).toBe('proj_hub')
    expect(store.find('D:/repos/ProjectHub')?.projectId).toBe('proj_hub')
  })

  it('records task runs and maintains task history', () => {
    store.recordTaskRun({
      projectIdOrName: 'ProjectHub',
      rootPath: 'D:/repos/ProjectHub',
      taskId: 'task_101',
      taskTitle: 'Fix build errors',
      status: 'EXECUTING',
      checkpointSummary: 'Patched package.json',
      stack: { languages: ['TypeScript'] },
    })

    const ctx = store.find('ProjectHub')
    expect(ctx).not.toBeNull()
    expect(ctx?.lastActiveTaskId).toBe('task_101')
    expect(ctx?.lastCheckpointSummary).toBe('Patched package.json')
    expect(ctx?.history?.length).toBe(1)
    expect(ctx?.history?.[0].status).toBe('EXECUTING')

    // Update with completion
    store.recordTaskRun({
      projectIdOrName: 'ProjectHub',
      rootPath: 'D:/repos/ProjectHub',
      taskId: 'task_101',
      taskTitle: 'Fix build errors',
      status: 'COMPLETED',
      checkpointSummary: 'All tests passing',
    })

    const updated = store.find('ProjectHub')
    expect(updated?.history?.length).toBe(1)
    expect(updated?.history?.[0].status).toBe('COMPLETED')
    expect(updated?.history?.[0].checkpointSummary).toBe('All tests passing')
  })

  it('finds latest active project', () => {
    store.recordTaskRun({
      projectIdOrName: 'ProjectA',
      rootPath: 'D:/repos/ProjectA',
      taskId: 'task_1',
      taskTitle: 'Task 1',
      status: 'COMPLETED',
    })

    store.recordTaskRun({
      projectIdOrName: 'ProjectB',
      rootPath: 'D:/repos/ProjectB',
      taskId: 'task_2',
      taskTitle: 'Task 2',
      status: 'EXECUTING',
    })

    const latest = store.findLatestActiveProject()
    expect(latest?.name).toBe('ProjectB')
  })

  it('removes and clears projects', () => {
    store.set({
      projectId: 'temp_proj',
      name: 'Temp',
      rootPath: 'D:/temp',
    })
    expect(store.list().length).toBe(1)
    expect(store.remove('temp_proj')).toBe(true)
    expect(store.list().length).toBe(0)
  })
})

