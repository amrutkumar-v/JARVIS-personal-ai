import { describe, expect, it, vi, beforeEach } from 'vitest'
import { RemoteProvider } from '../providers/RemoteProvider'
import { ProviderError } from '../providers/ProviderError'
import type { AIRequest, ToolDefinition } from '../provider'

/**
 * Configure the remote provider from env BEFORE any provider method reads the
 * (once-cached) configuration, so every assertion below shares one setup.
 */
const ENV = import.meta.env as Record<string, string | undefined>
ENV.VITE_JARVIS_AI_MODEL = 'test-model'
ENV.VITE_JARVIS_AI_BASE_URL = 'https://ai.example.com/v1'
ENV.JARVIS_API_KEY = 'test-key'

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
  it('is configured when model + endpoint are present', () => {
    expect(new RemoteProvider().isConfigured()).toBe(true)
  })

  it('posts an OpenAI-compatible request with tool definitions', async () => {
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

  it('returns structured tool requests when the model calls a tool', async () => {
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
    mockFetchResponse(401, { error: { message: 'bad key' } })
    await expect(new RemoteProvider().generate(req([]), () => {})).rejects.toBeInstanceOf(ProviderError)
    await expect(new RemoteProvider().generate(req([]), () => {})).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps rate limiting to a clear kind', async () => {
    mockFetchResponse(429, { error: { message: 'slow down' } })
    await expect(new RemoteProvider().generate(req([]), () => {})).rejects.toMatchObject({
      kind: 'rate_limit',
    })
  })

  it('reports network failure instead of crashing the caller', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TypeError('failed to connect'),
    )
    await expect(new RemoteProvider().generate(req([]), () => {})).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('routes through a same-origin proxy without shipping the key', async () => {
    const hadKey = 'JARVIS_API_KEY' in ENV
    const oldKey = ENV.JARVIS_API_KEY
    delete ENV.JARVIS_API_KEY
    ENV.VITE_JARVIS_AI_PROXY_URL = '/api/ai'
    try {
      mockFetchResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'via proxy' } }],
      })
      const res = await new RemoteProvider().generate(req([]), () => {})
      expect(res.text).toBe('via proxy')
      const [url, init] = callTrace()[0] as [string, RequestInit]
      expect(url).toBe('/api/ai/chat/completions')
      const headers = new Headers(init.headers as HeadersInit)
      expect(headers.has('Authorization')).toBe(false)
    } finally {
      if (hadKey) ENV.JARVIS_API_KEY = oldKey
      delete ENV.VITE_JARVIS_AI_PROXY_URL
    }
  })

  it('exposes describe() info for the settings panel', () => {
    expect(new RemoteProvider().describe()).toMatchObject({ model: 'test-model' })
  })
})