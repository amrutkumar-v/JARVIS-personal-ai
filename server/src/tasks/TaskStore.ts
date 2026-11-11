/**
 * TaskStore — Durable Persistent Task Storage (Phase B).
 *
 * Provides atomic, reliable persistence for tasks, subtasks, and checkpoints.
 */

import { copyFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import type {
  PersistentTask,
  TaskCheckpoint,
  TaskFilter,
  TaskStorage,
} from './types.js'

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

export class FileTaskStorage implements TaskStorage {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  private taskFilePath(taskId: string): string {
    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return `${this.dir}/${safeId}.json`
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  async save(task: PersistentTask): Promise<void> {
    await this.ensureDir()
    const filePath = this.taskFilePath(task.id)
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`

    const serialized = JSON.stringify(task, null, 2)
    await writeFile(tempPath, serialized, 'utf-8')
    try {
      await rename(tempPath, filePath)
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === 'EPERM' || code === 'EEXIST' || code === 'EBUSY') {
        await copyFile(tempPath, filePath)
        await unlink(tempPath).catch(() => {})
      } else {
        throw err
      }
    }
  }

  async get(taskId: string): Promise<PersistentTask | null> {
    const filePath = this.taskFilePath(taskId)
    try {
      const content = await readFile(filePath, 'utf-8')
      return JSON.parse(content) as PersistentTask
    } catch {
      return null
    }
  }

  async list(filter?: TaskFilter): Promise<PersistentTask[]> {
    await this.ensureDir()

    let fileNames: string[] = []
    try {
      fileNames = await readdir(this.dir)
    } catch {
      return []
    }

    const tasks: PersistentTask[] = []
    for (const name of fileNames) {
      if (!name.endsWith('.json') || name.includes('.tmp.')) continue
      try {
        const content = await readFile(`${this.dir}/${name}`, 'utf-8')
        const task = JSON.parse(content) as PersistentTask
        if (task && task.id) {
          tasks.push(task)
        }
      } catch {
        // Skip corrupted or unreadable files gracefully
      }
    }

    let result = tasks
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
    const filePath = this.taskFilePath(taskId)
    try {
      await unlink(filePath)
      return true
    } catch {
      return false
    }
  }

  async saveCheckpoint(
    taskId: string,
    checkpoint: TaskCheckpoint,
  ): Promise<void> {
    const task = await this.get(taskId)
    if (!task) return
    task.checkpoints.push(checkpoint)
    task.updatedAt = Date.now()
    await this.save(task)
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

