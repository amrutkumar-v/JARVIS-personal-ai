import { describe, expect, it, vi } from 'vitest'
import {
  createAiProviderRouter,
  resolveLegacyProxy,
  type AiRouteResult,
  type AiRouterCreateOptions,
} from './aiProvider.js'

const textDecoder = new TextDecoder()

function decodeBody(body: Uint8Array): string {
  return textDecoder.decode(body)
}

function jsonBody(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function resBody(result: AiRouteResult): unknown {
  return JSON.parse(decodeBody(result.body))
}

function fakeResponse(status: number, body: string, contentType = 'application/json'): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: async () => new TextEncoder().encode(body),
  } as unknown as Response
}

function okResponse(body: unknown): Response {
  return fakeResponse(200, typeof body === 'string' ? body : JSON.stringify(body))
}

function bodyOf(init?: RequestInit): unknown {
  return JSON.parse(textDecoder.decode(init?.body as Uint8Array))
}

function makeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): {
  fetchImpl: NonNullable<AiRouterCreateOptions['fetchImpl']>
  calls: ReturnType<typeof vi.fn>
} {
  const fn = vi.fn(handler)
  return { fetchImpl: fn as unknown as NonNullable<AiRouterCreateOptions['fetchImpl']>, calls: fn }
}

function callsAt(fetchImpl: NonNullable<AiRouterCreateOptions['fetchImpl']>, index: number): unknown {
  const mocked = fetchImpl as unknown as { mock?: { calls: unknown[][] } }
  return mocked.mock?.calls[index]?.[0]
}

const CHAT_BODY = jsonBody({
  model: 'client-model',
  messages: [{ role: 'user', content: 'hello' }],
})

const EMBED_BODY = jsonBody({ model: 'client-embed', input: 'hi' })

/** OpenAI-compatible 200 with a chat content reply. */
function chatReply(text: string): Response {
  return okResponse({ choices: [{ message: { role: 'assistant', content: text } }] })
}

describe('aiProvider router — legacy mode (back-compat)', () => {
  it('forwards directly to the Gemini default base with the key when GEMINI_API_KEY is set', async () => {
    const { fetchImpl, calls } = makeFetch(async (url, init) => {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer sk-legacy-key')
      return chatReply('legacy says hi')
    })
    const router = createAiProviderRouter({ env: { GEMINI_API_KEY: 'sk-legacy-key' }, fetchImpl })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(200)
    expect(result.provider).toBe('legacy')
    expect(result.model).toBe('')
    const legacyReply = resBody(result) as { choices: Array<{ message: { content: string } }> }
    expect(legacyReply.choices[0]?.message.content).toBe('legacy says hi')
    expect(calls).toHaveBeenCalledOnce()
  })

  it('uses VITE_JARVIS_AI_PROXY_TARGET as the legacy upstream (dev parity)', async () => {
    const { fetchImpl, calls } = makeFetch(async () => chatReply('local says hi'))
    const router = createAiProviderRouter({
      env: { GEMINI_API_KEY: 'sk-x' },
      legacy: resolveLegacyProxy({ GEMINI_API_KEY: 'sk-x', VITE_JARVIS_AI_PROXY_TARGET: 'http://localhost:11434/v1' }),
      fetchImpl,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(200)
    expect(result.provider).toBe('legacy')
    expect(String(calls.mock.calls[0]?.[0])).toBe('http://localhost:11434/v1/chat/completions')
    expect(calls).toHaveBeenCalledOnce()
  })

  it('keeps the request model in legacy mode (honest passthrough)', async () => {
    let sentBody: unknown = null
    const { fetchImpl } = makeFetch(async (_url, init) => {
      sentBody = bodyOf(init)
      return chatReply('ok')
    })
    const router = createAiProviderRouter({
      env: {},
      legacy: { baseUrl: 'https://example.com/v1', key: 'sk-x', timeoutMs: 10000 },
      fetchImpl,
    })
    await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect((sentBody as { model: string }).model).toBe('client-model')
  })

  it('answers 503 ai_not_configured when nothing is configured', async () => {
    const { fetchImpl, calls } = makeFetch(async () => chatReply('nope'))
    const router = createAiProviderRouter({ env: {}, fetchImpl })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(503)
    expect(result.errorCode).toBe('ai_not_configured')
    expect((resBody(result) as { error: { code: string } }).error.code).toBe('AI_NOT_CONFIGURED')
    expect(calls).not.toHaveBeenCalled()
  })

  it('answers 503 ai_not_configured from an empty body in legacy mode with no keys', async () => {
    const router = createAiProviderRouter({ env: {} })
    const result = await router.route({ subpath: '/chat/completions', body: new Uint8Array() })
    expect(result.status).toBe(503)
    expect(result.errorCode).toBe('ai_not_configured')
  })

  it('answers 400 invalid_body for malformed JSON', async () => {
    const { fetchImpl, calls } = makeFetch(async () => chatReply('nope'))
    const router = createAiProviderRouter({ env: { GEMINI_API_KEY: 'sk-x' }, fetchImpl })
    const result = await router.route({ subpath: '/chat/completions', body: new TextEncoder().encode('{not json') })
    expect(result.status).toBe(400)
    expect(result.errorCode).toBe('invalid_body')
    expect(calls).not.toHaveBeenCalled()
  })
})

describe('aiProvider router — explicit provider mode', () => {
  it('routes chat to the named primary with the default model overridden server-side', async () => {
    let sentBody: unknown = null
    const { fetchImpl, calls } = makeFetch(async (_url, init) => {
      sentBody = bodyOf(init)
      return chatReply('gemini here')
    })
    const router = createAiProviderRouter({ env: { JARVIS_AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'sk-g' }, fetchImpl })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(200)
    expect(result.provider).toBe('gemini')
    expect(result.model).toBe('gemini-3.6-flash')
    expect((sentBody as { model: string }).model).toBe('gemini-3.6-flash')
    expect(String(calls.mock.calls[0]?.[0])).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
    expect(calls).toHaveBeenCalledOnce()
  })

  it('routes a vision request to a vision-capable provider with the vision model', async () => {
    let sentBody: unknown = null
    const visionBody = jsonBody({
      model: 'client-model',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          ],
        },
      ],
    })
    const { fetchImpl } = makeFetch(async (_url, init) => {
      sentBody = bodyOf(init)
      return chatReply('it is a screenshot')
    })
    const router = createAiProviderRouter({ env: { JARVIS_AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'sk-g' }, fetchImpl })
    const result = await router.route({ subpath: '/chat/completions', body: visionBody })
    expect(result.status).toBe(200)
    expect(result.capability).toBe('vision')
    expect(result.provider).toBe('gemini')
    expect(result.model).toBe('gemini-3.6-flash')
    const part = (sentBody as { messages: Array<{ content: Array<{ type: string }> }> }).messages[0]?.content[1]
    expect(part?.type).toBe('image_url')
  })

  it('translates Anthropic chat to the Messages API and back to an OpenAI envelope', async () => {
    let sentUrl: string | undefined
    let sentBody: unknown = null
    const { fetchImpl, calls } = makeFetch(async (url, init) => {
      sentUrl = String(url)
      sentBody = bodyOf(init)
      return okResponse({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'claude here' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 },
      })
    })
    const router = createAiProviderRouter({ env: { JARVIS_AI_PRIMARY_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-anthropic' }, fetchImpl })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(200)
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-sonnet-4-5')
    expect(calls).toHaveBeenCalledOnce()
    expect(sentUrl).toBe('https://api.anthropic.com/v1/messages')

    const callHeaders = new Headers(calls.mock.calls[0]?.[1]?.headers)
    expect(callHeaders.get('x-api-key')).toBe('sk-anthropic')
    expect(callHeaders.get('anthropic-version')).toBeTruthy()
    const payload = sentBody as { model: string; max_tokens: number; system: string; messages: Array<{ role: string; content: unknown }> }
    expect(payload.model).toBe('claude-sonnet-4-5')
    expect(payload.max_tokens).toBe(2048)
    expect(payload.messages).toHaveLength(1)
    expect(payload.messages[0]?.role).toBe('user')

    const reply = resBody(result) as {
      choices: Array<{ message: { content: string } }>
      usage: { prompt_tokens: number; completion_tokens: number }
    }
    expect(reply.choices[0]?.message.content).toBe('claude here')
    expect(reply.usage.prompt_tokens).toBe(5)
    expect(reply.usage.completion_tokens).toBe(3)
  })

  it('answers 503 unsupported_capability when the provider has no embeddings API', async () => {
    const { fetchImpl, calls } = makeFetch(async () => chatReply('nope'))
    const router = createAiProviderRouter({ env: { JARVIS_AI_PRIMARY_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-a' }, fetchImpl })
    const result = await router.route({ subpath: '/embeddings', body: EMBED_BODY })
    expect(result.status).toBe(503)
    expect(result.errorCode).toBe('unsupported_capability')
    expect(calls).not.toHaveBeenCalled()
  })

  it('answers 503 unsupported_capability when the provider cannot do vision', async () => {
    const visionBody = jsonBody({
      model: 'client-model',
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] },
      ],
    })
    const { fetchImpl, calls } = makeFetch(async () => chatReply('nope'))
    const router = createAiProviderRouter({ env: { JARVIS_AI_PRIMARY_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-a' }, fetchImpl })
    const result = await router.route({ subpath: '/chat/completions', body: visionBody })
    expect(result.status).toBe(503)
    expect(result.errorCode).toBe('unsupported_capability')
    expect(calls).not.toHaveBeenCalled()
  })

  it('routes embeddings to a provider with an embeddings API and overrides the model', async () => {
    let sentBody: unknown = null
    const { fetchImpl, calls } = makeFetch(async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/embeddings')
      sentBody = bodyOf(init)
      return okResponse({ data: [{ embedding: [1, 2, 3] }] })
    })
    const router = createAiProviderRouter({ env: { JARVIS_AI_PRIMARY_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-o' }, fetchImpl })
    const result = await router.route({ subpath: '/embeddings', body: EMBED_BODY })
    expect(result.status).toBe(200)
    expect(result.provider).toBe('openai')
    expect(result.capability).toBe('embeddings')
    expect(result.model).toBe('text-embedding-3-small')
    expect((sentBody as { model: string }).model).toBe('text-embedding-3-small')
    expect(calls).toHaveBeenCalledOnce()
  })

  it('pins via the request header and ignores the server primary', async () => {
    const { fetchImpl, calls } = makeFetch(async (url) => {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
      return chatReply('pinned to gemini')
    })
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-o',
        GEMINI_API_KEY: 'sk-g',
      },
      fetchImpl,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY, pinned: 'gemini' })
    expect(result.status).toBe(200)
    expect(result.provider).toBe('gemini')
    expect(calls).toHaveBeenCalledOnce()
  })

  it('honors the server pin when no header pin is present', async () => {
    const { fetchImpl, calls } = makeFetch(async (url) => {
      expect(url).toBe('https://api.openai.com/v1/chat/completions')
      return chatReply('pinned server-side')
    })
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'gemini',
        JARVIS_AI_PINNED_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-o',
        GEMINI_API_KEY: 'sk-g',
      },
      fetchImpl,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(200)
    expect(result.provider).toBe('openai')
    expect(calls).toHaveBeenCalledOnce()
  })

  it('answers 503 provider_not_configured when the pinned provider is not configured', async () => {
    const { fetchImpl, calls } = makeFetch(async () => chatReply('nope'))
    const router = createAiProviderRouter({ env: { JARVIS_AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'sk-g' }, fetchImpl })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY, pinned: 'anthropic' })
    expect(result.status).toBe(503)
    expect(result.errorCode).toBe('provider_not_configured')
    expect(calls).not.toHaveBeenCalled()
  })
})

describe('aiProvider router — failover and error classification', () => {
  it('fails over from a rate-limited primary to the configured fallback', async () => {
    const { fetchImpl, calls } = makeFetch(async (url) => {
      if (url.includes('generativelanguage')) return fakeResponse(429, '{}')
      if (url.includes('api.openai.com')) return chatReply('fallback worked')
      throw new Error(`unexpected url ${url}`)
    })
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'gemini',
        JARVIS_AI_FALLBACK_PROVIDERS: 'openai',
        GEMINI_API_KEY: 'sk-g',
        OPENAI_API_KEY: 'sk-o',
      },
      fetchImpl,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(200)
    expect(result.provider).toBe('openai')
    expect(result.usedFallback).toBe(true)
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('never fails over on a 401 auth rejection', async () => {
    const { fetchImpl, calls } = makeFetch(async () => fakeResponse(401, '{"error":"bad key"}'))
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'gemini',
        JARVIS_AI_FALLBACK_PROVIDERS: 'openai',
        GEMINI_API_KEY: 'sk-bad',
        OPENAI_API_KEY: 'sk-o',
      },
      fetchImpl,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(401)
    expect(result.provider).toBe('gemini')
    expect(result.errorCode).toBeUndefined()
    expect(calls).toHaveBeenCalledOnce()
  })

  it('is strict when pinned: no failover, honest 502 after the single provider answers 5xx', async () => {
    const { fetchImpl, calls } = makeFetch(async () => fakeResponse(500, '{}'))
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'gemini',
        JARVIS_AI_FALLBACK_PROVIDERS: 'openai',
        GEMINI_API_KEY: 'sk-g',
        OPENAI_API_KEY: 'sk-o',
      },
      fetchImpl,
      sleep: async () => undefined,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY, pinned: 'gemini' })
    expect(result.status).toBe(502)
    // The provider ANSWERED (5xx) — it was not unreachable, so the error must
    // not be reported as a transport/network failure.
    expect(result.errorCode).toBe('ai_upstream_error')
    expect(calls).toHaveBeenCalledOnce()
  })

  it('returns 504 ai_upstream_timeout when every candidate timed out', async () => {
    const { fetchImpl, calls } = makeFetch(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'sk-g' },
      fetchImpl,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(504)
    expect(result.errorCode).toBe('ai_upstream_timeout')
    // A timeout already consumed its full budget: it is NEVER retried.
    expect(calls).toHaveBeenCalledOnce()
  })

  it('returns 502 ai_upstream_unreachable when every candidate was unreachable', async () => {
    const { fetchImpl, calls } = makeFetch(async () => {
      throw new TypeError('fetch failed')
    })
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'sk-g' },
      fetchImpl,
      sleep: async () => undefined,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(502)
    expect(result.errorCode).toBe('ai_upstream_unreachable')
    expect((resBody(result) as { error: { code: string } }).error.code).toBe('ai_upstream_unreachable')
    // Primary attempt + one bounded transient retry, both failed.
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('reports a REACHABLE but throttled provider as 429 rate limited, never as 502 unreachable', async () => {
    // Regression: an exhausted upstream quota is a live provider answering 429.
    // The router used to fall through to the generic tail and return
    // `502 ai_upstream_unreachable`, so the client told the user the AI service
    // was unreachable while it was healthy and merely throttled.
    const { fetchImpl, calls } = makeFetch(async () => fakeResponse(429, '{"error":"quota"}'))
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'sk-g' },
      fetchImpl,
      sleep: async () => undefined,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(429)
    expect(result.errorCode).toBe('ai_upstream_rate_limited')
    expect((resBody(result) as { error: { code: string } }).error.code).toBe('ai_upstream_rate_limited')
    // A rate limit is never retried on the same provider and never a network retry.
    expect(calls).toHaveBeenCalledOnce()
  })

  it('reports every candidate answering 5xx as a 502 upstream ERROR, not unreachable', async () => {
    const { fetchImpl } = makeFetch(async () => fakeResponse(503, '{}'))
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'sk-g' },
      fetchImpl,
      sleep: async () => undefined,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(502)
    expect(result.errorCode).toBe('ai_upstream_error')
  })

  it('still reports a genuine transport failure as 502 unreachable when a rate limit was also seen', async () => {
    // A provider we never reached outranks one that was merely throttled: we
    // cannot claim "throttled" when the request never got there.
    const { fetchImpl } = makeFetch(async (url) => {
      if (url.includes('api.openai.com')) throw new TypeError('fetch failed')
      return fakeResponse(429, '{"error":"quota"}')
    })
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'gemini',
        JARVIS_AI_FALLBACK_PROVIDERS: 'openai',
        GEMINI_API_KEY: 'sk-g',
        OPENAI_API_KEY: 'sk-o',
      },
      fetchImpl,
      sleep: async () => undefined,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(502)
    expect(result.errorCode).toBe('ai_upstream_unreachable')
  })

  it('recovers a transient network failure with ONE bounded same-provider retry', async () => {
    let attempt = 0
    const { fetchImpl, calls } = makeFetch(async () => {
      attempt += 1
      if (attempt === 1) throw new TypeError('fetch failed') // e.g. released keep-alive socket
      return chatReply('recovered')
    })
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'sk-g' },
      fetchImpl,
      sleep: async () => undefined,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    // A dropped socket must NOT surface as a hard 502 anymore.
    expect(result.status).toBe(200)
    expect(result.provider).toBe('gemini')
    expect(result.usedFallback).toBe(false)
    expect(calls).toHaveBeenCalledTimes(2)
    expect((resBody(result) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content).toBe('recovered')
  })

  it('does NOT retry a transient network failure past the bounded attempt count', async () => {
    const { fetchImpl, calls } = makeFetch(async () => {
      throw new TypeError('fetch failed')
    })
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'sk-g' },
      fetchImpl,
      sleep: async () => undefined,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(502)
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('never retries an auth rejection (401) even though it is a live upstream', async () => {
    const { fetchImpl, calls } = makeFetch(async () => fakeResponse(401, '{"error":"bad key"}'))
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'sk-g' },
      fetchImpl,
      sleep: async () => undefined,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(401)
    expect(calls).toHaveBeenCalledOnce()
  })

  it('fails over from a transient 5xx to the next candidate', async () => {
    const { fetchImpl, calls } = makeFetch(async (url) => {
      if (url.includes('generativelanguage')) return fakeResponse(503, '{}')
      if (url.includes('api.openai.com')) return chatReply('after 5xx')
      throw new Error(`unexpected url ${url}`)
    })
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'gemini',
        JARVIS_AI_FALLBACK_PROVIDERS: 'openai',
        GEMINI_API_KEY: 'sk-g',
        OPENAI_API_KEY: 'sk-o',
      },
      fetchImpl,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(200)
    expect(result.provider).toBe('openai')
    expect(result.usedFallback).toBe(true)
    expect(calls).toHaveBeenCalledTimes(2)
  })
})

describe('aiProvider router — health and security', () => {
  it('reports MISCONFIGURED with guidance when nothing is configured', async () => {
    const router = createAiProviderRouter({ env: {} })
    const report = await router.getHealth()
    expect(report.status).toBe('MISCONFIGURED')
    expect(report.code).toBe('MISCONFIGURED')
    expect(report.provider).toBe('none')
    expect(report.configuredProviders).toEqual([])
    expect(report.availableProviders).toEqual([])
    expect(report.capabilities).toEqual([])
    expect(report.message).toContain('No AI provider is configured')
    expect(report.providers).toHaveLength(1)
    expect(report.providers[0]?.id).toBe('legacy')
    expect(report.providers[0]?.status).toBe('NOT_CONFIGURED')
  })

  it('reports the active provider, models and connection when configured and probing', async () => {
    const { fetchImpl } = makeFetch(async () => chatReply('ping'))
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'sk-health' },
      fetchImpl,
      now: () => 1_000_000,
    })
    const report = await router.getHealth()
    expect(report.status).toBe('CONNECTED')
    expect(report.provider).toBe('gemini')
    expect(report.primary).toBe('gemini')
    expect(report.model).toBe('gemini-3.6-flash')
    expect(report.upstream).toBe('https://generativelanguage.googleapis.com/v1beta/openai')
    expect(report.configuredProviders).toEqual(['gemini'])
    expect(report.capabilities).toEqual(['reasoning', 'vision', 'embeddings'])
    expect(report.providersProbed).toBe(true)
    const gemini = report.providers.find((p) => p.id === 'gemini')
    expect(gemini?.status).toBe('CONNECTED')
    expect(gemini?.model).toBe('gemini-3.6-flash')
    expect(gemini?.capabilities).toEqual(['reasoning', 'vision', 'embeddings'])
  })

  it('marks an auth-failing probe as AUTHENTICATION_FAILED, never CONNECTED', async () => {
    const { fetchImpl } = makeFetch(async () => fakeResponse(401, '{"error":"invalid key"}'))
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'sk-wrong' },
      fetchImpl,
      now: () => 1_000_000,
    })
    const report = await router.getHealth()
    expect(report.status).toBe('AUTHENTICATION_FAILED')
    const gemini = report.providers.find((p) => p.id === 'gemini')
    expect(gemini?.status).toBe('UNAVAILABLE')
  })

  it('never exposes an API key in the health report', async () => {
    const { fetchImpl } = makeFetch(async () => chatReply('ping'))
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'sk-router-secret-xyz' },
      fetchImpl,
    })
    const report = await router.getHealth()
    expect(JSON.stringify(report)).not.toContain('sk-router-secret-xyz')
    expect(JSON.stringify(report)).not.toContain('sk-')
  })

  it('registry snapshot exposes explicit mode, primary, fallbacks and pinned', () => {
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'gemini',
        JARVIS_AI_FALLBACK_PROVIDERS: 'openai, anthropic',
        JARVIS_AI_PINNED_PROVIDER: '',
        GEMINI_API_KEY: 'sk-g',
        OPENAI_API_KEY: 'sk-o',
      },
    })
    const snapshot = router.registry()
    expect(snapshot.explicitMode).toBe(true)
    expect(snapshot.primary).toBe('gemini')
    expect(snapshot.fallbacks).toEqual(['openai', 'anthropic'])
    expect(snapshot.pinned).toBeNull()
    expect(snapshot.providers.map((p) => p.id)).toEqual([
      'gemini',
      'openai',
      'anthropic',
      'openrouter',
      'local',
      'ollama',
      'lmstudio',
    ])
    expect(snapshot.providers.filter((p) => p.enabled).map((p) => p.id)).toEqual(['gemini', 'openai'])
    expect(snapshot.providers.find((p) => p.id === 'anthropic')?.capabilities).toEqual(['reasoning'])
    expect(snapshot.providers.find((p) => p.id === 'openrouter')?.capabilities).toEqual(['reasoning', 'vision'])
  })
})

describe('aiProvider router — auto routing, discovery and truthful states', () => {
  it('accepts `auto` as the primary selection instead of degrading to none', () => {
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'auto',
        JARVIS_AI_FALLBACK_PROVIDERS: 'openai',
        GEMINI_API_KEY: 'sk-g',
        OPENAI_API_KEY: 'sk-o',
      },
    })
    const snapshot = router.registry()
    expect(snapshot.explicitMode).toBe(true)
    expect(snapshot.primary).toBe('auto')
    expect(snapshot.fallbacks).toEqual(['openai'])
    expect(snapshot.providers.filter((p) => p.enabled).map((p) => p.id)).toEqual(['gemini', 'openai'])
  })

  it('routes an `auto` request to the first usable provider and reports auto as primary', async () => {
    const { fetchImpl, calls } = makeFetch(async (url) => {
      if (url.includes('api.openai.com')) return chatReply('openai served this')
      throw new Error(`unexpected url ${url}`)
    })
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'auto',
        JARVIS_AI_FALLBACK_PROVIDERS: 'openai',
        GEMINI_API_KEY: 'sk-g',
        OPENAI_API_KEY: 'sk-o',
      },
      fetchImpl,
    })
    // With `auto` the fallback list is the operator's preferred order, so the
    // healthy first choice serves immediately (no wasted round trip).
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.provider).toBe('openai')
    expect(result.usedFallback).toBe(false)
    expect(String(calls.mock.calls[0]?.[0])).toContain('api.openai.com')
    const report = await router.getHealth()
    expect(report.primary).toBe('auto')
  })

  it('falls over across usable providers when the auto head is unreachable', async () => {
    const { fetchImpl } = makeFetch(async (url) => {
      if (url.includes('api.openai.com')) throw new Error('ECONNREFUSED')
      if (url.includes('generativelanguage')) return chatReply('gemini served this')
      throw new Error(`unexpected url ${url}`)
    })
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'auto',
        JARVIS_AI_FALLBACK_PROVIDERS: 'openai',
        GEMINI_API_KEY: 'sk-g',
        OPENAI_API_KEY: 'sk-o',
      },
      fetchImpl,
    })
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.provider).toBe('gemini')
    expect(result.usedFallback).toBe(true)
  })

  it('deprioritizes a provider whose LAST REAL request failed (auto routing uses real health)', async () => {
    const { fetchImpl } = makeFetch(async (url) => {
      if (url.includes('generativelanguage')) return fakeResponse(503, '{}')
      if (url.includes('api.openai.com')) return chatReply('openai is up')
      throw new Error(`unexpected url ${url}`)
    })
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'auto',
        JARVIS_AI_FALLBACK_PROVIDERS: 'gemini,openai',
        GEMINI_API_KEY: 'sk-g',
        OPENAI_API_KEY: 'sk-o',
      },
      fetchImpl,
    })
    const first = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(first.provider).toBe('openai')
    expect(first.usedFallback).toBe(true)
    // The failed provider is remembered, so the very next request goes STRAIGHT
    // to the provider that actually worked — no repeated dead round trip.
    expect(String(callsAt(fetchImpl, 0))).toContain('generativelanguage')
    const second = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(second.provider).toBe('openai')
    expect(second.usedFallback).toBe(false)
    expect(String(callsAt(fetchImpl, 2))).toContain('api.openai.com')
  })

  it('discovers the models a running Ollama really has and uses one as the default', async () => {
    const { fetchImpl, calls } = makeFetch(async (url, init) => {
      if (url.endsWith('/api/tags')) {
        // Discovery uses Ollama's NATIVE route, never the /v1 OpenAI prefix.
        expect(url).toBe('http://127.0.0.1:11434/api/tags')
        return okResponse({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5:7b' }] })
      }
      if (url.endsWith('/chat/completions')) {
        // ...while chat uses /v1 (the bare host answers "404 page not found").
        expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions')
        expect((bodyOf(init) as { model: string }).model).toBe('llama3.2:latest')
        return chatReply('ollama says hi')
      }
      throw new Error(`unexpected url ${url}`)
    })
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'auto', OLLAMA_BASE_URL: 'http://127.0.0.1:11434' },
      fetchImpl,
    })
    const report = await router.getHealth()
    const ollama = report.providers.find((p) => p.id === 'ollama')
    expect(ollama?.status).toBe('CONNECTED')
    expect(ollama?.discovered).toBe(true)
    expect(ollama?.models).toEqual(['llama3.2:latest', 'qwen2.5:7b'])
    expect(ollama?.model).toBe('llama3.2:latest')
    expect(report.healthyProviders).toContain('ollama')
    expect(report.provider).toBe('ollama')
    expect(report.status).toBe('CONNECTED')

    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.provider).toBe('ollama')
    expect(result.model).toBe('llama3.2:latest')
    expect(calls.mock.calls.filter((c) => String(c[0]).endsWith('/api/tags')).length).toBe(1)
  })

  it('discovers LM Studio models through the OpenAI /models route', async () => {
    const { fetchImpl } = makeFetch(async (url) => {
      if (url.endsWith('/models')) return okResponse({ data: [{ id: 'qwen2.5-7b-instruct' }] })
      throw new Error(`unexpected url ${url}`)
    })
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'auto',
        LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234/v1',
      },
      fetchImpl,
    })
    const report = await router.getHealth()
    const lmstudio = report.providers.find((p) => p.id === 'lmstudio')
    expect(lmstudio?.status).toBe('CONNECTED')
    expect(lmstudio?.models).toEqual(['qwen2.5-7b-instruct'])
    expect(report.provider).toBe('lmstudio')
  })

  it('reports a reachable local engine with no models as MODEL_UNAVAILABLE with a fix', async () => {
    const { fetchImpl } = makeFetch(async () => okResponse({ models: [] }))
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'auto', OLLAMA_BASE_URL: 'http://127.0.0.1:11434' },
      fetchImpl,
    })
    const report = await router.getHealth()
    const ollama = report.providers.find((p) => p.id === 'ollama')
    expect(ollama?.status).toBe('MODEL_UNAVAILABLE')
    expect(ollama?.discovered).toBe(false)
    expect(report.status).toBe('MODEL_UNAVAILABLE')
    expect(report.message).toContain('ollama pull')
  })

  it('never reports CONNECTED for an unreachable or unauthorized provider', async () => {
    const { fetchImpl } = makeFetch(async () => {
      throw new Error('ECONNREFUSED')
    })
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'auto',
        JARVIS_AI_FALLBACK_PROVIDERS: 'anthropic',
        GEMINI_API_KEY: 'sk-g',
        ANTHROPIC_API_KEY: 'sk-a',
      },
      fetchImpl,
    })
    const report = await router.getHealth()
    expect(report.status).not.toBe('CONNECTED')
    expect(report.healthyProviders).toEqual([])
    for (const provider of report.providers) {
      expect(provider.status).not.toBe('CONNECTED')
    }
  })

  it('says KEY_REQUIRED when a key-based provider has no credential', async () => {
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'gemini', OPENAI_BASE_URL: 'https://api.openai.com/v1' },
      fetchImpl: makeFetch(async () => chatReply('x')).fetchImpl,
    })
    const report = await router.getHealth()
    const openai = report.providers.find((p) => p.id === 'openai')
    expect(openai?.status).toBe('KEY_REQUIRED')
    expect(openai?.available).toBe(false)
  })

  it('reports DISABLED (and never routes) for JARVIS_AI_DISABLED_PROVIDERS', async () => {
    const { fetchImpl } = makeFetch(async (url) => {
      if (url.includes('api.openai.com')) return chatReply('openai served this')
      throw new Error(`unexpected url ${url}`)
    })
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'gemini',
        JARVIS_AI_DISABLED_PROVIDERS: 'gemini',
        GEMINI_API_KEY: 'sk-g',
        OPENAI_API_KEY: 'sk-o',
      },
      fetchImpl,
    })
    const snapshot = router.registry()
    expect(snapshot.disabled).toEqual(['gemini'])
    expect(snapshot.providers.find((p) => p.id === 'gemini')?.enabled).toBe(false)
    const report = await router.getHealth()
    expect(report.providers.find((p) => p.id === 'gemini')?.status).toBe('DISABLED')
    // A disabled provider must not be picked up as the active one.
    expect(report.provider).toBe('openai')
  })

  it('does not demote a provider because of a client payload (400) error', async () => {
    const { fetchImpl, calls } = makeFetch(async (url) => {
      if (url.includes('generativelanguage')) return fakeResponse(400, '{"error":"bad model"}')
      if (url.includes('api.openai.com')) return chatReply('openai is up')
      throw new Error(`unexpected url ${url}`)
    })
    const router = createAiProviderRouter({
      env: {
        JARVIS_AI_PRIMARY_PROVIDER: 'auto',
        JARVIS_AI_FALLBACK_PROVIDERS: 'gemini,openai',
        GEMINI_API_KEY: 'sk-g',
        OPENAI_API_KEY: 'sk-o',
      },
      fetchImpl,
    })
    const first = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(first.status).toBe(400)
    // Gemini is still tried first: a 400 is the caller's payload, not a
    // provider outage.
    const second = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(second.status).toBe(400)
    expect(String(calls.mock.calls[1]?.[0])).toContain('generativelanguage')
  })

  it('routes to a running local engine with NO prior health call (cold start)', async () => {
    const { fetchImpl } = makeFetch(async (url, init) => {
      if (url.endsWith('/api/tags')) return okResponse({ models: [{ name: 'qwen3:8b' }] })
      if (url.endsWith('/chat/completions')) {
        expect(url).toBe('http://localhost:11434/v1/chat/completions')
        expect((bodyOf(init) as { model: string }).model).toBe('qwen3:8b')
        return chatReply('cold start ok')
      }
      // LM Studio / generic local: nothing is listening in this test.
      throw new Error(`ECONNREFUSED ${url}`)
    })
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'auto' },
      fetchImpl,
    })
    // No getHealth() first: `auto` must discover and use the local engine on the
    // request itself, not answer "no provider is configured".
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.status).toBe(200)
    expect(result.provider).toBe('ollama')
    expect(result.model).toBe('qwen3:8b')
  })

  it('keeps a discovered local engine routable after the probe TTL expires', async () => {
    let clock = 1_000_000
    const { fetchImpl } = makeFetch(async (url) => {
      if (url.endsWith('/api/tags')) return okResponse({ models: [{ name: 'qwen3:8b' }] })
      if (url.endsWith('/chat/completions')) return chatReply('still routed')
      throw new Error(`ECONNREFUSED ${url}`)
    })
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'auto', OLLAMA_BASE_URL: 'http://localhost:11434' },
      fetchImpl,
      now: () => clock,
      probeTtlMs: 15_000,
    })
    await router.getHealth()
    // A minute later the health CLAIM is stale (and re-probed), but routing
    // availability must not silently expire.
    clock += 60_000
    const result = await router.route({ subpath: '/chat/completions', body: CHAT_BODY })
    expect(result.provider).toBe('ollama')
  })

  it('gives local engines a long budget (model load) and honors an explicit override', () => {
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'auto', OLLAMA_BASE_URL: 'http://localhost:11434', LMSTUDIO_AI_TIMEOUT_MS: '5000' },
    })
    const providers = router.registry().providers
    // Ollama loads the model on the request: the default must not be the 45s
    // hosted-provider budget.
    expect(providers.find((p) => p.id === 'ollama')?.timeoutMs).toBe(180_000)
    expect(providers.find((p) => p.id === 'gemini')?.timeoutMs).toBe(45_000)
    // An explicit env value always wins.
    expect(providers.find((p) => p.id === 'lmstudio')?.timeoutMs).toBe(5_000)
  })

  it('never leaks an api key through discovery errors', async () => {
    const { fetchImpl } = makeFetch(async () => {
      throw new Error('boom')
    })
    const router = createAiProviderRouter({
      env: { JARVIS_AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'sk-discovery-secret' },
      fetchImpl,
    })
    const report = await router.getHealth()
    expect(JSON.stringify(report)).not.toContain('sk-discovery-secret')
  })
})

describe('resolveLegacyProxy (Vite dev parity)', () => {
  it('returns undefined with no keys', () => {
    expect(resolveLegacyProxy({})).toBeUndefined()
  })

  it('honors a custom target as the upstream', () => {
    const proxy = resolveLegacyProxy({ VITE_JARVIS_AI_PROXY_TARGET: 'http://127.0.0.1:11434/v1', GEMINI_API_KEY: 'sk-x' })
    expect(proxy?.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(proxy?.key).toBe('sk-x')
  })

  it('defaults to the Gemini base with JARVIS/OPENAI keys (legacy fallback)', () => {
    const proxy = resolveLegacyProxy({ OPENAI_API_KEY: 'sk-o' })
    expect(proxy?.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai')
    expect(proxy?.key).toBe('sk-o')
  })
})