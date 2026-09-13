import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ReasoningProvider } from './ReasoningProvider'
import { ProviderError } from '../providers/ProviderError'
import { resetAiConfigCache } from '../../config/ai'
import { RemoteProvider } from '../providers/RemoteProvider'
import { isStructuredPlanProvider } from './provider'
import type { ReasoningRequest } from './contract'

/**
 * Phase 13 — ReasoningProvider transport contract (CONTROLLED responses; the
 * fetch is always mocked). Every downstream failure is a typed ProviderError;
 * NOTHING is executed from these. Success returns ONLY the parsed structured
 * JSON object — never a chat reply, never tool calls.
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
  setRemoteConfig()
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

function mockFetchReject(error: Error): void {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
  fetchMock.mockRejectedValue(error)
}

const REQ: ReasoningRequest = {
  text: 'open the memo pad',
  capabilities: [
    {
      id: 'open_application',
      name: 'Open application',
      description: 'Launch a registered app.',
      arguments: [{ name: 'application_id', type: 'string', required: true }],
      requiresConfirmation: false,
      readOnly: false,
    },
  ],
  constraints: 'Only registered capabilities. Never paths or executables.',
}

describe('Phase 13 — ReasoningProvider.plan (controlled transport)', () => {
  it('returns the PARsed structured JSON object on success', async () => {
    mockFetchResponse(200, {
      choices: [{ message: { content: '{"intent":"execute","steps":[{"capabilityId":"open_application","arguments":{"application_id":"notepad"}}]}' } }],
    })
    const provider = new ReasoningProvider()
    provider.generate = async () => ({ text: 'never used' })
    const raw = await provider.plan(REQ)
    expect(raw).toEqual({
      intent: 'execute',
      steps: [{ capabilityId: 'open_application', arguments: { application_id: 'notepad' } }],
    })
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>
    expect(body.response_format).toEqual({ type: 'json_object' })
    // Structured output: low temperature, bounded tokens, NO open-ended tools.
    expect(Number(body.temperature)).toBeLessThanOrEqual(0.3)
    expect(Number(body.max_tokens)).toBeLessThanOrEqual(512)
    expect(Array.isArray(body.tools)).toBe(false)
    expect(JSON.stringify(body.messages)).toContain('open_application')
  })

  it('throws config ProviderError when no endpoint/model is configured', async () => {
    setRemoteConfig({ VITE_JARVIS_AI_BASE_URL: undefined, VITE_JARVIS_AI_MODEL: undefined })
    await expect(new ReasoningProvider().plan(REQ)).rejects.toMatchObject({ kind: 'config' })
  })

  it('maps 401/403 to auth', async () => {
    mockFetchResponse(401, { error: 'bad key' })
    await expect(new ReasoningProvider().plan(REQ)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps 429 to rate_limit', async () => {
    mockFetchResponse(429, {})
    await expect(new ReasoningProvider().plan(REQ)).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps 5xx to server', async () => {
    mockFetchResponse(500, {})
    await expect(new ReasoningProvider().plan(REQ)).rejects.toMatchObject({ kind: 'server' })
  })

  it('maps network failure to network', async () => {
    mockFetchReject(new TypeError('fetch failed'))
    await expect(new ReasoningProvider().plan(REQ)).rejects.toMatchObject({ kind: 'network' })
  })

  it('maps transport timeout (AbortError) to timeout', async () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    mockFetchReject(abort)
    await expect(new ReasoningProvider().plan(REQ)).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('maps an externally-aborted signal to timeout', async () => {
    mockFetchReject((() => {
      const abort = new Error('aborted')
      abort.name = 'AbortError'
      return abort
    })())
    const controller = new AbortController()
    controller.abort()
    await expect(new ReasoningProvider().plan(REQ, controller.signal)).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('maps empty content to malformed', async () => {
    mockFetchResponse(200, { choices: [{ message: { content: '' } }] })
    await expect(new ReasoningProvider().plan(REQ)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('maps non-JSON content to malformed', async () => {
    mockFetchResponse(200, { choices: [{ message: { content: 'not json at all' } }] })
    await expect(new ReasoningProvider().plan(REQ)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('maps an unreadable body to malformed', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => {
        throw new SyntaxError('bad json')
      },
    } as unknown as Response)
    await expect(new ReasoningProvider().plan(REQ)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('strips markdown fences before parsing', async () => {
    mockFetchResponse(200, {
      choices: [{ message: { content: '```json\n{"intent":"reject","reason":"no","steps":[]}\n```' } }],
    })
    const raw = await new ReasoningProvider().plan(REQ)
    expect(raw).toEqual({ intent: 'reject', reason: 'no', steps: [] })
  })
})

describe('Phase 13 — provider wiring (createProviders → ReasoningProvider)', () => {
  it('the reasoning provider is a RemoteProvider superset WITH plan()', async () => {
    mockFetchResponse(200, { choices: [{ message: { content: '{"intent":"execute","steps":[]}' } }] })
    const provider = new ReasoningProvider()
    expect(provider instanceof RemoteProvider).toBe(true)
    expect(isStructuredPlanProvider(provider)).toBe(true)
    const raw = await provider.plan(REQ)
    expect(raw).toEqual({ intent: 'execute', steps: [] })
  })

  it('fetch is called exactly once per plan() (no hidden fallback consumption)', async () => {
    mockFetchResponse(200, {
      choices: [{ message: { content: '{"intent":"execute","steps":[{"capabilityId":"open_application","arguments":{"application_id":"notepad"}}]}' } }],
    })
    const provider = new ReasoningProvider()
    provider.generate = async () => ({ text: 'never used' })
    await provider.plan(REQ)
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('plan() rejects as ProviderError (typed), never a plain object', async () => {
    mockFetchResponse(503, {})
    try {
      await new ReasoningProvider().plan(REQ)
      expect.fail('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError)
    }
  })
})