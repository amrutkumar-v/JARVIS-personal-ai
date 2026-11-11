import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  checkAiHealth,
  getAiConfig,
  resetAiConfigCache,
  type AiHealthCheckResult,
  type AiModelDiscoveryProbe,
} from './ai'

const ENV = import.meta.env as Record<string, string | undefined>

/** Direct keyless local transport with a configured model. */
function setDirectConfig(): void {
  ENV.VITE_JARVIS_AI_BASE_URL = 'http://localhost:11434'
  ENV.VITE_JARVIS_AI_MODEL = 'llama3.1'
  delete ENV.VITE_JARVIS_AI_PROXY_URL
  resetAiConfigCache()
}

/** Proxy transport (key injected server-side). */
function setProxyConfig(): void {
  ENV.VITE_JARVIS_AI_PROXY_URL = '/api/ai'
  delete ENV.VITE_JARVIS_AI_BASE_URL
  ENV.VITE_JARVIS_AI_MODEL = 'llama3.1'
  resetAiConfigCache()
}

function mockHealth(body: AiHealthCheckResult): void {
  ;(globalThis as Record<string, unknown>).fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  })
}

function fetchMock(): ReturnType<typeof vi.fn> {
  return (globalThis as Record<string, unknown>).fetch as ReturnType<typeof vi.fn>
}

const CONNECTED: AiHealthCheckResult = {
  status: 'CONNECTED',
  code: 'CONNECTED',
  model: 'llama3.1',
  providersProbed: true,
}

describe('checkAiHealth model availability probe', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('A. preserves existing behavior when no probe is supplied', async () => {
    setDirectConfig()
    mockHealth(CONNECTED)
    const result = await checkAiHealth()
    expect(result.status).toBe('CONNECTED')
    expect(result.code).toBe('CONNECTED')
    expect(fetchMock().mock.calls[0]?.[0]).toBe('http://localhost:11434/api/tags')
    expect(fetchMock().mock.calls[0]?.[0]).not.toBe('/api/ai/health')
  })

  it('B. never emits MODEL_UNAVAILABLE when discovery returned [] (not verified)', async () => {
    setDirectConfig()
    mockHealth(CONNECTED)
    const probe: AiModelDiscoveryProbe = vi.fn().mockResolvedValue([])
    const result = await checkAiHealth(probe)
    expect(result.status).toBe('CONNECTED')
    expect(result.code).not.toBe('MODEL_UNAVAILABLE')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('C. stays healthy when the configured model is confirmed present', async () => {
    setDirectConfig()
    mockHealth(CONNECTED)
    const probe: AiModelDiscoveryProbe = vi.fn().mockResolvedValue(['llama3.1', 'qwen2.5'])
    const result = await checkAiHealth(probe)
    expect(result.status).toBe('CONNECTED')
    expect(result.code).not.toBe('MODEL_UNAVAILABLE')
  })

  it('D. emits MODEL_UNAVAILABLE only when the configured model is confirmed absent', async () => {
    setDirectConfig()
    mockHealth(CONNECTED)
    const probe: AiModelDiscoveryProbe = vi.fn().mockResolvedValue(['qwen2.5', 'deepseek-r1'])
    const result = await checkAiHealth(probe)
    expect(result.status).toBe('MODEL_UNAVAILABLE')
    expect(result.code).toBe('MODEL_UNAVAILABLE')
  })

  it('E. never emits MODEL_UNAVAILABLE when the probe throws (not verified)', async () => {
    setDirectConfig()
    mockHealth(CONNECTED)
    const probe: AiModelDiscoveryProbe = vi.fn().mockRejectedValue(new Error('engine offline'))
    const result = await checkAiHealth(probe)
    expect(result.status).toBe('CONNECTED')
    expect(result.code).not.toBe('MODEL_UNAVAILABLE')
  })

  it('F. proxy transport must NOT call the probe (no local discovery behind a proxy)', async () => {
    setProxyConfig()
    mockHealth(CONNECTED)
    const probe: AiModelDiscoveryProbe = vi.fn().mockResolvedValue(['qwen2.5'])
    const result = await checkAiHealth(probe)
    expect(result.code).not.toBe('MODEL_UNAVAILABLE')
    expect(probe).not.toHaveBeenCalled()
  })

  it('G. calls the probe at most once per health calculation', async () => {
    setDirectConfig()
    mockHealth(CONNECTED)
    const probe: AiModelDiscoveryProbe = vi.fn().mockResolvedValue(['llama3.1'])
    await checkAiHealth(probe)
    await checkAiHealth(probe)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('checks the configured direct provider and reports its authentication failure', async () => {
    setDirectConfig()
    ;(globalThis as Record<string, unknown>).fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    const result = await checkAiHealth()
    expect(result.status).toBe('AUTHENTICATION_FAILED')
    expect(fetchMock().mock.calls[0]?.[0]).toBe('http://localhost:11434/api/tags')
  })

  it('does not fetch a dev proxy health route when no provider is configured', async () => {
    delete ENV.VITE_JARVIS_AI_BASE_URL
    delete ENV.VITE_JARVIS_AI_PROXY_URL
    delete ENV.VITE_JARVIS_AI_MODEL
    resetAiConfigCache()
    const fetchSpy = vi.fn()
    ;(globalThis as Record<string, unknown>).fetch = fetchSpy
    const result = await checkAiHealth()
    expect(result.status).toBe('MISCONFIGURED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // --- Direct transport health routing tests ---

  it('direct transport uses provider native endpoints (not proxy health)', async () => {
    setDirectConfig()
    const fetchSpy = vi.fn()
    // Mock /api/tags to return ok
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'llama3.1' }] }), { status: 200 }))
    ;(globalThis as Record<string, unknown>).fetch = fetchSpy
    const result = await checkAiHealth()
    expect(result.status).toBe('CONNECTED')
    // Should call provider's native endpoints, not /api/ai/health
    const calls = fetchSpy.mock.calls.map((c) => c[0])
    expect(calls.some((url) => url.includes('/api/tags') || url.includes('/models'))).toBe(true)
    expect(calls.some((url) => url.includes('/api/ai/health'))).toBe(false)
  })

  it('proxy transport uses proxy health endpoint', async () => {
    setProxyConfig()
    mockHealth(CONNECTED)
    const result = await checkAiHealth()
    expect(result.status).toBe('CONNECTED')
    // Should call proxy health endpoint
    const calls = fetchMock().mock.calls.map((c) => c[0])
    expect(calls.some((url) => url.includes('/api/ai/health'))).toBe(true)
  })

  it('reports a verified real fallback as connected while naming the unavailable primary', async () => {
    setProxyConfig()
    mockHealth({
      status: 'NETWORK_ERROR',
      code: 'NETWORK_ERROR',
      provider: 'gemini',
      primary: 'gemini',
      model: 'gemini-3.6-flash',
      healthyProviders: ['ollama'],
      providers: [
        { id: 'gemini', name: 'Google Gemini', enabled: true, configured: true, available: true, capabilities: ['reasoning'], model: 'gemini-3.6-flash', status: 'UNAVAILABLE', lastError: 'upstream unreachable' },
        { id: 'ollama', name: 'Ollama', enabled: true, configured: true, available: true, capabilities: ['reasoning'], model: 'qwen3:8b', status: 'CONNECTED' },
      ],
    })

    const result = await checkAiHealth()

    expect(result.status).toBe('CONNECTED')
    expect(result.code).toBe('CONNECTED')
    expect(result.provider).toBe('ollama')
    expect(result.model).toBe('qwen3:8b')
    expect(result.fallbackProvider).toBe('ollama')
    expect(result.message).toContain('Google Gemini is unavailable')
    expect(result.message).toContain('Ollama (qwen3:8b) as a fallback')
  })

  it('does not silently fall back when the user pins an unavailable provider', async () => {
    setProxyConfig()
    mockHealth({
      status: 'CONNECTED',
      code: 'CONNECTED',
      provider: 'gemini',
      healthyProviders: ['gemini', 'ollama'],
      providers: [
        { id: 'gemini', name: 'Google Gemini', enabled: true, configured: true, available: true, capabilities: ['reasoning'], model: 'gemini-3.6-flash', status: 'CONNECTED' },
        { id: 'ollama', name: 'Ollama', enabled: true, configured: true, available: true, capabilities: ['reasoning'], model: 'qwen3:8b', status: 'CONNECTED' },
      ],
    })

    const result = await checkAiHealth(undefined, 'ollama')

    expect(result.status).toBe('CONNECTED')
    expect(result.provider).toBe('ollama')
    expect(result.fallbackProvider).toBeUndefined()
  })

  // --- Mock mode visibility tests ---

  it('reports MISCONFIGURED with explicit message when no AI is configured (mock mode)', async () => {
    delete ENV.VITE_JARVIS_AI_BASE_URL
    delete ENV.VITE_JARVIS_AI_PROXY_URL
    delete ENV.VITE_JARVIS_AI_MODEL
    resetAiConfigCache()
    const result = await checkAiHealth()
    expect(result.status).toBe('MISCONFIGURED')
    expect(result.code).toBe('MISCONFIGURED')
    expect(result.message).toContain('No real AI endpoint')
  })

  it('getAiConfig returns mock providerId when no endpoint is configured', () => {
    delete ENV.VITE_JARVIS_AI_BASE_URL
    delete ENV.VITE_JARVIS_AI_PROXY_URL
    delete ENV.VITE_JARVIS_AI_MODEL
    resetAiConfigCache()
    const cfg = getAiConfig()
    expect(cfg.providerId).toBe('mock')
    expect(cfg.transport).toBe('none')
  })

  it('getAiConfig returns remote providerId when endpoint and model are configured', () => {
    ENV.VITE_JARVIS_AI_BASE_URL = 'http://localhost:11434'
    ENV.VITE_JARVIS_AI_MODEL = 'llama3.1'
    delete ENV.VITE_JARVIS_AI_PROXY_URL
    resetAiConfigCache()
    const cfg = getAiConfig()
    expect(cfg.providerId).toBe('remote')
    expect(cfg.transport).toBe('direct')
  })

  it('getAiConfig returns remote providerId when proxy URL and model are configured', () => {
    ENV.VITE_JARVIS_AI_PROXY_URL = '/api/ai'
    ENV.VITE_JARVIS_AI_MODEL = 'llama3.1'
    delete ENV.VITE_JARVIS_AI_BASE_URL
    resetAiConfigCache()
    const cfg = getAiConfig()
    expect(cfg.providerId).toBe('remote')
    expect(cfg.transport).toBe('proxy')
  })
})
