import { describe, expect, it, afterEach } from 'vitest'
import { FileTaskStorage, TaskStore } from '../../../server/src/tasks/TaskStore.js'
import type { PersistentTask } from '../../../server/src/tasks/types.js'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

describe('FileTaskStorage (Phase B Disk Persistence)', () => {
  const testDir = join(process.cwd(), '.freebuff', 'test-task-storage')

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('persists tasks to disk and reads them back across storage instances', async () => {
    const storage1 = new FileTaskStorage(testDir)
    const store1 = new TaskStore(storage1)

    const task: PersistentTask = {
      id: 'task-disk-1',
      title: 'Persistent Disk Test',
      objective: 'Verify persistence survives reboot',
      priority: 75,
      state: 'EXECUTING',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      subtasks: [
        {
          id: 'subtask-1',
          taskId: 'task-disk-1',
          stepIndex: 0,
          title: 'Step 1',
          description: 'Desc 1',
          capability: 'file.read',
          toolId: 'file.read',
          payload: {},
          priority: 50,
          dependencies: [],
          state: 'VERIFIED',
          retries: 0,
          maxRetries: 2,
        },
      ],
      checkpoints: [
        {
          checkpointId: 'cp-1',
          taskId: 'task-disk-1',
          timestamp: Date.now(),
          state: 'EXECUTING',
          subtaskIndex: 0,
          completedSubtaskIds: ['subtask-1'],
          verifiedArtifacts: { file: 'data.txt' },
          summary: 'Read file verified',
          executionStateHash: 'hash-disk-1',
        },
      ],
      requiredApprovals: [],
      logs: [],
      recoveryCount: 0,
      maxRecoveries: 3,
      lastHeartbeatAt: Date.now(),
      tags: ['disk-test'],
      metadata: {},
    }

    await store1.saveTask(task)

    // Simulate new process / server instance reading from the same directory
    const storage2 = new FileTaskStorage(testDir)
    const store2 = new TaskStore(storage2)

    const loaded = await store2.getTask('task-disk-1')
    expect(loaded).not.toBeNull()
    expect(loaded?.id).toBe('task-disk-1')
    expect(loaded?.state).toBe('EXECUTING')
    expect(loaded?.subtasks[0].state).toBe('VERIFIED')
    expect(loaded?.checkpoints[0].checkpointId).toBe('cp-1')

    const list = await store2.listTasks({ tags: ['disk-test'] })
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('task-disk-1')
  })
})

