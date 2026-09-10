import { describe, expect, it } from 'vitest'
import type { Tool, ToolPermission, ToolCategory, ToolResult } from '../../tools/Tool'
import { contextMatchScore, rankCapabilityCandidates } from './rank'
import { recordReliability } from './reliability'
import type { CapabilityDefinition, CapabilityReliabilityIndex } from './types'

/**
 * Phase 2.4 — deterministic implementation RANKING (pure).
 * Lexicographic keys [context, risk, verification, reliability (weak),
 * declared preference, tool id]. Reliability/context can never outrank
 * risk/verification.
 */

class BaseTool implements Tool {
  id = 'base'
  category: ToolCategory = 'compute'
  name = 'Base'
  description = 'base tool'
  permission: ToolPermission = 'read_only'
  inputSchema = { type: 'object' as const, properties: {}, required: [] }
  requiresPermission = false
  verifiable?: boolean = true
  canRun: () => boolean = () => true
  execute: () => Promise<ToolResult> = async () => ({ ok: true, message: 'ok' })
}

function tool(id: string, overrides: Partial<BaseTool> = {}): Tool {
  return Object.assign(new BaseTool(), { id, ...overrides })
}

function def(overrides: Partial<CapabilityDefinition> = {}): CapabilityDefinition {
  return {
    id: 'cap',
    name: 'Cap',
    description: 'does cap',
    category: 'compute',
    tools: [],
    contexts: ['generic'],
    risk: 'low',
    destructive: false,
    readOnly: false,
    riskLevel: 'low_risk',
    ...overrides,
  } as CapabilityDefinition
}

function candidate(_toolId: string, preferredIndex: number, t: Tool): { tool: Tool; preferredIndex: number } {
  return { tool: t, preferredIndex }
}

describe('Phase 2.4 — contextMatchScore (pure)', () => {
  it('matches everything when no context signals exist', () => {
    expect(contextMatchScore(undefined, tool('window.status'))).toBe(true)
    expect(contextMatchScore({}, tool('window.status'))).toBe(true)
  })

  it('boosts app-targeting tools when an app is active', () => {
    expect(contextMatchScore({ activeApplication: 'notes' }, tool('app.launch', { inputSchema: { type: 'object' as const, properties: { app: { type: 'string' } }, required: [] } }))).toBe(true)
    expect(contextMatchScore({ availableApplications: ['notes'] }, tool('window.status'))).toBe(false)
  })

  it('boosts camera-derived tools in visual mode but stays neutral otherwise', () => {
    expect(contextMatchScore({ interactionMode: 'visual' }, tool('vision.screen') as Tool)).toBe(false)
    // deriveContexts for this synthetic tool is 'generic', so visual requires 'camera'.
    expect(contextMatchScore({ interactionMode: 'text' }, tool('vision.screen'))).toBe(true)
  })
})

describe('Phase 2.4 — rankCapabilityCandidates (deterministic)', () => {
  it('keeps the declared application order on a neutral setup', () => {
    const a = tool('window.list', { verifiable: false })
    const b = tool('window.status')
    const ranked = rankCapabilityCandidates({
      def: def(),
      candidates: [candidate('window.list', 0, a), candidate('window.status', 1, b)],
      constraints: {},
    })
    expect(ranked.map((r) => r.toolId)).toEqual(['window.list', 'window.status'])
  })

  it('orders lower-risk tools before higher-risk ones', () => {
    const low = tool('window.status') // read_only → risk read_only
    const med = tool('desktop.click', { permission: 'user_confirmation' }) // risk medium
    const ranked = rankCapabilityCandidates({
      def: def(),
      candidates: [candidate('desktop.click', 0, med), candidate('window.status', 1, low)],
      constraints: {},
    })
    expect(ranked.map((r) => r.toolId)).toEqual(['window.status', 'desktop.click'])
  })

  it('prefers verifiable tools when preferVerifiable is set, even below declared order', () => {
    const a = tool('window.list', { verifiable: false }) // declared first
    const b = tool('window.status') // verifiable
    const ranked = rankCapabilityCandidates({
      def: def(),
      candidates: [candidate('window.list', 0, a), candidate('window.status', 1, b)],
      constraints: { preferVerifiable: true },
    })
    expect(ranked.map((r) => r.toolId)).toEqual(['window.status', 'window.list'])
  })

  it('is NEUTRAL for the default verification preference: never reorders declared order', () => {
    const a = tool('window.list', { verifiable: false })
    const b = tool('window.status')
    // verification 'none'/'normal' → normal → neutral key 0; declared order wins.
    const ranked = rankCapabilityCandidates({
      def: def({ verification: 'none' }),
      candidates: [candidate('window.list', 0, a), candidate('window.status', 1, b)],
      constraints: {},
    })
    expect(ranked.map((r) => r.toolId)).toEqual(['window.list', 'window.status'])
  })

  it('a strong application preference reorders by verification even without preferVerifiable', () => {
    const a = tool('window.list', { verifiable: false })
    const b = tool('window.status')
    const ranked = rankCapabilityCandidates({
      def: def({ preferredVerification: 'strong' }),
      candidates: [candidate('window.list', 0, a), candidate('window.status', 1, b)],
      constraints: {},
    })
    expect(ranked.map((r) => r.toolId)).toEqual(['window.status', 'window.list'])
  })

  it('reliability is a weak key: it only breaks ties below risk and verification', () => {
    let reliability: CapabilityReliabilityIndex = new Map()
    reliability = recordReliability(reliability, 'cap', 'window.status', 'verified_success')
    // Both candidates: same risk (read_only), neutral verification, so the
    // reliability history (`window.status` 1.0 vs `window.list` 0.5) can break
    // the declared tie — but ONLY across identical safety keys.
    const a = tool('window.list', { verifiable: false })
    const b = tool('window.status')
    const ranked = rankCapabilityCandidates({
      def: def(),
      candidates: [candidate('window.list', 0, a), candidate('window.status', 1, b)],
      constraints: { reliability },
    })
    expect(ranked.map((r) => r.toolId)).toEqual(['window.status', 'window.list'])
  })

  it('reliability can NEVER outrank a risk difference', () => {
    let reliability: CapabilityReliabilityIndex = new Map()
    reliability = recordReliability(reliability, 'cap', 'desktop.click', 'verified_success')
    const risky = tool('desktop.click', { permission: 'user_confirmation' }) // risk medium, reliable
    const tame = tool('window.status') // risk read_only, no history
    const ranked = rankCapabilityCandidates({
      def: def(),
      candidates: [candidate('desktop.click', 0, risky), candidate('window.status', 1, tame)],
      constraints: { reliability },
    })
    // The safer tool wins despite the reliable one being declared first.
    expect(ranked.map((r) => r.toolId)).toEqual(['window.status', 'desktop.click'])
  })

  it('breaks perfect ties with the tool id (determinism)', () => {
    const a = tool('z.tool')
    const b = tool('a.tool')
    // Identical preferredIndex (e.g. a fallback-added candidate): every safety
    // key ties, so the deterministic tool-id tie-break decides.
    const first = rankCapabilityCandidates({
      def: def(),
      candidates: [candidate('z.tool', 5, a), candidate('a.tool', 5, b)],
      constraints: {},
    })
    const second = rankCapabilityCandidates({
      def: def(),
      candidates: [candidate('z.tool', 5, a), candidate('a.tool', 5, b)],
      constraints: {},
    })
    expect(first.map((r) => r.toolId)).toEqual(['a.tool', 'z.tool'])
    expect(second.map((r) => r.toolId)).toEqual(first.map((r) => r.toolId))
  })

  it('annotates context and verifiability per candidate for explainability', () => {
    const a = tool('window.list', { verifiable: false })
    const b = tool('window.status')
    const ranked = rankCapabilityCandidates({
      def: def(),
      candidates: [candidate('window.list', 0, a), candidate('window.status', 1, b)],
      constraints: { preferVerifiable: true },
    })
    expect(ranked[0]).toMatchObject({ toolId: 'window.status', contextMatched: true, verifiable: true })
    expect(ranked[1]).toMatchObject({ toolId: 'window.list', contextMatched: true, verifiable: false })
    expect(ranked[0].keys.length).toBe(5)
  })
})