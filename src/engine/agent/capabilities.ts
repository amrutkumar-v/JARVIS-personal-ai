import type { Tool, ToolContextId, ToolPermission } from '../../tools/Tool'

/**
 * Phase 2.2 — capability metadata for bounded capability selection.
 *
 * The ToolRegistry stays the single authoritative source of what can run;
 * this module derives a stable, machine-readable description of each
 * registered capability so the engine can:
 *   - refuse steps whose capability is unavailable in the current environment
 *   - enforce a bounded permission ceiling
 *   - reason about whether a step can or must self-verify
 *   - expose "what could run" to the UI/store as a read-only mirror.
 *
 * The functions below are pure — no registry mutation, no I/O, no timing.
 */

export type { ToolContextId }

/** Constraints a caller can apply when describing a capability. */
export interface CapabilityConstraints {
  /** Live availability predicate (device/environment state, not registry). */
  available?: (toolId: string) => boolean
  /** Ceiling on permitted risk; nothing above this is selectable. */
  maxPermission?: ToolPermission
  /** Required environment/domain; tools not fitting it are not selectable. */
  context?: ToolContextId
  /** Remaining goal step budget; 0 means no more steps may be selected. */
  remainingSteps?: number
}

/** Static, machine-readable description of one registered capability. */
export interface ToolCapability {
  id: string
  name: string
  description: string
  category: Tool['category']
  /** Risk tier the tool runs under (== permission). */
  risk: ToolPermission
  /** Highest permission that still permits this capability. */
  maxPermission: ToolPermission
  readOnly: boolean
  /** True when the capability mutates state (opposite of readOnly). */
  actionable: boolean
  contexts: ToolContextId[]
  /** True when the tool can confirm its own effect. */
  verifiable: boolean
  verificationSupported: boolean
  /** Parameter names from the declared input schema. */
  parameters: string[]
  /** Registered but currently unavailable in the environment. */
  available: boolean
  /** Fits the current goal step budget. */
  fitsBudget: boolean
  /** Fits the required context/domain. */
  fitsContext: boolean
  /** Choosable given availability + permission ceiling + budget + context. */
  selectable: boolean
}

const PERMISSION_ORDER: Record<ToolPermission, number> = {
  read_only: 0,
  low_risk: 1,
  user_confirmation: 2,
  high_risk: 3,
}

export function permissionAtMost(permission: ToolPermission, ceiling: ToolPermission): boolean {
  return PERMISSION_ORDER[permission] <= PERMISSION_ORDER[ceiling]
}

/** Public risk tier a capability requires to run. */
export function requiredPermission(tool: Tool): ToolPermission {
  return tool.permission
}

/** True when a capability only reads local state. */
export function isReadOnlyCapability(tool: Tool): boolean {
  return tool.permission === 'read_only'
}

/** True when a capability changes the world (anything above read_only). */
export function isActionableCapability(tool: Tool): boolean {
  return tool.permission !== 'read_only'
}

/** Derive an environment/domain from the tool id when `contexts` is absent. */
export function deriveContexts(tool: Tool): ToolContextId[] {
  if (tool.contexts && tool.contexts.length > 0) return [...tool.contexts]
  if (tool.id.startsWith('desktop.') || tool.id.startsWith('window.')) return ['desktop']
  if (tool.id.startsWith('app.')) return ['app']
  if (tool.id.startsWith('fs.') || tool.id.startsWith('files.')) return ['files']
  if (tool.id.startsWith('web.') || tool.id.startsWith('search') || tool.id.startsWith('browser')) return ['web']
  if (tool.category === 'memory' || tool.id.startsWith('notes.') || tool.id === 'memory') return ['memory']
  return ['generic']
}

/**
 * Describe one registered tool as a capability under the given constraints.
 * Returns undefined for unknown tools. Never throws.
 */
export function describeCapability(
  tool: Tool | undefined,
  constraints: CapabilityConstraints = {},
): ToolCapability | undefined {
  if (!tool) return undefined
  const available = constraints.available ? constraints.available(tool.id) : true
  const fitsPermission = !constraints.maxPermission || permissionAtMost(tool.permission, constraints.maxPermission)
  const fitsBudget = constraints.remainingSteps === undefined || constraints.remainingSteps > 0
  const contexts = deriveContexts(tool)
  const fitsContext = !constraints.context || contexts.includes(constraints.context) || contexts.includes('generic')
  const verifiable = tool.verifiable === true
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    category: tool.category,
    risk: tool.permission,
    maxPermission: tool.permission,
    readOnly: isReadOnlyCapability(tool),
    actionable: isActionableCapability(tool),
    contexts,
    verifiable,
    verificationSupported: verifiable,
    parameters: tool.inputSchema.properties ? Object.keys(tool.inputSchema.properties) : [],
    available,
    fitsBudget,
    fitsContext,
    selectable: available && fitsPermission && fitsBudget && fitsContext,
  }
}

/** Resolve a capability from a registry-backed lookup, or undefined. */
export function resolveCapability(
  toolId: string,
  registry: { get(id: string): Tool | undefined },
  constraints: CapabilityConstraints = {},
): ToolCapability | undefined {
  return describeCapability(registry.get(toolId), constraints)
}

/** Deterministic, sorted catalog of every registered capability. */
export function capabilityCatalog(
  registry: { ids(): string[]; get(id: string): Tool | undefined },
  constraints: CapabilityConstraints = {},
): ToolCapability[] {
  return registry
    .ids()
    .map((id) => describeCapability(registry.get(id), constraints))
    .filter((c): c is ToolCapability => c !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id))
}