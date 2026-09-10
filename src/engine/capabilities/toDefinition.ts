import type { ToolDefinition } from '../provider'
import { effectiveVerificationPreference } from './policy'
import type { CapabilityDefinition } from './types'

/**
 * Phase 2.3 — provider-facing shape of a capability. The model sees the
 * capability as the WHAT it wants (its own id + declared parameter hints); the
 * ENGINE resolves it to a registered tool. Parameters are hints only — the
 * resolved TOOL's schema is the enforced input contract.
 *
 * Phase 2.4 — the model may see only SAFE, high-level metadata: the
 * application-owned risk class, whether the capability is destructive, whether
 * confirmation is required, and the verification preference. It NEVER sees
 * reliability scores, ranking internals, permission ceilings or any execution
 * secret — those stay engine-owned.
 */
export function toCapabilityDefinition(def: CapabilityDefinition): ToolDefinition {
  const parameters = def.requiredParameters ?? []
  const properties: Record<string, { type: string; description?: string }> = {}
  for (const name of parameters) {
    properties[name] = { type: 'string', description: `Expected argument "${name}".` }
  }
  const meta: string[] = [`Risk: ${def.risk}`, `Destructive: ${def.destructive ? 'yes' : 'no'}`]
  if (def.requiresConfirmation) meta.push('Requires your confirmation before executing.')
  meta.push(`Verification preference: ${effectiveVerificationPreference(def)}`)
  return {
    id: def.id,
    description: `${def.name}. ${def.description} This is a capability: the engine resolves it to the registered tool that implements it. (${meta.join('; ')})`,
    parameters: { type: 'object', properties, required: [] },
  }
}