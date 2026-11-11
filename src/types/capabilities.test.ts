import { describe, expect, it } from 'vitest'
import { deriveAiProviderMode } from './capabilities'

describe('AI runtime status', () => {
  it('reports REAL only when a non-mock provider is reachable', () => {
    expect(deriveAiProviderMode('remote', true)).toBe('REAL')
    expect(deriveAiProviderMode('remote', false)).toBe('DISCONNECTED')
  })

  it('labels the development mock as MOCK even though it is callable', () => {
    expect(deriveAiProviderMode('mock', true)).toBe('MOCK')
    expect(deriveAiProviderMode('mock', false)).toBe('MOCK')
  })
})
