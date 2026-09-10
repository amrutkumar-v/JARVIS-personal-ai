import type { ProviderHealth } from './embeddings'

/**
 * OpenAI-compatible Embedding Provider — Phase 0.6B
 *
 * Uses an OpenAI-compatible embeddings endpoint (e.g., text-embedding-3-small,
 * text-embedding-ada-002, or compatible local models like Ollama, LM Studio, etc.)
 *
 * Reads configuration from the existing AI config system.
 */

interface OpenAIEmbeddingRequest {
  input: string | string[]
  model: string
  dimensions?: number
}

interface OpenAIEmbeddingResponse {
  object: string
  data: Array<{ object: string; embedding: number[]; index: number }>
  model: string
  usage: { prompt_tokens: number; total_tokens: number }
}

async function readEmbeddingConfig(): Promise<{
  baseUrl: string
  model: string
  key: string | null
  dimensions: number
}> {
  const cfg = (await import('../config/ai')).getAiConfig()
  const env = import.meta.env as Record<string, string | undefined>
  
  // Support separate embedding endpoint config
  const proxyUrl = env['VITE_JARVIS_EMBEDDING_PROXY_URL']?.trim() || ''
  const baseUrl = proxyUrl || env['VITE_JARVIS_EMBEDDING_BASE_URL']?.trim() || cfg.baseUrl || ''
  const model = env['VITE_JARVIS_EMBEDDING_MODEL']?.trim() || 'text-embedding-3-small'
  const key = env['JARVIS_API_KEY']?.trim() || null
  
  // Default dimensions for common models
  let dimensions = 1536
  if (model.includes('text-embedding-3-small')) dimensions = 1536
  else if (model.includes('text-embedding-3-large')) dimensions = 3072
  else if (model.includes('text-embedding-ada-002')) dimensions = 1536
  // Allow override via env
  const dimEnv = Number(env['VITE_JARVIS_EMBEDDING_DIMENSIONS'])
  if (Number.isFinite(dimEnv) && dimEnv > 0) dimensions = dimEnv

  return { baseUrl, model, key, dimensions }
}

function resolveEndpoint(baseUrl: string): string {
  if (baseUrl.includes('/embeddings')) return baseUrl
  return `${baseUrl.replace(/\/+$/, '')}/embeddings`
}

export class OpenAIEmbeddingProvider {
  readonly id = 'openai-embeddings'
  readonly label = 'OpenAI-Compatible Embeddings'

  private baseUrl: string = ''
  private model: string = ''
  private key: string | null = null
  private configured = false
  private dimensions_: number = 1536
  private lastError: string | undefined

  get dimensions(): number {
    return this.dimensions_
  }

  private async ensureConfig(): Promise<void> {
    if (this.configured) return
    const cfg = await readEmbeddingConfig()
    this.baseUrl = cfg.baseUrl
    this.model = cfg.model
    this.key = cfg.key
    this.dimensions_ = cfg.dimensions
    this.configured = true
  }

  async embed(text: string): Promise<{ values: readonly number[]; dimensions: number }> {
    await this.ensureConfig()
    if (!this.baseUrl || !this.model) {
      throw new Error('Embedding provider not configured')
    }
    const result = await this.embedBatch([text])
    return result[0]
  }

  async embedBatch(texts: string[]): Promise<Array<{ values: readonly number[]; dimensions: number }>> {
    await this.ensureConfig()
    if (!this.baseUrl || !this.model) {
      throw new Error('Embedding provider not configured')
    }
    if (texts.length === 0) return []

    const url = resolveEndpoint(this.baseUrl)
    const body: OpenAIEmbeddingRequest = {
      input: texts,
      model: this.model,
      dimensions: this.dimensions_,
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.key) headers.Authorization = `Bearer ${this.key}`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)
    
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        if (res.status === 401 || res.status === 403) {
          throw new Error('Embedding service rejected the configured key')
        }
        if (res.status === 429) {
          throw new Error('Embedding service is rate-limited')
        }
        throw new Error(`Embedding service returned HTTP ${res.status}: ${detail.slice(0, 200)}`)
      }

      const json = (await res.json()) as OpenAIEmbeddingResponse
      return json.data.map((d) => ({
        values: d.embedding,
        dimensions: d.embedding.length,
      }))
    } catch (error) {
      clearTimeout(timeout)
      this.lastError = error instanceof Error ? error.message : String(error)
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Embedding request timed out')
      }
      throw error
    }
  }

  isConfigured(): boolean {
    return this.configured && Boolean(this.baseUrl && this.model)
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.ensureConfig()
      if (!this.baseUrl || !this.model) return false
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      try {
        const res = await fetch(this.baseUrl, { method: 'GET', signal: controller.signal })
        return res.status < 500
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return false
    }
  }

  getHealth(): ProviderHealth {
    const reachable = this.baseUrl && this.model
    const configured = this.isConfigured()
    
    let status: ProviderHealth['status'] = 'unknown'
    
    if (!configured) {
      status = 'unhealthy'
    } else if (!reachable) {
      status = 'degraded'
    } else {
      status = 'healthy'
    }

    return {
      configured,
      status,
      providerId: this.id,
      label: this.label,
      model: this.model || 'unknown',
      dimensions: this.dimensions_,
      fallbackActive: false,
      lastError: this.lastError,
      lastCheckedAt: Date.now(),
    }
  }

  /** Get config for debugging/settings UI */
  describe() {
    return { model: this.model, baseUrl: this.baseUrl, dimensions: this.dimensions_ }
  }
}

export const openAIEmbeddingProvider = new OpenAIEmbeddingProvider()