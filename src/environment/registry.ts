import type { EnvironmentDefinition, VisualEnvironmentId } from './types'

/** Phase 8 — canonical environment catalogue (single source of truth). */

export const DEFAULT_ENVIRONMENT: VisualEnvironmentId = 'arc'

export const ENVIRONMENT_DEFINITIONS: readonly EnvironmentDefinition[] = [
  {
    id: 'arc',
    label: 'Arc Reactor',
    description: 'The reactor core — live 3D heart of JARVIS.',
    kind: 'webgl',
    glyph: '\u25c9',
  },
  {
    id: 'astra',
    label: 'Astra HUD',
    description: 'Concentric tactical HUD with live telemetry readouts.',
    kind: 'canvas',
    glyph: '\u2731',
  },
  {
    id: 'control',
    label: 'Control Panel',
    description: 'Live system dashboard — real values only.',
    kind: 'dom',
    glyph: '\u25a3',
  },
  {
    id: 'space',
    label: 'Space',
    description: 'Deep-space parallax field, drifting with the core state.',
    kind: 'canvas',
    glyph: '\u2726',
  },
  {
    id: 'tunnel',
    label: 'Tunnel',
    description: 'Perspective corridor flowing toward the vanishing point.',
    kind: 'canvas',
    glyph: '\u25c8',
  },
] as const

export const ENVIRONMENT_BY_ID = new Map<VisualEnvironmentId, EnvironmentDefinition>(
  ENVIRONMENT_DEFINITIONS.map((d) => [d.id, d]),
)

const ALL_IDS: readonly string[] = ENVIRONMENT_DEFINITIONS.map((d) => d.id)

export function isEnvironmentId(value: string): value is VisualEnvironmentId {
  return (ALL_IDS as readonly string[]).includes(value)
}

/** Coerce any stored value to a known environment id (sanitized, versioned). */
export function sanitizeEnvironmentId(value: string | null | undefined): VisualEnvironmentId {
  return typeof value === 'string' && isEnvironmentId(value) ? value : DEFAULT_ENVIRONMENT
}

/**
 * Next/previous id in registry order (wraps). `dir` is `1` (next) or `-1`
 * (previous). Exposed as the future gesture/voice switch primitive.
 */
export function stepEnvironment(
  current: VisualEnvironmentId,
  dir: 1 | -1,
): VisualEnvironmentId {
  const ids = ENVIRONMENT_DEFINITIONS
  const i = ids.findIndex((d) => d.id === current)
  if (i === -1) return DEFAULT_ENVIRONMENT
  const next = (i + dir + ids.length) % ids.length
  return ids[next]!.id
}

export function environmentLabel(id: VisualEnvironmentId): string {
  return ENVIRONMENT_BY_ID.get(id)?.label ?? DEFAULT_ENVIRONMENT
}