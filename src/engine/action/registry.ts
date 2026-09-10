import type { Tool } from '../../tools/Tool'
import type { CapabilityDefinition } from '../capabilities/types'
import type { ActionRegistryView, ActionToolView, ActionCapabilityView } from './types'

/**
 * Phase 2.6 — read-only registry view for the action layer.
 *
 * A PURE projection over the arrays the ENGINE already owns (the tool registry
 * and the capability registry). It never mutates those registries and never
 * registers anything — it only exposes a stable, bounded lookup surface so the
 * classifier and the engine can ask "does a real mechanism understand this
 * request?" WITHOUT the deterministic layer touching engine internals.
 */

export interface ToolMatch {
  toolId: string
  label: string
  permission: string
}

export interface RequestToolMatches {
  matches: ToolMatch[]
  /** True when at least one registered tool's `canRun` understood the text. */
  matched: boolean
}

/** Stable lookup surface the engine builds from its live registries. */
export function createActionRegistryView(
  tools: readonly Tool[],
  capabilities: readonly CapabilityDefinition[],
): ActionRegistryView {
  const tool = (t: Tool): ActionToolView => ({
    id: t.id,
    label: t.name,
    permission: t.permission,
    canRun: (query: string) => t.canRun(query),
  })
  const cap = (c: CapabilityDefinition): ActionCapabilityView => ({
    id: c.id,
    label: c.name,
    description: c.description,
    toolIds: [...c.tools],
  })
  return {
    tools: tools.map(tool),
    capabilities: capabilities.map(cap),
  }
}

export function hasTool(view: ActionRegistryView, toolId: string): boolean {
  return view.tools.some((t) => t.id === toolId)
}

export function hasCapability(view: ActionRegistryView, capabilityId: string): boolean {
  return view.capabilities.some((c) => c.id === capabilityId)
}

export function lookupTool(view: ActionRegistryView, toolId: string): ActionToolView | undefined {
  return view.tools.find((t) => t.id === toolId)
}

/**
 * Deterministic pre-selection: which registered tools' `canRun` already
 * understand this request. The ENGINE uses the ids purely as a planning hint
 * for the provider; execution still requires the full permission/validation/
 * verification rails.
 */
export function selectToolsForRequest(view: ActionRegistryView, text: string): RequestToolMatches {
  const matches: ToolMatch[] = []
  for (const tool of view.tools) {
    try {
      if (tool.canRun(text)) {
        matches.push({ toolId: tool.id, label: tool.label, permission: tool.permission })
      }
    } catch {
      // A malformed canRun must never break request routing.
    }
  }
  if (matches.length > 1) {
    matches.sort((a, b) => a.toolId.localeCompare(b.toolId))
  }
  return { matches, matched: matches.length > 0 }
}

/** Capability ids whose name/description mention a domain keyword. */
export function selectCapabilitiesForDomain(
  view: ActionRegistryView,
  keywords: readonly string[],
): string[] {
  if (keywords.length === 0) return []
  const found = new Set<string>()
  const needle = keywords.join('|')
  const re = new RegExp(`\\b(${needle})\\b`, 'i')
  for (const cap of view.capabilities) {
    if (re.test(cap.label) || re.test(cap.description)) found.add(cap.id)
  }
  return [...found].sort()
}