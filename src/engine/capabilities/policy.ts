import type { Tool, ToolContextId } from '../../tools/Tool'
import type {
  CapabilityContext,
  CapabilityDefinition,
  CapabilityPermission,
  CapabilityRisk,
  PreferredVerification,
} from './types'

/**
 * Phase 2.4 — capability POLICY (pure, application-owned).
 *
 * Deterministic policy decisions that shape capability resolution WITHOUT
 * touching any enforcement: these functions only decide which registered tools
 * are ALLOWED to represent a capability and what runtime obligations (e.g.
 * confirmation) the application attaches to it. The existing execution rails
 * (permission gate, budgets, verification, cancellation) remain the backstop —
 * this layer never grants, never overrides, never bypasses.
 *
 * Every rule here is driven by application-owned metadata (the capability
 * definition), never by the model, and is fully deterministic.
 */

/** Bounded order over capability-permission classes. A class is "at most"
 * another class when its rank does not exceed the ceiling's rank. */
export const CAPABILITY_PERMISSION_ORDER: Record<CapabilityPermission, number> = {
  read: 0,
  write: 1,
  external_communication: 2,
  device_control: 3,
  financial: 3,
  destructive: 4,
}

export function permissionClassAtMost(
  permission: CapabilityPermission,
  ceiling: CapabilityPermission,
): boolean {
  return CAPABILITY_PERMISSION_ORDER[permission] <= CAPABILITY_PERMISSION_ORDER[ceiling]
}

/** Deterministic capability-permission class of a REGISTERED tool, derived
 * only from the tool's own permission tier. */
export function classifyToolPermission(tool: Tool): CapabilityPermission {
  switch (tool.permission) {
    case 'read_only':
      return 'read'
    case 'low_risk':
      return 'write'
    case 'user_confirmation':
      return 'device_control'
    case 'high_risk':
      return 'destructive'
  }
}

/** Bounded order over the application-owned risk classes. */
export const CAPABILITY_RISK_ORDER: Record<CapabilityRisk, number> = {
  read_only: 0,
  low: 1,
  medium: 2,
  high: 3,
}

export function riskRank(risk: CapabilityRisk): number {
  return CAPABILITY_RISK_ORDER[risk]
}

/** Deterministic risk class of a REGISTERED tool (from its permission tier). */
export function classifyToolRisk(tool: Tool): CapabilityRisk {
  switch (tool.permission) {
    case 'read_only':
      return 'read_only'
    case 'low_risk':
      return 'low'
    case 'user_confirmation':
      return 'medium'
    case 'high_risk':
      return 'high'
  }
}

/** Map the legacy advisory tier to the Phase 2.4 risk class. */
export function riskFromLevel(level: CapabilityDefinition['riskLevel']): CapabilityRisk {
  switch (level) {
    case 'read_only':
      return 'read_only'
    case 'low_risk':
      return 'low'
    case 'action':
      return 'medium'
    case 'sensitive_action':
      return 'high'
  }
}

/** Effective verification preference for ranking. Derives from the Phase 2.4
 * field, falling back to the legacy declaration. Deterministic. */
export function effectiveVerificationPreference(
  def: Pick<CapabilityDefinition, 'preferredVerification' | 'verification'>,
): PreferredVerification {
  if (def.preferredVerification) return def.preferredVerification
  switch (def.verification) {
    case 'strong':
      return 'strong'
    case 'weak':
    case 'none':
    case undefined:
      return 'normal'
  }
}

/** Whether a registered tool can produce confirmable evidence of its effect. */
export function toolVerificationStrength(tool: Tool): 'strong' | 'weak' {
  return tool.verifiable === true ? 'strong' : 'weak'
}

/** Whether a capability step MUST be confirmed by the application policy. */
export function requiresCapabilityConfirmation(def: CapabilityDefinition | undefined): boolean {
  return def?.requiresConfirmation === true
}

/**
 * Map a device label to a bounded device context id. Deterministic and
 * conservative: unknown devices get no code and therefore no device scope.
 * The four trusted ecosystem ids map to their real scopes (victus/dell are
 * desktops, s26/s23 are phones).
 */
export function deviceContextId(device: string | undefined): ToolContextId | undefined {
  if (!device) return undefined
  const d = device.trim().toLowerCase()
  if (d === 'phone' || d === 'android' || d === 'tablet' || d === 'mobile' || d === 's26-ultra' || d === 's23-fe') return 'android'
  if (d === 'desktop' || d === 'pc' || d === 'computer' || d === 'laptop' || d === 'windows' || d === 'victus-5050' || d === 'dell-laptop') return 'desktop'
  return undefined
}

/** True when a strict (binding) verification requirement is in force. */
export function verificationRequired(
  constraints: { requireVerification?: boolean },
  context: CapabilityContext | undefined,
): boolean {
  return constraints.requireVerification === true || context?.requiresVerification === true
}

/**
 * Deterministic policy verdict for one candidate tool of a capability.
 * `false` drops the candidate with a readable reason. NEVER an execution
 * decision: the engine's rails remain the authority for actually running.
 */
export function policyFilterTool(
  def: CapabilityDefinition,
  tool: Tool,
  constraints: { requireVerification?: boolean },
  context: CapabilityContext | undefined,
): { keep: boolean; reason?: string } {
  // 1. Application-owned permission ceiling (bounded policy layer).
  if (def.maximumPermission) {
    const cls = classifyToolPermission(tool)
    if (!permissionClassAtMost(cls, def.maximumPermission)) {
      return {
        keep: false,
        reason: `"${tool.id}" requires permission class "${cls}", above the capability ceiling "${def.maximumPermission}".`,
      }
    }
  }
  // 2. Strict verification requirement: never silently downgrade to a tool
  //    that cannot confirm its own effect.
  if (verificationRequired(constraints, context) && toolVerificationStrength(tool) === 'weak') {
    return {
      keep: false,
      reason: `"${tool.id}" cannot self-verify its effect and the request requires verification.`,
    }
  }
  return { keep: true }
}