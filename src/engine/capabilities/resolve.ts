import type { Tool } from '../../tools/Tool'
import { permissionAtMost, deriveContexts } from '../agent/capabilities'
import type {
  CapabilityDefinition,
  CapabilityResolution,
  CapabilitySelectionConstraints,
  PolicyDrop,
} from './types'
import type { CapabilityRegistryLike } from './registry'
import {
  classifyToolPermission,
  deviceContextId,
  effectiveVerificationPreference,
  policyFilterTool,
  requiresCapabilityConfirmation,
} from './policy'
import { rankCapabilityCandidates } from './rank'

/**
 * Phase 2.3 + Phase 2.4 — deterministic capability → tool resolution (PURE).
 *
 * Pipeline (fully deterministic, model-immune):
 *   1. eligible tools   — declared implementation ids, deduped, restricted to
 *                         tools actually REGISTERED in the engine registry
 *   2. permission fence — optional tool `maxPermission` ceiling; tools above
 *                         it drop
 *   3. context fence    — optional tool-context requirement; tools that fit
 *                         neither that context nor `generic` drop
 *   4. availability     — optional live predicate over tool ids
 *   5. device scope     — Phase 2.4: when the request names a device, tools
 *                         that do not target it drop (a capability is never
 *                         silently re-targeted to another device)
 *   6. capability policy — Phase 2.4: application-owned permission ceiling and
 *                         strict-verification requirement (never a model
 *                         decision); dropped candidates are reported honestly
 *   7. deterministic    — Phase 2.4: lexicographic ranking: context match,
 *       ranking            risk, verification, reliability (weak), declared
 *                         preference, tool id. All keys are bounded and stable.
 *   8. selection        — first remaining candidate wins.
 *
 * Fallback is therefore BOUNDED by the declared `tools` list: when the
 * preferred implementation is not selectable, the next ranked candidate wins;
 * if none remains the resolution is `capability_unavailable` — never an
 * invented tool, never a bypass of the rails.
 */

/** Minimal structural seam over the engine&apos;s tool registry (never named here). */
export interface ToolSource {
  get(id: string): Tool | undefined
}

function verifiableTool(tool: Tool | undefined): boolean {
  return tool?.verifiable === true
}

/** The declared implementations, deduped while preserving preference order. */
function declaredImplementations(def: CapabilityDefinition): Array<{ id: string; preferredIndex: number }> {
  const seen = new Set<string>()
  const ids: Array<{ id: string; preferredIndex: number }> = []
  def.tools.forEach((id, preferredIndex) => {
    if (!seen.has(id)) {
      seen.add(id)
      ids.push({ id, preferredIndex })
    }
  })
  return ids
}

function fitsSelection(tool: Tool, constraints: CapabilitySelectionConstraints): boolean {
  if (constraints.maxPermission && !permissionAtMost(tool.permission, constraints.maxPermission)) {
    return false
  }
  if (constraints.context) {
    const contexts = deriveContexts(tool)
    if (!contexts.includes(constraints.context) && !contexts.includes('generic')) return false
  }
  if (constraints.available && !constraints.available(tool.id)) return false
  return true
}

/**
 * Resolve one registered capability to a concrete, registered tool.
 * @param capabilities the CapabilityRegistry (for the required definitions)
 * @param registry the engine tool registry (single authority over executable tools)
 */
export function resolveCapability(
  capabilityId: string,
  capabilities: CapabilityRegistryLike,
  registry: ToolSource,
  constraints: CapabilitySelectionConstraints = {},
): CapabilityResolution {
  const def = capabilities.get(capabilityId)
  if (!def) {
    return {
      ok: false,
      capability: capabilityId,
      code: 'capability_unavailable',
      reason: `Capability "${capabilityId}" is not registered, so nothing can implement it.`,
    }
  }
  return resolveDefinition(def, registry, constraints)
}

/** Resolve a capability against its definition (reusable for unit tests). */
export function resolveDefinition(
  def: CapabilityDefinition,
  registry: ToolSource,
  constraints: CapabilitySelectionConstraints = {},
): CapabilityResolution {
  const context = constraints.capabilityContext
  const deviceScope = context ? deviceContextId(context.activeDevice) : undefined
  const policyDropped: PolicyDrop[] = []

  // Steps 1–4 — declared, registered, selectable candidates.
  const candidates = declaredImplementations(def)
    .map((c) => ({ tool: registry.get(c.id), preferredIndex: c.preferredIndex }))
    .filter((c): c is { tool: Tool; preferredIndex: number } => c.tool !== undefined)
    .filter((c) => fitsSelection(c.tool, constraints))

  // Step 5 — device scope (Phase 2.4). Hard filter: never silently substitute
  // an implementation on a different device for the requested one.
  const deviceFiltered = deviceScope
    ? candidates.filter((c) => {
        if (deriveContexts(c.tool).includes(deviceScope)) return true
        policyDropped.push({
          toolId: c.tool.id,
          reason: `"${c.tool.id}" does not target the requested device "${deviceScope}".`,
        })
        return false
      })
    : candidates

  if (deviceFiltered.length === 0) {
    return {
      ok: false,
      capability: def.id,
      code: 'capability_unavailable',
      reason: deviceScope
        ? `Capability "${def.id}" has no implementation for the requested device "${deviceScope}".`
        : `Capability "${def.id}" has no registered, selectable implementation in this environment.`,
    }
  }

  // Step 6 — capability policy (Phase 2.4): application-owned permission
  // ceiling and strict-verification requirement. `policyFilterTool` is pure
  // and reads only app-owned metadata.
  const policyFiltered = deviceFiltered.filter((c) => {
    const verdict = policyFilterTool(def, c.tool, constraints, context)
    if (!verdict.keep) {
      policyDropped.push({ toolId: c.tool.id, reason: verdict.reason ?? '' })
      return false
    }
    return true
  })
  if (policyFiltered.length === 0) {
    return {
      ok: false,
      capability: def.id,
      code: 'capability_unavailable',
      reason: `Capability "${def.id}" has no implementation allowed by the application policy.`,
    }
  }

  // Step 7 — deterministic ranking (context → risk → verification →
  // reliability → declared preference → tool id).
  const ranked = rankCapabilityCandidates({ def, candidates: policyFiltered, constraints })
  const chosenId = ranked[0].toolId
  const chosenTool = policyFiltered.find((c) => c.tool.id === chosenId)!.tool

  // Step 8 — the first ranked candidate wins.
  const preferred = def.tools[0]
  const fallback = chosenId !== preferred
  const verifiable = verifiableTool(chosenTool)
  const declaredHint = def.verification
  const verificationCompatible =
    !declaredHint || declaredHint === 'none' ? true : verifiable
  const fallbackNote = fallback
    ? ` (preferred "${preferred}" unavailable — approved fallback "${chosenId}")`
    : ''
  const verificationNote = verificationCompatible
    ? ''
    : ` (note: "${chosenId}" cannot self-verify its effect)`

  const permission = classifyToolPermission(chosenTool)
  const risk = def.risk
  const verificationPreference = effectiveVerificationPreference(def)
  const requiresConfirmation = requiresCapabilityConfirmation(def)
  const rankedIds = ranked.map((r) => r.toolId)
  const rankNote = rankedIds.length > 1 ? ` ranked ["${rankedIds.join('", "')}"].` : '.'

  return {
    ok: true,
    capability: def.id,
    toolId: chosenId,
    fallback,
    preferred,
    verifiable,
    verificationCompatible,
    permission,
    risk,
    verificationPreference,
    requiresConfirmation,
    ranked: rankedIds,
    policyDropped,
    reason: `Capability "${def.id}" resolved to "${chosenId}" via deterministic ranking (risk "${risk}", permission "${permission}")${rankNote}${fallbackNote}${verificationNote}`,
  }
}

/** True when a tool id is implemented by at least one registered capability
 * (a capability may be requested directly in the `toolId` slot). */
export function registeredDefinition(
  capabilities: CapabilityRegistryLike,
  id: string,
): CapabilityDefinition | undefined {
  return capabilities.get(id)
}