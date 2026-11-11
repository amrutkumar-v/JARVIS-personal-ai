/**
 * ProjectContextStore — Dedicated storage for project-specific context.
 *
 * Maintains a strict architectural distinction between:
 * - Long-term personal memory (MemoryManager: user profile, preferences, facts)
 * - Project-specific context (ProjectContextStore: repo stack, active tasks, checkpoints)
 * - Conversation history (Chat messages, turn log)
 * - Task execution state (TaskStore, PersistentTaskOrchestrator)
 * - Execution logs (Checkpoints, subtask outputs, audit reports)
 */

export interface ProjectStackInfo {
  languages?: string[]
  frameworks?: string[]
  packageManager?: string
  testRunner?: string
  hasGit?: boolean
  defaultBranch?: string
}

export interface ProjectTaskHistoryEntry {
  taskId: string
  title: string
  status: string
  checkpointSummary?: string
  completedAt?: string
  timestamp: string
}

export interface ProjectContext {
  projectId: string
  name: string
  rootPath: string
  stack?: ProjectStackInfo
  lastActiveTaskId?: string
  lastCheckpointSummary?: string
  lastInspectedAt?: string
  history?: ProjectTaskHistoryEntry[]
  notes?: string[]
  metadata?: Record<string, unknown>
}

export interface ProjectContextStorage {
  load(): Record<string, ProjectContext>
  save(data: Record<string, ProjectContext>): boolean
}

export class MemoryProjectContextStorage implements ProjectContextStorage {
  private data: Record<string, ProjectContext> = {}

  constructor(initialData: Record<string, ProjectContext> = {}) {
    this.data = { ...initialData }
  }

  load(): Record<string, ProjectContext> {
    return { ...this.data }
  }

  save(data: Record<string, ProjectContext>): boolean {
    this.data = { ...data }
    return true
  }
}

export class LocalStorageProjectContextStorage implements ProjectContextStorage {
  private key = 'jarvis.project_context'

  load(): Record<string, ProjectContext> {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return {}
      }
      const raw = window.localStorage.getItem(this.key)
      if (!raw) return {}
      return JSON.parse(raw) as Record<string, ProjectContext>
    } catch {
      return {}
    }
  }

  save(data: Record<string, ProjectContext>): boolean {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return false
      }
      window.localStorage.setItem(this.key, JSON.stringify(data))
      return true
    } catch {
      return false
    }
  }
}

export class ProjectContextStore {
  private storage: ProjectContextStorage
  private cache: Record<string, ProjectContext>

  constructor(storage?: ProjectContextStorage) {
    if (storage) {
      this.storage = storage
    } else if (typeof window !== 'undefined' && window.localStorage) {
      this.storage = new LocalStorageProjectContextStorage()
    } else {
      this.storage = new MemoryProjectContextStorage()
    }
    this.cache = this.storage.load()
  }

  /**
   * Normalize an identifier or name for lookup.
   */
  private normalize(val: string): string {
    return val.trim().toLowerCase().replace(/[/\\]+$/, '')
  }

  /**
   * Find project context by ID, friendly name, or root path.
   */
  find(query: string): ProjectContext | null {
    if (!query || !query.trim()) return null
    const q = this.normalize(query)

    // 1. Direct ID match
    if (this.cache[query]) return this.cache[query]

    // 2. Normalized ID match
    for (const [id, ctx] of Object.entries(this.cache)) {
      if (this.normalize(id) === q) return ctx
    }

    // 3. Name match (case-insensitive)
    for (const ctx of Object.values(this.cache)) {
      if (this.normalize(ctx.name) === q) return ctx
    }

    // 4. Root path match
    for (const ctx of Object.values(this.cache)) {
      if (this.normalize(ctx.rootPath) === q) return ctx
    }

    // 5. Partial name / directory match
    for (const ctx of Object.values(this.cache)) {
      if (this.normalize(ctx.name).includes(q) || q.includes(this.normalize(ctx.name))) {
        return ctx
      }
    }

    return null
  }

  get(projectId: string): ProjectContext | null {
    return this.cache[projectId] ?? null
  }

  set(context: ProjectContext): void {
    this.cache[context.projectId] = {
      ...context,
      history: context.history ?? [],
      notes: context.notes ?? [],
    }
    this.storage.save(this.cache)
  }

  list(): ProjectContext[] {
    return Object.values(this.cache)
  }

  /**
   * Record or update context when an autonomous task runs on a project.
   */
  recordTaskRun(params: {
    projectIdOrName: string
    rootPath: string
    taskId: string
    taskTitle: string
    status: string
    checkpointSummary?: string
    stack?: ProjectStackInfo
  }): ProjectContext {
    let ctx = this.find(params.projectIdOrName) || this.find(params.rootPath)

    if (!ctx) {
      const sanitizedId = params.projectIdOrName
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
      ctx = {
        projectId: sanitizedId || 'project_' + Date.now(),
        name: params.projectIdOrName,
        rootPath: params.rootPath,
        history: [],
        notes: [],
      }
    }

    // Update fields
    ctx.lastActiveTaskId = params.taskId
    ctx.lastCheckpointSummary = params.checkpointSummary ?? ctx.lastCheckpointSummary
    ctx.lastInspectedAt = new Date().toISOString()
    if (params.rootPath) ctx.rootPath = params.rootPath
    if (params.stack) ctx.stack = { ...ctx.stack, ...params.stack }

    // Update history
    ctx.history = ctx.history || []
    const existingEntryIndex = ctx.history.findIndex(h => h.taskId === params.taskId)
    const entry: ProjectTaskHistoryEntry = {
      taskId: params.taskId,
      title: params.taskTitle,
      status: params.status,
      checkpointSummary: params.checkpointSummary,
      timestamp: new Date().toISOString(),
      completedAt: ['COMPLETED', 'FAILED', 'CANCELLED'].includes(params.status)
        ? new Date().toISOString()
        : undefined,
    }

    if (existingEntryIndex >= 0) {
      ctx.history[existingEntryIndex] = entry
    } else {
      ctx.history.unshift(entry)
      if (ctx.history.length > 20) {
        ctx.history = ctx.history.slice(0, 20)
      }
    }

    this.cache[ctx.projectId] = ctx
    this.storage.save(this.cache)
    return ctx
  }

  /**
   * Find the most recently active project.
   */
  findLatestActiveProject(): ProjectContext | null {
    const list = this.list()
    if (list.length === 0) return null

    return list.reduce<ProjectContext | null>((latest, current) => {
      if (!latest) return current
      const latestTime = latest.lastInspectedAt ? new Date(latest.lastInspectedAt).getTime() : 0
      const currTime = current.lastInspectedAt ? new Date(current.lastInspectedAt).getTime() : 0
      return currTime >= latestTime ? current : latest
    }, null)
  }

  remove(projectId: string): boolean {
    if (this.cache[projectId]) {
      delete this.cache[projectId]
      this.storage.save(this.cache)
      return true
    }
    return false
  }

  clear(): void {
    this.cache = {}
    this.storage.save(this.cache)
  }
}

