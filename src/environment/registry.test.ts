import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENT_BY_ID,
  ENVIRONMENT_DEFINITIONS,
  environmentLabel,
  isEnvironmentId,
  sanitizeEnvironmentId,
  stepEnvironment,
} from './registry'
import type { EnvironmentKind, VisualEnvironmentId } from './types'

const ALL_KINDS: readonly EnvironmentKind[] = ['webgl', 'canvas', 'dom']

describe('environment registry', () => {
  it('exposes exactly the six canonical environments', () => {
    const ids = ENVIRONMENT_DEFINITIONS.map((d) => d.id)
    expect(ids).toEqual(['arc', 'astra', 'control', 'space', 'tunnel', 'neural'])
  })

  it('has globally unique ids with valid kinds', () => {
    expect(new Set(ENVIRONMENT_DEFINITIONS.map((d) => d.id)).size).toBe(
      ENVIRONMENT_DEFINITIONS.length,
    )
    for (const def of ENVIRONMENT_DEFINITIONS) {
      expect(ALL_KINDS).toContain(def.kind)
      expect(def.label.length).toBeGreaterThan(0)
      expect(def.glyph.length).toBeGreaterThan(0)
    }
  })

  it('builds a lookup map that covers every definition', () => {
    for (const def of ENVIRONMENT_DEFINITIONS) {
      expect(ENVIRONMENT_BY_ID.get(def.id)?.id).toBe(def.id)
    }
  })

  it('has the Arc Reactor as default', () => {
    expect(DEFAULT_ENVIRONMENT).toBe('arc')
  })
})

describe('environment id guards', () => {
  it('accepts every canonical id', () => {
    for (const def of ENVIRONMENT_DEFINITIONS) {
      expect(isEnvironmentId(def.id)).toBe(true)
    }
  })

  it('rejects unknown strings', () => {
    expect(isEnvironmentId('magic')).toBe(false)
    expect(isEnvironmentId('')).toBe(false)
  })

  it('sanitizes to the default for invalid or missing values', () => {
    expect(sanitizeEnvironmentId('tunnel')).toBe('tunnel')
    expect(sanitizeEnvironmentId('nope')).toBe(DEFAULT_ENVIRONMENT)
    expect(sanitizeEnvironmentId(null)).toBe(DEFAULT_ENVIRONMENT)
    expect(sanitizeEnvironmentId(undefined)).toBe(DEFAULT_ENVIRONMENT)
  })
})

describe('environment stepping', () => {
  it('walks forward through the registry and wraps', () => {
    expect(stepEnvironment('arc', 1)).toBe('astra')
    expect(stepEnvironment('astra', 1)).toBe('control')
    expect(stepEnvironment('control', 1)).toBe('space')
    expect(stepEnvironment('space', 1)).toBe('tunnel')
    expect(stepEnvironment('tunnel', 1)).toBe('neural')
    expect(stepEnvironment('neural', 1)).toBe('arc')
  })

  it('walks backward through the registry and wraps', () => {
    expect(stepEnvironment('arc', -1)).toBe('neural')
    expect(stepEnvironment('neural', -1)).toBe('tunnel')
    expect(stepEnvironment('tunnel', -1)).toBe('space')
    expect(stepEnvironment('space', -1)).toBe('control')
    expect(stepEnvironment('control', -1)).toBe('astra')
    expect(stepEnvironment('astra', -1)).toBe('arc')
  })

  it('falls back to the default for unknown ids', () => {
    expect(stepEnvironment('nope' as VisualEnvironmentId, 1)).toBe(DEFAULT_ENVIRONMENT)
  })

  it('returns the canonical label', () => {
    expect(environmentLabel('astra')).toBe('Astra HUD')
    expect(environmentLabel('arc')).toBe('Arc Reactor')
  })
})