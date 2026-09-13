import { afterEach, describe, expect, it } from 'vitest'
import { createProviders, resetProviders } from './index'
import { resetAiConfigCache } from '../../config/ai'

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