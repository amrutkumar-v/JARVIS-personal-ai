import type { Tool } from '../../tools/Tool'
import { deriveContexts } from '../agent/capabilities'
import {
  classifyToolRisk,
  effectiveVerificationPreference,
  riskRank,
  toolVerificationStrength,
} from './policy'
import { reliabilityScore } from './reliability'
import type {
  CapabilityContext,
  CapabilityDefinition,
  CapabilitySelectionConstraints,
} from './types'

/**
 * Phase 2.4 — deterministic, explainable IMPLEMENTATION RANKING (PURE).
 *
 * When several registered tools can implement one capability, this module
 * orders them so resolution is both clever and safe. Ordering is a lexicographic
 * sort over BOUNDED, STABLE keys — no chance, no arithmetic on free text:
 *
 *   1. context match      (ranking signal; device scope is a hard filter elsewhere)
 *   2. lower risk first   (tool risk class; highest-priority objective ordering)
 *   3. verification       (prefer evidence-producing tools, per app-owned policy)
 *   4. reliability        (WEAK signal — strictly below risk & verification)
 *   5. declared preference (application-authored `tools` order)
 *   6. tool id            (lexicographic — guarantees determinism)
 *
 * Because reliability and tie-breaks are strictly lower-priority keys, a
 * historically successful tool can NEVER outrank a safer, more verifiable, or
 * permission-compatible one — the safety objectives always dominate.
 */

export interface RankedCandidate {
  toolId: string
  /** The lexicographic sort key (ascending = better). Used for explainability. */
  keys: number[]
  contextMatched: boolean
  verifiable: boolean
}

export interface RankInput {
  /** The capability being resolved (source of app-owned preference/verification). */
  def: CapabilityDefinition
  /** Registered, selectable candidate tools with their declared index. */
  candidates: Array<{ tool: Tool; preferredIndex: number }>
  constraints: Pick<CapabilitySelectionConstraints, 'preferVerifiable' | 'capabilityContext' | 'reliability'>
}

/** True when a tool can act on applications (context-derived or declared). */
function toolTargetsApps(tool: Tool): boolean {
  if (deriveContexts(tool).includes('app')) return true
  const keys = Object.keys(tool.inputSchema.properties ?? {})
  return keys.some((k) => k === 'app' || k === 'app_key' || k === 'application' || k === 'appId')
}

/** Deterministic boolean: does the tool fit the bounded context signals? */
export function contextMatchScore(context: CapabilityContext | undefined, tool: Tool): boolean {
  if (!context) return true
  let signals = false
  let matched = true
  if (context.activeApplication !== undefined) {
    signals = true
    matched = matched && toolTargetsApps(tool)
  }
  if (context.availableApplications !== undefined && context.availableApplications.length > 0) {
    signals = true
    matched = matched && toolTargetsApps(tool)
  }
  if (context.interactionMode === 'visual') {
    signals = true
    matched = matched && deriveContexts(tool).includes('camera')
  }
  // `activeDevice`/`availableDevices` are handled as a HARD scope filter by the
  // resolver (a capability is never silently re-targeted to another device);
  // they are intentionally not a soft ranking signal here.
  return !signals || matched
}

function verificationKey(def: CapabilityDefinition, preferVerifiable: boolean, tool: Tool): number {
  if (preferVerifiable) return toolVerificationStrength(tool) === 'strong' ? 0 : 1
  const preference = effectiveVerificationPreference(def)
  // `normal` (the default) is NEUTRAL — it never outranks the application's
  // declared implementation order. Only explicit app preferences reorder.
  if (preference === 'normal' || preference === 'weak') return 0
  return toolVerificationStrength(tool) === 'strong' ? 0 : 1
}

/**
 * Rank the eligible candidates, best-first, deterministically. Never mutates
 * inputs and never consults runtime state beyond the supplied pure inputs.
 */
export function rankCapabilityCandidates(input: RankInput): RankedCandidate[] {
  const { def, candidates, constraints } = input
  const context = constraints.capabilityContext

  const ranked = candidates.map<{ candidate: RankedCandidate; tool: Tool }>(({ tool, preferredIndex }) => {
    const keys = [
      contextMatchScore(context, tool) ? 0 : 1,
      riskRank(classifyToolRisk(tool)),
      verificationKey(def, constraints.preferVerifiable === true, tool),
      constraints.reliability ? 1 - reliabilityScore(constraints.reliability, def.id, tool.id) : 0,
      preferredIndex,
    ]
    return {
      candidate: {
        toolId: tool.id,
        keys,
        contextMatched: contextMatchScore(context, tool),
        verifiable: tool.verifiable === true,
      },
      tool,
    }
  })

  ranked.sort((a, b) => {
    const ka = a.candidate.keys
    const kb = b.candidate.keys
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i]
    }
    return a.candidate.toolId.localeCompare(b.candidate.toolId)
  })

  return ranked.map((r) => r.candidate)
}

/** Legend for the sort keys (Ordered for readable rationales, never on-chain). */
export function rankKeyLegend(): string[] {
  return ['context', 'risk', 'verification', 'reliability', 'declared preference', 'tool id']
}