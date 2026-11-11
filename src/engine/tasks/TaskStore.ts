/**
 * TaskStore — Durable Persistent Task Storage (Phase B).
 *
 * Provides atomic, reliable persistence for tasks, subtasks, and checkpoints.
 */

import type {
  PersistentTask,
  TaskCheckpoint,
  TaskFilter,
  TaskStorage,
} from './types'

export class MemoryTaskStorage implements TaskStorage {
  private readonly tasks = new Map<string, PersistentTask>()

  async save(task: PersistentTask): Promise<void> {
    this.tasks.set(task.id, JSON.parse(JSON.stringify(task)))
  }

  async get(taskId: string): Promise<PersistentTask | null> {
    const task = this.tasks.get(taskId)
    if (!task) return null
    return JSON.parse(JSON.stringify(task))
  }

  async list(filter?: TaskFilter): Promise<PersistentTask[]> {
    let result = Array.from(this.tasks.values()).map((t) =>
      JSON.parse(JSON.stringify(t)),
    ) as PersistentTask[]

    if (filter?.states && filter.states.length > 0) {
      const stateSet = new Set(filter.states)
      result = result.filter((t: PersistentTask) => stateSet.has(t.state))
    }

    if (filter?.tags && filter.tags.length > 0) {
      result = result.filter((t: PersistentTask) =>
        filter.tags!.some((tag: string) => t.tags.includes(tag)),
      )
    }

    result.sort((a: PersistentTask, b: PersistentTask) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      return b.createdAt - a.createdAt
    })

    if (filter?.offset && filter.offset > 0) {
      result = result.slice(filter.offset)
    }

    if (filter?.limit && filter.limit > 0) {
      result = result.slice(0, filter.limit)
    }

    return result
  }

  async delete(taskId: string): Promise<boolean> {
    return this.tasks.delete(taskId)
  }

  async saveCheckpoint(
    taskId: string,
    checkpoint: TaskCheckpoint,
  ): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.checkpoints.push(JSON.parse(JSON.stringify(checkpoint)))
    task.updatedAt = Date.now()
  }
}

export class TaskStore {
  private readonly storage: TaskStorage

  constructor(storage?: TaskStorage) {
    this.storage = storage ?? new MemoryTaskStorage()
  }

  getStorage(): TaskStorage {
    return this.storage
  }

  async saveTask(task: PersistentTask): Promise<void> {
    task.updatedAt = Date.now()
    await this.storage.save(task)
  }

  async getTask(taskId: string): Promise<PersistentTask | null> {
    return this.storage.get(taskId)
  }

  async listTasks(filter?: TaskFilter): Promise<PersistentTask[]> {
    return this.storage.list(filter)
  }

  async deleteTask(taskId: string): Promise<boolean> {
    return this.storage.delete(taskId)
  }

  async updateHeartbeat(taskId: string): Promise<void> {
    const task = await this.storage.get(taskId)
    if (!task) return
    task.lastHeartbeatAt = Date.now()
    task.updatedAt = Date.now()
    await this.storage.save(task)
  }

  async addLog(
    taskId: string,
    entry: Omit<PersistentTask['logs'][number], 'id' | 'taskId' | 'timestamp'>,
  ): Promise<void> {
    const task = await this.storage.get(taskId)
    if (!task) return
    const logItem = {
      ...entry,
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      taskId,
      timestamp: Date.now(),
    }
    task.logs.push(logItem)
    task.updatedAt = Date.now()
    await this.storage.save(task)
  }

  async appendCheckpoint(
    taskId: string,
    checkpoint: Omit<TaskCheckpoint, 'checkpointId' | 'taskId' | 'timestamp'>,
  ): Promise<TaskCheckpoint | null> {
    const task = await this.storage.get(taskId)
    if (!task) return null

    const cp: TaskCheckpoint = {
      ...checkpoint,
      checkpointId: `cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      taskId,
      timestamp: Date.now(),
    }

    task.checkpoints.push(cp)
    task.updatedAt = Date.now()
    await this.storage.save(task)
    return cp
  }

  async getActiveTasks(): Promise<PersistentTask[]> {
    return this.storage.list({
      states: [
        'CREATED',
        'PLANNING',
        'VALIDATING',
        'APPROVED',
        'QUEUED',
        'EXECUTING',
        'OBSERVING',
        'VERIFYING',
        'WAITING_FOR_PERMISSION',
        'RECOVERY_REQUIRED',
      ],
    })
  }

  async getCompletedTasks(limit = 20): Promise<PersistentTask[]> {
    return this.storage.list({
      states: ['COMPLETED', 'FAILED', 'CANCELLED'],
      limit,
    })
  }
}
