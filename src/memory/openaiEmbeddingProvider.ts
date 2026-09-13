import type { ProviderHealth } from './embeddings'
import { getAiConfig } from '../config/ai'

/**
 * OpenAI-compatible Embedding Provider — Phase 0.6B
 *
 * Uses an OpenAI-compatible embeddings endpoint (e.g., text-embedding-3-small,
 * text-embedding-ada-002, or compatible local models like Ollama, LM Studio, etc.)
 *
 * Secrets: the provider reuses the AI `JARVIS_API_KEY` placeholder, but a key
 * NEVER reaches a browser bundle (Vite exposes only `VITE_*` env). Configure
 * `VITE_JARVIS_EMBEDDING_PROXY_URL` (same-origin proxy that injects the key
 * server-side) or a keyless local endpoint. If the endpoint rejects auth the
 * failure is surfaced through `getHealth()`/`lastError` and memory degrades to
 * lexical retrieval — it never breaks.
 *
 * Configuration is resolved SYNCHRONOUSLY on every read (`refreshConfig`), so
 * `isConfigured()` is accurate immediately after construction and always
 * reflects the current env — deterministic and observable.
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

export function envString(name: string): string | undefined {
  return (import.meta.env as Record<string, string | undefined>)?.[name]
}

/**
 * True when the user EXPLICITLY declared embedding configuration. Bare AI chat
 * configuration alone does not count — it would otherwise pretend a chat-only
 * endpoint serves real semantic embeddings.
 */
export function isEmbeddingEndpointExplicitlyConfigured(): boolean {
  return Boolean(
    envString('VITE_JARVIS_EMBEDDING_BASE_URL') ||
      envString('VITE_JARVIS_EMBEDDING_PROXY_URL') ||
      envString('VITE_JARVIS_EMBEDDING_MODEL') ||
      envString('VITE_JARVIS_EMBEDDING_DIMENSIONS'),
  )
}

interface ResolvedEmbeddingConfig {
  baseUrl: string
  model: string
  key: string | null
  dimensions: number
  proxyMode: boolean
}

function resolveEmbeddingConfig(): ResolvedEmbeddingConfig {
  const cfg = getAiConfig()

  // Support a separate embeddings endpoint; otherwise fall back to the AI base.
  const proxyUrl = envString('VITE_JARVIS_EMBEDDING_PROXY_URL')?.trim() || ''
  const baseUrl = proxyUrl || envString('VITE_JARVIS_EMBEDDING_BASE_URL')?.trim() || cfg.baseUrl || ''
  const model = envString('VITE_JARVIS_EMBEDDING_MODEL')?.trim() || 'text-embedding-3-small'
  const key = envString('JARVIS_API_KEY')?.trim() || null
  const proxyMode = Boolean(proxyUrl)

  // Default dimensions for common models.
  let dimensions = 1536
  if (model.includes('text-embedding-3-small')) dimensions = 1536
  else if (model.includes('text-embedding-3-large')) dimensions = 3072
  else if (model.includes('text-embedding-ada-002')) dimensions = 1536
  // Allow override via env.
  const dimEnv = envString('VITE_JARVIS_EMBEDDING_DIMENSIONS')
  const parsedDim = Number(dimEnv)
  if (dimEnv && Number.isFinite(parsedDim) && parsedDim > 0) dimensions = parsedDim

  return { baseUrl, model, key, dimensions, proxyMode }
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
  /** Same-origin proxy path — key stays server-side. */
  private proxyMode = false
  private dimensions_: number = 1536
  private lastError: string | undefined

  constructor() {
    this.refreshConfig()
  }

  get dimensions(): number {
    this.refreshConfig()
    return this.dimensions_
  }

  /** Keep the resolved settings current with the (possibly mutated) environment. */
  private refreshConfig(): void {
    const cfg = resolveEmbeddingConfig()
    this.baseUrl = cfg.baseUrl
    this.model = cfg.model
    this.key = cfg.key
    this.proxyMode = cfg.proxyMode
    this.dimensions_ = cfg.dimensions
  }

  private configured(): boolean {
    this.refreshConfig()
    return Boolean(this.baseUrl && this.model)
  }

  async embed(text: string): Promise<{ values: readonly number[]; dimensions: number }> {
    const result = await this.embedBatch([text])
    return result[0]
  }

  async embedBatch(texts: string[]): Promise<Array<{ values: readonly number[]; dimensions: number }>> {
    this.refreshConfig()
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
    // Never ship the key to a browser; in proxy mode the proxy injects it.
    if (this.key && !this.proxyMode) headers.Authorization = `Bearer ${this.key}`

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
          throw new Error('Embedding service rejected the request (authentication failed)')
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
    return this.configured()
  }

  async isReachable(): Promise<boolean> {
    try {
      this.refreshConfig()
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
    this.refreshConfig()
    const configured = this.configured()

    let status: ProviderHealth['status'] = 'unknown'
    if (!configured) {
      status = 'unhealthy'
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

  /** Get config for debugging/settings UI (never exposes the key). */
  describe() {
    this.refreshConfig()
    return { model: this.model, baseUrl: this.baseUrl, dimensions: this.dimensions_ }
  }
}

export const openAIEmbeddingProvider = new OpenAIEmbeddingProvider()