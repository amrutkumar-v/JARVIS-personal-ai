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
    expect(snapshot.providers.map((p) => p.id)).toEqual(['gemini', 'openai', 'anthropic', 'openrouter', 'local'])
    expect(snapshot.providers.filter((p) => p.enabled).map((p) => p.id)).toEqual(['gemini', 'openai'])
    expect(snapshot.providers.find((p) => p.id === 'anthropic')?.capabilities).toEqual(['reasoning'])
    expect(snapshot.providers.find((p) => p.id === 'openrouter')?.capabilities).toEqual(['reasoning', 'vision'])
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