import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProviders, resetProviders } from './index'
import { resetAiConfigCache, REMOTE_PROVIDER_ID, MOCK_PROVIDER_ID, checkAiHealth } from '../../config/ai'
import { RemoteProvider } from './RemoteProvider'
import { ProviderError } from './ProviderError'
import type { AIRequest } from '../provider'

const ENV = import.meta.env as Record<string, string | undefined>

function clearAiEnv(): void {
  delete ENV.VITE_JARVIS_AI_BASE_URL
  delete ENV.VITE_JARVIS_AI_MODEL
  delete ENV.VITE_JARVIS_AI_PROXY_URL
  delete ENV.JARVIS_API_KEY
}

afterEach(() => {
  clearAiEnv()
  resetAiConfigCache()
  resetProviders()
})

describe('provider selection (deterministic + observable)', () => {
  it('selects the mock only when NO real endpoint/model is configured', () => {
    clearAiEnv()
    resetAiConfigCache()
    resetProviders()
    const providers = createProviders()
    expect(providers).toHaveLength(1)
    expect(providers[0].id).toBe('mock')
  })

  it('selects the REMOTE provider for a direct endpoint + model', () => {
    ENV.VITE_JARVIS_AI_BASE_URL = 'https://ai.example.com/v1'
    ENV.VITE_JARVIS_AI_MODEL = 'gpt-4o-mini'
    resetAiConfigCache()
    resetProviders()
    const providers = createProviders()
    expect(providers).toHaveLength(1)
    expect(providers[0].id).toBe('remote')
  })

  it('selects the REMOTE provider for a same-origin proxy + model', () => {
    ENV.VITE_JARVIS_AI_PROXY_URL = '/api/ai'
    ENV.VITE_JARVIS_AI_MODEL = 'gpt-4o-mini'
    resetAiConfigCache()
    resetProviders()
    const providers = createProviders()
    expect(providers).toHaveLength(1)
    expect(providers[0].id).toBe('remote')
  })

  it('stays on mock when only an endpoint exists but NO model is declared', () => {
    ENV.VITE_JARVIS_AI_BASE_URL = 'https://ai.example.com/v1'
    resetAiConfigCache()
    resetProviders()
    const providers = createProviders()
    expect(providers[0].id).toBe('mock')
  })

  it('returns a stable cached provider list until reset', () => {
    ENV.VITE_JARVIS_AI_BASE_URL = 'https://ai.example.com/v1'
    ENV.VITE_JARVIS_AI_MODEL = 'gpt-4o-mini'
    resetAiConfigCache()
    resetProviders()
    const first = createProviders()
    const second = createProviders()
    expect(second).toBe(first)
    expect(second[0].id).toBe('remote')
  })
})

describe('Phase 2 — Mock vs Real provider labeling', () => {
  it('mock provider id is "mock" and label identifies it as dev', async () => {
    const { ApiProvider } = await import('./ApiProviderMock')
    const mock = new ApiProvider()
    expect(mock.id).toBe(MOCK_PROVIDER_ID)
    expect(mock.label).toContain('Local')
  })

  it('remote provider id is "remote" and label reflects model', async () => {
    ENV.VITE_JARVIS_AI_PROXY_URL = '/api/ai'
    ENV.VITE_JARVIS_AI_MODEL = 'gemini-3.6-flash'
    resetAiConfigCache()
    resetProviders()

    const provider = createProviders()[0]
    expect(provider.id).toBe(REMOTE_PROVIDER_ID)
    expect(provider.label).toContain('gemini')
  })

  it('deriveAiProviderMode returns MOCK when provider is mock (regardless of reachability)', async () => {
    clearAiEnv()
    resetAiConfigCache()
    const { deriveAiProviderMode } = await import('../../types/capabilities')
    const mode = deriveAiProviderMode(MOCK_PROVIDER_ID, false)
    // When provider is mock, mode is MOCK regardless of reachability
    expect(mode).toBe('MOCK')
  })

  it('deriveAiProviderMode returns DISCONNECTED when remote configured but unreachable', async () => {
    ENV.VITE_JARVIS_AI_PROXY_URL = '/api/ai'
    ENV.VITE_JARVIS_AI_MODEL = 'gemini-3.6-flash'
    resetAiConfigCache()
    const { deriveAiProviderMode } = await import('../../types/capabilities')
    const mode = deriveAiProviderMode(REMOTE_PROVIDER_ID, false)
    // Health check determines actual mode; without running backend it's DISCONNECTED
    expect(mode).toBe('DISCONNECTED')
  })

  it('AIProviderInfo.describe() returns model and baseUrl for remote', async () => {
    ENV.VITE_JARVIS_AI_PROXY_URL = '/api/ai'
    ENV.VITE_JARVIS_AI_MODEL = 'gemini-3.6-flash'
    resetAiConfigCache()
    resetProviders()

    const provider = createProviders()[0]
    expect(typeof provider.describe).toBe('function')
    if (provider.describe) {
      const info = provider.describe()
      expect(info.model).toBe('gemini-3.6-flash')
      expect(info.baseUrl).toBe('/api/ai')
    }
  })

  it('mock provider describe() returns dev model info', async () => {
    clearAiEnv()
    resetAiConfigCache()
    resetProviders()

    const provider = createProviders()[0]
    expect(typeof provider.describe).toBe('function')
    if (provider.describe) {
      const info = provider.describe()
      expect(info.model).toBeDefined()
      expect(info.model).toContain('dev')
      expect(info.baseUrl).toBeUndefined()
    }
  })
})

describe('Phase 2 — Provider failure truthfulness (no silent mock fallback)', () => {
  it('remote provider isConfigured() returns false when not configured', async () => {
    clearAiEnv()
    resetAiConfigCache()
    const remote = new RemoteProvider()
    expect(remote.isConfigured()).toBe(false)
  })

  it('remote provider isConfigured() returns true when configured', async () => {
    ENV.VITE_JARVIS_AI_PROXY_URL = '/api/ai'
    ENV.VITE_JARVIS_AI_MODEL = 'gemini-3.6-flash'
    resetAiConfigCache()

    const remote = new RemoteProvider()
    expect(remote.isConfigured()).toBe(true)
  })

  it('remote provider isReachable() fails honestly when endpoint unreachable', async () => {
    ENV.VITE_JARVIS_AI_BASE_URL = 'https://unreachable.invalid.test'
    ENV.VITE_JARVIS_AI_MODEL = 'test-model'
    resetAiConfigCache()

    const remote = new RemoteProvider()
    const reachable = await remote.isReachable()
    expect(reachable).toBe(false)
  })

  it('remote provider generate() throws ProviderError with typed kind on network failure', async () => {
    ENV.VITE_JARVIS_AI_BASE_URL = 'https://unreachable.invalid.test'
    ENV.VITE_JARVIS_AI_MODEL = 'test-model'
    resetAiConfigCache()

    const remote = new RemoteProvider()
    const request: AIRequest = {
      prompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      context: [],
      availableTools: [],
      toolDefinitions: [],
      isNewSession: true,
    }
    const emit = vi.fn()

    await expect(remote.generate(request, emit)).rejects.toBeInstanceOf(ProviderError)
    await expect(remote.generate(request, emit)).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('remote provider generate() throws ProviderError on proxy without auth (network error)', async () => {
    ENV.VITE_JARVIS_AI_PROXY_URL = '/api/ai'
    ENV.VITE_JARVIS_AI_MODEL = 'gemini-3.6-flash'
    resetAiConfigCache()

    const remote = new RemoteProvider()
    const request: AIRequest = {
      prompt: 'test',
      messages: [{ role: 'user', content: 'test' }],
      context: [],
      availableTools: [],
      toolDefinitions: [],
      isNewSession: true,
    }
    const emit = vi.fn()

    // Without running backend, proxy fails with network error
    await expect(remote.generate(request, emit)).rejects.toBeInstanceOf(ProviderError)
  })

  it('checkAiHealth returns MISCONFIGURED when no real endpoint', async () => {
    clearAiEnv()
    resetAiConfigCache()

    const health = await checkAiHealth()
    expect(health.status).toBe('MISCONFIGURED')
    expect(health.code).toBe('MISCONFIGURED')
    expect(health.message).toContain('configured')
  })

  it('checkAiHealth never returns "MOCK" as status', async () => {
    clearAiEnv()
    resetAiConfigCache()

    const health = await checkAiHealth()
    expect(health.status).not.toBe('MOCK')
    expect(health.code).not.toBe('MOCK')
  })
})

describe('Phase 2 — Provider concurrency and determinism', () => {
  it('createProviders returns same instance on concurrent calls', async () => {
    ENV.VITE_JARVIS_AI_PROXY_URL = '/api/ai'
    ENV.VITE_JARVIS_AI_MODEL = 'gemini-3.6-flash'
    resetAiConfigCache()
    resetProviders()

    const results = await Promise.all([
      createProviders(),
      createProviders(),
      createProviders(),
    ])

    expect(results[0]).toBe(results[1])
    expect(results[1]).toBe(results[2])
    expect(results[0][0].id).toBe('remote')
  })

  it('resetProviders clears singleton for clean test isolation', async () => {
    ENV.VITE_JARVIS_AI_PROXY_URL = '/api/ai'
    ENV.VITE_JARVIS_AI_MODEL = 'gemini-3.6-flash'
    resetAiConfigCache()
    resetProviders()

    const first = createProviders()
    expect(first[0].id).toBe('remote')

    resetProviders()
    clearAiEnv()
    resetAiConfigCache()

    const second = createProviders()
    expect(second[0].id).toBe('mock')
    expect(second).not.toBe(first)
  })

  it('RemoteProvider isReachable uses bounded timeout and does not hang', async () => {
    // Use a non-routable IP to ensure fast failure
    ENV.VITE_JARVIS_AI_BASE_URL = 'https://10.255.255.1:9999'
    ENV.VITE_JARVIS_AI_MODEL = 'test'
    resetAiConfigCache()

    const remote = new RemoteProvider()
    const start = Date.now()
    const reachable = await remote.isReachable()
    const elapsed = Date.now() - start

    // Should timeout quickly (8s) not hang
    expect(elapsed).toBeLessThan(9000)
    expect(reachable).toBe(false)
  }, 15000)

  it('RemoteProvider listModels returns empty for proxy mode (cannot enumerate)', async () => {
    ENV.VITE_JARVIS_AI_PROXY_URL = '/api/ai'
    ENV.VITE_JARVIS_AI_MODEL = 'gemini-3.6-flash'
    resetAiConfigCache()

    const remote = new RemoteProvider()
    const models = await remote.listModels()
    expect(models).toEqual([])
  })
})