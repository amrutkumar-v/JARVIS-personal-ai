import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { RemoteProvider } from '../providers/RemoteProvider'
import { ProviderError } from '../providers/ProviderError'
import { resetAiConfigCache } from '../../config/ai'
import type { AIRequest, ToolDefinition } from '../provider'

/**
 * Configure the remote provider from env. Because `getAiConfig()` caches once,
 * every env mutation below is followed by `resetAiConfigCache()` so the next
 * provider method re-reads the intended configuration.
 */
const ENV = import.meta.env as Record<string, string | undefined>

function setRemoteConfig(overrides: Record<string, string | undefined> = {}): void {
  ENV.VITE_JARVIS_AI_MODEL = 'test-model'
  ENV.VITE_JARVIS_AI_BASE_URL = 'https://ai.example.com/v1'
  ENV.JARVIS_API_KEY = 'test-key'
  delete ENV.VITE_JARVIS_AI_PROXY_URL
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete ENV[k]
    else ENV[k] = v
  }
  resetAiConfigCache()
}

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).fetch = vi.fn()
})

function mockFetchResponse(status: number, body: unknown): void {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response)
}

function callTrace(): unknown[] {
  return (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
}

function req(toolDefinitions: ToolDefinition[] = []): AIRequest {
  return {
    prompt: 'hello',
    messages: [{ role: 'user', content: 'hello' }],
    context: [],
    availableTools: toolDefinitions.map((d) => d.id),
    toolDefinitions,
    isNewSession: false,
  }
}

describe('RemoteProvider', () => {
  it('is configured when model + direct endpoint are present', () => {
    setRemoteConfig()
    expect(new RemoteProvider().isConfigured()).toBe(true)
  })

  it('is NOT configured when no endpoint/model exist (mock is the honest default)', () => {
    setRemoteConfig({ VITE_JARVIS_AI_BASE_URL: undefined, VITE_JARVIS_AI_MODEL: undefined, VITE_JARVIS_AI_PROXY_URL: undefined, JARVIS_API_KEY: undefined })
    expect(new RemoteProvider().isConfigured()).toBe(false)
  })

  it('is configured when a same-origin proxy path + model are present', () => {
    setRemoteConfig({ VITE_JARVIS_AI_BASE_URL: undefined, VITE_JARVIS_AI_PROXY_URL: '/api/ai', JARVIS_API_KEY: undefined })
    expect(new RemoteProvider().isConfigured()).toBe(true)
  })

  it('posts an OpenAI-compatible request with tool definitions', async () => {
    setRemoteConfig()
    const toolDef: ToolDefinition = {
      id: 'calculator',
      description: 'do math',
      parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
    }
    mockFetchResponse(200, {
      choices: [{ message: { role: 'assistant', content: 'That computes to 42.' } }],
    })
    const res = await new RemoteProvider().generate(req([toolDef]), () => {})

    expect(res.text).toBe('That computes to 42.')
    const [url, init] = callTrace()[0] as [string, RequestInit]
    expect(url).toBe('https://ai.example.com/v1/chat/completions')
    const body = JSON.parse(init.body as string)
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0].function.name).toBe('calculator')
    expect(body.model).toBe('test-model')
  })

  it('attaches an Authorization header when a key is available in-direct', async () => {
    setRemoteConfig()
    mockFetchResponse(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] })
    await new RemoteProvider().generate(req([]), () => {})
    const [, init] = callTrace()[0] as [string, RequestInit]
    const headers = new Headers(init.headers as HeadersInit)
    expect(headers.get('Authorization')).toBe('Bearer test-key')
  })

  it('makes a KEYLESS direct request when no key is visible (local endpoints)', async () => {
    setRemoteConfig({ JARVIS_API_KEY: undefined })
    mockFetchResponse(200, { choices: [{ message: { role: 'assistant', content: 'keyless ok' } }] })
    const res = await new RemoteProvider().generate(req([]), () => {})
    expect(res.text).toBe('keyless ok')
    const [, init] = callTrace()[0] as [string, RequestInit]
    const headers = new Headers(init.headers as HeadersInit)
    expect(headers.has('Authorization')).toBe(false)
  })

  it('surfaces auth rejection honestly when a direct endpoint needs a key but none is configured', async () => {
    setRemoteConfig({ JARVIS_API_KEY: undefined })
    mockFetchResponse(401, { error: { message: 'missing api key' } })
    await expect(new RemoteProvider().generate(req([]), () => {})).rejects.toBeInstanceOf(ProviderError)
    await expect(new RemoteProvider().generate(req([]), () => {})).rejects.toMatchObject({ kind: 'auth' })
  })

  it('throws a config error when not configured, refusing to fake an answer', async () => {
    setRemoteConfig({ VITE_JARVIS_AI_BASE_URL: undefined, VITE_JARVIS_AI_MODEL: undefined, VITE_JARVIS_AI_PROXY_URL: undefined })
    await expect(new RemoteProvider().generate(req([]), () => {})).rejects.toMatchObject({ kind: 'config' })
  })

  it('returns structured tool requests when the model calls a tool', async () => {
    setRemoteConfig()
    mockFetchResponse(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call-1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"6*7"}' } },
            ],
          },
        },
      ],
    })
    const res = await new RemoteProvider().generate(req([]), () => {})
    expect(res.toolRequests).toHaveLength(1)
    expect(res.toolRequests![0].toolId).toBe('calculator')
    expect(res.toolRequests![0].payload).toEqual({ expression: '6*7' })
  })

  it('maps auth failures to a user-safe ProviderError', async () => {
    setRemoteConfig()
    mockFetchResponse(401, { error: { message: 'bad key' } })
    await expect(new RemoteProvider().generate(req([]), () => {})).rejects.toBeInstanceOf(ProviderError)
    await expect(new RemoteProvider().generate(req([]), () => {})).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps rate limiting to a clear kind', async () => {
    setRemoteConfig()
    mockFetchResponse(429, { error: { message: 'slow down' } })
    await expect(new RemoteProvider().generate(req([]), () => {})).rejects.toMatchObject({
      kind: 'rate_limit',
    })
  })

  it('reports network failure instead of crashing the caller', async () => {
    setRemoteConfig()
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TypeError('failed to connect'),
    )
    await expect(new RemoteProvider().generate(req([]), () => {})).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('routes through a same-origin proxy without shipping the key', async () => {
    setRemoteConfig({ VITE_JARVIS_AI_BASE_URL: undefined, VITE_JARVIS_AI_PROXY_URL: '/api/ai', JARVIS_API_KEY: undefined })
    mockFetchResponse(200, {
      choices: [{ message: { role: 'assistant', content: 'via proxy' } }],
    })
    const res = await new RemoteProvider().generate(req([]), () => {})
    expect(res.text).toBe('via proxy')
    const [url, init] = callTrace()[0] as [string, RequestInit]
    expect(url).toBe('/api/ai/chat/completions')
    const headers = new Headers(init.headers as HeadersInit)
    expect(headers.has('Authorization')).toBe(false)
  })

  it('exposes describe() info for the settings panel', () => {
    setRemoteConfig()
    expect(new RemoteProvider().describe()).toMatchObject({ model: 'test-model', baseUrl: 'https://ai.example.com/v1' })
  })
})

describe('RemoteProvider — real local model discovery (listModels / isModelAvailable)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Advance past the bounded discovery window without hanging the run. */
  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(5_000)
  }

  it('discovers REAL models from a reachable Ollama /api/tags route', async () => {
    setRemoteConfig({ VITE_JARVIS_AI_BASE_URL: 'http://127.0.0.1:11434/v1' })
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/tags')) {
        return { ok: true, status: 200, json: async () => ({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:latest' }] }) } as Response
      }
      throw new TypeError('unexpected route')
    })
    const pending = new RemoteProvider().listModels()
    const promise = Promise.race([pending, settle().then(() => pending)])
    await expect(promise).resolves.toEqual(['llama3.2:latest', 'qwen3:8b'])
    const [url, init] = callTrace()[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:11434/api/tags')
    expect(new Headers(init.headers as HeadersInit).has('Authorization')).toBe(false)
  })

  it('discovers REAL models from LM Studio via the OpenAI /models route', async () => {
    setRemoteConfig({ VITE_JARVIS_AI_BASE_URL: 'http://127.0.0.1:1234/v1' })
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/tags')) return { ok: false, status: 404 } as Response
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'qwen2.5-7b-instruct' }] }) } as Response
      }
      throw new TypeError('unexpected route')
    })
    const pending = new RemoteProvider().listModels()
    await expect(Promise.race([pending, settle().then(() => pending)])).resolves.toEqual(['qwen2.5-7b-instruct'])
  })

  it('returns [] when both routes answer 200 with NO models (empty is honest, not fabricated)', async () => {
    setRemoteConfig()
    mockFetchResponse(200, { data: [] })
    const pending = new RemoteProvider().listModels()
    await expect(Promise.race([pending, settle().then(() => pending)])).resolves.toEqual([])
  })

  it('returns [] when the endpoint is unreachable (never throws, never fakes)', async () => {
    setRemoteConfig()
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError('failed to connect'))
    const pending = new RemoteProvider().listModels()
    await expect(Promise.race([pending, settle().then(() => pending)])).resolves.toEqual([])
  })

  it('returns [] when the endpoint answers with a malformed payload', async () => {
    setRemoteConfig()
    mockFetchResponse(200, { unexpected: 'shape' })
    const pending = new RemoteProvider().listModels()
    await expect(Promise.race([pending, settle().then(() => pending)])).resolves.toEqual([])
  })

  it('returns [] in proxy mode — the client cannot truthfully inspect models through the proxy', async () => {
    setRemoteConfig({ VITE_JARVIS_AI_BASE_URL: undefined, VITE_JARVIS_AI_PROXY_URL: '/api/ai', JARVIS_API_KEY: undefined })
    const pending = new RemoteProvider().listModels()
    await expect(pending).resolves.toEqual([])
    expect(callTrace()).toHaveLength(0)
  })

  it('isModelAvailable is TRUE only when a real probe saw the model', async () => {
    setRemoteConfig({ VITE_JARVIS_AI_BASE_URL: 'http://127.0.0.1:11434' })
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/tags')) {
        return { ok: true, status: 200, json: async () => ({ models: ['qwen3:8b'] }) } as Response
      }
      throw new TypeError('unexpected route')
    })
    const pending = new RemoteProvider().isModelAvailable('qwen3:8b')
    await expect(Promise.race([pending, settle().then(() => pending)])).resolves.toBe(true)
  })

  it('isModelAvailable is FALSE when the probe ran but the model was absent (or nothing was verified)', async () => {
    setRemoteConfig({ VITE_JARVIS_AI_BASE_URL: 'http://127.0.0.1:11434' })
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/tags')) {
        return { ok: true, status: 200, json: async () => ({ models: ['llama3.2:latest'] }) } as Response
      }
      throw new TypeError('unexpected route')
    })
    const pending = new RemoteProvider().isModelAvailable('qwen3:8b')
    await expect(Promise.race([pending, settle().then(() => pending)])).resolves.toBe(false)
  })
})