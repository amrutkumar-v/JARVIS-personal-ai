/**
 * Phase 3.0 — Task Context
 *
 * Short-term context for follow-up resolution and deictic references.
 * Separate from long-term memory.
 */

export interface TaskContext {
  taskId?: string
  lastPlan?: {
    id: string
    goal: string
    steps: Array<{ id: string; capability: string; description: string; targetDevice?: string }>
  }
  lastResult?: {
    artifacts: string[]
    stepResults: Array<{ stepId: string; success: boolean; toolResult?: { data?: unknown }; observations?: string[] }>
  }
  artifacts: Array<{
    id: string
    type: 'file' | 'url' | 'text' | 'file_ref'
    description: string
    value: string
    deviceId?: string
    timestamp: number
  }>
  entities: Array<{
    id: string
    type: 'file' | 'device' | 'url' | 'text' | 'search_result'
    description: string
    value: string
    timestamp: number
  }>
  lastUserRequest?: string
  lastAssistantResponse?: string
  updatedAt: number
}

/**
 * In-memory task context store.
 */
export class TaskContextStore {
  private context: TaskContext = {
    artifacts: [],
    entities: [],
    updatedAt: Date.now(),
  }

  private maxArtifacts = 20
  private maxEntities = 50

  /** Update the task context with a new plan/result. */
  updateFromPlan(plan: {
    id: string
    goal: string
    steps: Array<{ id: string; capability: string; description: string; targetDevice?: string }>
  }, result?: {
    artifacts: string[]
    stepResults: Array<{ stepId: string; success: boolean; toolResult?: { data?: unknown }; observations?: string[] }>
  }): void {
    this.context.taskId = plan.id
    this.context.lastPlan = plan as any

    if (result) {
      this.context.lastResult = result as any

      // Extract artifacts from step results
      for (const stepResult of result.stepResults) {
        if (stepResult.toolResult?.data) {
          this.addArtifact({
            id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: this.inferArtifactType(stepResult.toolResult?.data),
            description: `Result from step ${stepResult.stepId}`,
            value: JSON.stringify(stepResult.toolResult.data).slice(0, 1000),
            timestamp: Date.now(),
          })
        }
        if (stepResult.observations) {
          for (const obs of stepResult.observations) {
            this.addArtifact({
              id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: 'text',
              description: 'Observation',
              value: obs,
              timestamp: Date.now(),
            })
          }
        }
      }
    }

    this.context.updatedAt = Date.now()
  }

  /** Add an artifact to the context. */
  addArtifact(artifact: {
    id: string
    type: 'file' | 'url' | 'text' | 'file_ref'
    description: string
    value: string
    deviceId?: string
    timestamp: number
  }): void {
    this.context.artifacts.unshift(artifact)
    if (this.context.artifacts.length > this.maxArtifacts) {
      this.context.artifacts = this.context.artifacts.slice(0, this.maxArtifacts)
    }
  }

  /** Add an entity reference. */
  addEntity(entity: {
    id: string
    type: 'file' | 'device' | 'url' | 'text' | 'search_result'
    description: string
    value: string
    timestamp: number
  }): void {
    this.context.entities.unshift(entity)
    if (this.context.entities.length > this.maxEntities) {
      this.context.entities = this.context.entities.slice(0, this.maxEntities)
    }
  }

  /** Set the last user request. */
  setLastUserRequest(request: string): void {
    this.context.lastUserRequest = request
    this.context.updatedAt = Date.now()
  }

  /** Set the last assistant response. */
  setLastAssistantResponse(response: string): void {
    this.context.lastAssistantResponse = response
    this.context.updatedAt = Date.now()
  }

  /** Get the current context. */
  getContext(): {
    taskId?: string
    lastPlan?: {
      id: string
      goal: string
      steps: Array<{ id: string; capability: string; description: string; targetDevice?: string }>
    }
    lastResult?: {
      artifacts: string[]
      stepResults: Array<{ stepId: string; success: boolean; toolResult?: { data?: unknown }; observations?: string[] }>
    }
    artifacts: Array<{
      id: string
      type: 'file' | 'url' | 'text' | 'file_ref'
      description: string
      value: string
      deviceId?: string
      timestamp: number
    }>
    entities: Array<{
      id: string
      type: 'file' | 'device' | 'url' | 'text' | 'search_result'
      description: string
      value: string
      timestamp: number
    }>
    lastUserRequest?: string
    lastAssistantResponse?: string
    updatedAt: number
  } {
    return { ...this.context }
  }

  /** Get artifacts matching a type. */
  getArtifactsByType(type: 'file' | 'url' | 'text' | 'file_ref'): Array<{
    id: string
    type: 'file' | 'url' | 'text' | 'file_ref'
    description: string
    value: string
    deviceId?: string
    timestamp: number
  }> {
    return this.context.artifacts.filter(a => a.type === type)
  }

  /** Get the most recent artifact. */
  getLatestArtifact(): { id: string; type: 'file' | 'url' | 'text' | 'file_ref'; description: string; value: string; deviceId?: string; timestamp: number } | undefined {
    return this.context.artifacts[0]
  }

  /** Get the most recent entity. */
  getLatestEntity(): { id: string; type: 'file' | 'device' | 'url' | 'text' | 'search_result'; description: string; value: string; timestamp: number } | undefined {
    return this.context.entities[0]
  }

  /** Find an artifact by description or value. */
  findArtifact(query: string): { id: string; type: 'file' | 'url' | 'text' | 'file_ref'; description: string; value: string; deviceId?: string; timestamp: number } | undefined {
    const lower = query.toLowerCase()
    return this.context.artifacts.find(a =>
      a.description.toLowerCase().includes(lower) ||
      a.value.toLowerCase().includes(lower)
    )
  }

  /** Find an entity by description or value. */
  findEntity(query: string): { id: string; type: 'file' | 'device' | 'url' | 'text' | 'search_result'; description: string; value: string; timestamp: number } | undefined {
    const lower = query.toLowerCase()
    return this.context.entities.find(e =>
      e.description.toLowerCase().includes(lower) ||
      e.value.toLowerCase().includes(lower)
    )
  }

  /** Resolve a deictic reference (it, that, the file, etc.). */
  resolveReference(reference: string): {
    resolved: boolean
    artifact?: { id: string; type: string; description: string; value: string }
    entity?: { id: string; type: string; description: string; value: string }
    ambiguity?: string[]
  } {
    const lower = reference.toLowerCase().trim()

    // "it" or "that" - use latest artifact
    if (['it', 'that', 'this', 'the file', 'the result', 'the download'].includes(lower)) {
      const artifact = this.context.artifacts[0]
      if (artifact) {
        return { resolved: true, artifact }
      }
      return { resolved: false, ambiguity: ['No recent artifact to reference'] }
    }

    // "them" or "those" - multiple artifacts
    if (['them', 'those', 'the files', 'the results'].includes(lower)) {
      if (this.context.artifacts.length > 1) {
        return { resolved: true, ambiguity: this.context.artifacts.slice(0, 5).map(a => a.description) }
      }
      return { resolved: false, ambiguity: ['No multiple artifacts to reference'] }
    }

    // Search by description
    const found = this.findArtifact(reference)
    if (found) return { resolved: true, artifact: found }

    // Search entities
    const entity = this.findEntity(reference)
    if (entity) return { resolved: true, entity }

    return { resolved: false, ambiguity: ['Could not resolve reference'] }
  }

  /** Clear context (e.g., on new unrelated task). */
  clear(): void {
    this.context = {
      artifacts: [],
      entities: [],
      updatedAt: Date.now(),
    }
  }

  /** Get a summary for debugging. */
  getSummary(): string {
    return `TaskContext: ${this.context.artifacts.length} artifacts, ${this.context.entities.length} entities, last updated ${new Date(this.context.updatedAt).toLocaleTimeString()}`
  }

  /** Infer artifact type from data. */
  private inferArtifactType(data: unknown): 'file' | 'url' | 'text' | 'file_ref' {
    if (!data) return 'text'
    const str = String(data)
    if (str.startsWith('http://') || str.startsWith('https://')) return 'url'
    if (str.includes('\n') || str.length > 500) return 'text'
    if (str.match(/\.(pdf|txt|docx?|png|jpe?g|gif|zip|md|csv|json|xml)$/i)) return 'file'
    return 'text'
  }
}

/**
 * Singleton instance.
 */
let taskContextStoreInstance: TaskContextStore | null = null

export function getTaskContextStore(): TaskContextStore {
  if (!taskContextStoreInstance) {
    taskContextStoreInstance = new TaskContextStore()
  }
  return taskContextStoreInstance
}

/**
 * Resolve a deictic reference in a user request.
 */
export function resolveDeicticReference(
  text: string,
  contextStore: TaskContextStore
): { resolved: boolean; value?: string; description?: string } {
  // Common deictic patterns
  const patterns = [
    { pattern: /\b(it|that|this)\b/i, type: 'latest' },
    { pattern: /\b(the file|the result|the download|the output)\b/i, type: 'latest_artifact' },
    { pattern: /\b(them|those|the files|the results)\b/i, type: 'multiple' },
    { pattern: /\b(the url|the link|the page)\b/i, type: 'latest_url' },
    { pattern: /\b(the text|the content|the snippet)\b/i, type: 'latest_text' },
  ]

  for (const { pattern } of patterns) {
    if (pattern.test(text)) {
      const resolution = contextStore.getContext().artifacts.length > 0
        ? contextStore.getContext().artifacts[0]
        : null

      if (resolution) {
        return {
          resolved: true,
          value: resolution.value,
          description: resolution.description,
        }
      }
    }
  }

  // Check for explicit references
  const entityResolution = contextStore.getContext().entities.find(e =>
    text.toLowerCase().includes(e.description.toLowerCase()) ||
    text.toLowerCase().includes(e.value.toLowerCase())
  )

  if (entityResolution) {
    return {
      resolved: true,
      value: entityResolution.value,
      description: entityResolution.description,
    }
  }

  return { resolved: false }
}

/**
 * Extract entities from a tool result and add to context.
 */
export function extractEntitiesFromResult(
  toolId: string,
  result: { ok: boolean; message: string; data?: unknown },
  contextStore: TaskContextStore
): void {
  if (!result.ok || !result.data) return

  const data = result.data

  // Extract based on tool type
  if (toolId === 'web_search' && typeof data === 'object' && data !== null) {
    const searchResult = data as { results?: Array<{ title: string; url: string; snippet: string }> }
    if (searchResult.results) {
      for (const r of searchResult.results.slice(0, 5)) {
        contextStore.addEntity({
          id: `entity-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'search_result',
          description: r.title,
          value: r.url,
          timestamp: Date.now(),
        })
      }
      // Commit the lead result as a URL artifact so later deictic follow-ups
      // ("Download it.") resolve against a REAL returned URL, never a guess.
      const first = searchResult.results[0]
      if (first?.url) {
        contextStore.addArtifact({
          id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'url',
          description: first.title || 'Web search result',
          value: first.url,
          timestamp: Date.now(),
        })
      }
    }
  } else if (toolId === 'web_fetch' && typeof data === 'object' && data !== null) {
    const fetchResult = data as { title?: string; text: string; finalUrl: string }
    contextStore.addEntity({
      id: `entity-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'url',
      description: fetchResult.title || 'Fetched page',
      value: fetchResult.finalUrl,
      timestamp: Date.now(),
    })
    contextStore.addArtifact({
      id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'text',
      description: 'Fetched page content',
      value: fetchResult.text.slice(0, 2000),
      timestamp: Date.now(),
    })
  } else if (toolId === 'web_download' && typeof data === 'object' && data !== null) {
    const downloadResult = data as { content: string; finalUrl: string; contentType?: string }
    contextStore.addArtifact({
      id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'file',
      description: `Downloaded from ${downloadResult.finalUrl}`,
      value: downloadResult.content.slice(0, 5000),
      timestamp: Date.now(),
    })
  } else if (toolId === 'file_write' && typeof data === 'object' && data !== null) {
    const writeResult = data as { path?: string; bytes?: number }
    if (writeResult.path) {
      contextStore.addArtifact({
        id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'file',
        description: `Written file: ${writeResult.path}`,
        value: writeResult.path,
        timestamp: Date.now(),
      })
    }
  } else if (toolId === 'device_transfer' && typeof data === 'object' && data !== null) {
    const transferResult = data as { file?: { name: string; url: string } }
    if (transferResult.file) {
      contextStore.addArtifact({
        id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'file_ref',
        description: `Sent ${transferResult.file.name} to device`,
        value: transferResult.file.url,
        timestamp: Date.now(),
      })
    }
  }
}