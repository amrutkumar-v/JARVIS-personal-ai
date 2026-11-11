import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OpenAIEmbeddingProvider,
  openAIEmbeddingProvider,
  isEmbeddingEndpointExplicitlyConfigured,
} from './openaiEmbeddingProvider'
import { resetAiConfigCache } from '../config/ai'

const ENV = import.meta.env as Record<string, string | undefined>

function clearEmbeddingEnv(): void {
  delete ENV.VITE_JARVIS_EMBEDDING_BASE_URL
  delete ENV.VITE_JARVIS_EMBEDDING_PROXY_URL
  delete ENV.VITE_JARVIS_EMBEDDING_MODEL
  delete ENV.VITE_JARVIS_EMBEDDING_DIMENSIONS
  delete ENV.JARVIS_API_KEY
  delete ENV.VITE_JARVIS_AI_BASE_URL
  delete ENV.VITE_JARVIS_AI_MODEL
  resetAiConfigCache()
}

beforeEach(() => {
  clearEmbeddingEnv()
  ;(globalThis as Record<string, unknown>).fetch = vi.fn()
})

afterEach(() => {
  clearEmbeddingEnv()
})

function mockEmbeddingResponse(status: number, body: unknown): void {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response)
}

function setThreeDimensionalTestModel(): void {
  ENV.VITE_JARVIS_EMBEDDING_DIMENSIONS = '3'
}

function embedTrace(): unknown[] {
  return (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
}

const vectorReply = (values: number[]): unknown => ({
  object: 'list',
  data: [{ object: 'embedding', embedding: values, index: 0 }],
  model: 'text-embedding-3-small',
  usage: { prompt_tokens: 1, total_tokens: 1 },
})

describe('OpenAIEmbeddingProvider', () => {
  it('is NOT configured when nothing is declared (deterministic fallback is honest)', () => {
    expect(new OpenAIEmbeddingProvider().isConfigured()).toBe(false)
  })

  it('reports explicit embedding configuration only when declared', () => {
    expect(isEmbeddingEndpointExplicitlyConfigured()).toBe(false)
    ENV.VITE_JARVIS_EMBEDDING_BASE_URL = 'https://emb.example.com/v1'
    expect(isEmbeddingEndpointExplicitlyConfigured()).toBe(true)
  })

  it('is configured exactly when an endpoint + model resolve', () => {
    ENV.VITE_JARVIS_EMBEDDING_BASE_URL = 'https://emb.example.com/v1'
    ENV.VITE_JARVIS_EMBEDDING_MODEL = 'text-embedding-3-small'
    const provider = new OpenAIEmbeddingProvider()
    expect(provider.isConfigured()).toBe(true)
    expect(provider.describe().model).toBe('text-embedding-3-small')
    expect(provider.describe().baseUrl).toBe('https://emb.example.com/v1')
    expect(provider.dimensions).toBe(1536)
  })

  it('attaches the key only when visible and NOT via proxy', async () => {
    ENV.VITE_JARVIS_EMBEDDING_BASE_URL = 'https://emb.example.com/v1'
    ENV.VITE_JARVIS_EMBEDDING_MODEL = 'text-embedding-3-small'
    ENV.JARVIS_API_KEY = 'test-key'
    setThreeDimensionalTestModel()
    mockEmbeddingResponse(200, vectorReply([0.1, 0.2, 0.3]))
    const provider = new OpenAIEmbeddingProvider()
    const vector = await provider.embed('hello')
    expect(vector.values).toEqual([0.1, 0.2, 0.3])
    const [url, init] = embedTrace()[0] as [string, RequestInit]
    expect(url).toBe('https://emb.example.com/v1/embeddings')
    const headers = new Headers(init.headers as HeadersInit)
    expect(headers.get('Authorization')).toBe('Bearer test-key')
  })

  it('routes through a same-origin proxy WITHOUT shipping the key', async () => {
    ENV.VITE_JARVIS_EMBEDDING_PROXY_URL = '/api/ai'
    ENV.VITE_JARVIS_EMBEDDING_MODEL = 'text-embedding-3-small'
    ENV.JARVIS_API_KEY = 'test-key'
    setThreeDimensionalTestModel()
    mockEmbeddingResponse(200, vectorReply([0.1, 0.2, 0.3]))
    const provider = new OpenAIEmbeddingProvider()
    const vector = await provider.embed('hello')
    expect(vector.values).toEqual([0.1, 0.2, 0.3])
    const [url, init] = embedTrace()[0] as [string, RequestInit]
    expect(url).toBe('/api/ai/embeddings')
    const headers = new Headers(init.headers as HeadersInit)
    expect(headers.has('Authorization')).toBe(false)
  })

  it('surfaces auth rejection as a failure (never a silent fake embedding)', async () => {
    ENV.VITE_JARVIS_EMBEDDING_BASE_URL = 'https://emb.example.com/v1'
    ENV.JARVIS_API_KEY = undefined
    mockEmbeddingResponse(401, { error: { message: 'missing api key' } })
    const provider = new OpenAIEmbeddingProvider()
    await expect(provider.embed('hello')).rejects.toThrow(/authentication/)
  })

  it('keeps the singleton accurate against env changes (refreshConfig)', () => {
    ENV.VITE_JARVIS_EMBEDDING_BASE_URL = 'https://emb.example.com/v1'
    expect(openAIEmbeddingProvider.isConfigured()).toBe(true)
    clearEmbeddingEnv()
    expect(openAIEmbeddingProvider.isConfigured()).toBe(false)
  })

  it('domain sanity: only posts to the allow-listed embeddings subpath', async () => {
    ENV.VITE_JARVIS_EMBEDDING_BASE_URL = 'https://emb.example.com/v1/sub'
    ENV.VITE_JARVIS_EMBEDDING_MODEL = 'text-embedding-3-small'
    setThreeDimensionalTestModel()
    mockEmbeddingResponse(200, vectorReply([0.1, 0.2, 0.3]))
    const provider = new OpenAIEmbeddingProvider()
    await provider.embed('x')
    const [url] = embedTrace()[0] as [string, RequestInit]
    expect(url).toBe('https://emb.example.com/v1/sub/embeddings')
  })

  it('does not report semantic embeddings as healthy until a valid vector was returned', async () => {
    ENV.VITE_JARVIS_EMBEDDING_BASE_URL = 'http://127.0.0.1:11434/v1'
    ENV.VITE_JARVIS_EMBEDDING_MODEL = 'embeddinggemma'
    ENV.VITE_JARVIS_EMBEDDING_DIMENSIONS = '3'
    const provider = new OpenAIEmbeddingProvider()
    expect(provider.getHealth().status).toBe('unknown')
    mockEmbeddingResponse(200, vectorReply([0.1, 0.2, 0.3]))
    await provider.embed('hello')
    expect(provider.getHealth().status).toBe('healthy')
  })

  it('keeps embedding health unhealthy when configured dimensions do not match the response', async () => {
    ENV.VITE_JARVIS_EMBEDDING_BASE_URL = 'http://127.0.0.1:11434/v1'
    ENV.VITE_JARVIS_EMBEDDING_MODEL = 'embeddinggemma'
    ENV.VITE_JARVIS_EMBEDDING_DIMENSIONS = '768'
    mockEmbeddingResponse(200, vectorReply([0.1, 0.2, 0.3]))
    const provider = new OpenAIEmbeddingProvider()
    await expect(provider.embed('hello')).rejects.toThrow(/expected 768/)
    expect(provider.getHealth().status).toBe('unhealthy')
  })
})
