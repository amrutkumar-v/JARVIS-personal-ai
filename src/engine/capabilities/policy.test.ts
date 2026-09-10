import { describe, expect, it } from 'vitest'
import type { Tool, ToolPermission, ToolCategory, ToolResult } from '../../tools/Tool'
import {
  CAPABILITY_PERMISSION_ORDER,
  CAPABILITY_RISK_ORDER,
  classifyToolPermission,
  classifyToolRisk,
  deviceContextId,
  effectiveVerificationPreference,
  permissionClassAtMost,
  policyFilterTool,
  requiresCapabilityConfirmation,
  riskFromLevel,
  riskRank,
  toolVerificationStrength,
  verificationRequired,
} from './policy'
import type { CapabilityDefinition } from './types'

/**
 * Phase 2.4 — application-owned capability POLICY (pure, deterministic).
 * The policy layer only decides which registered tools are ALLOWED and what
 * obligations attach; it never grants, never overrides, never executes.
 */

class BaseTool implements Tool {
  id = 'base'
  category: ToolCategory = 'compute'
  name = 'Base'
  description = 'base tool'
  permission: ToolPermission = 'read_only'
  inputSchema = { type: 'object' as const, properties: {}, required: [] }
  requiresPermission = false
  verifiable?: boolean
  canRun: () => boolean = () => true
  execute: () => Promise<ToolResult> = async () => ({ ok: true, message: 'ok' })
}

function tool(overrides: Partial<BaseTool> = {}): Tool {
  return Object.assign(new BaseTool(), overrides)
}

function def(overrides: Partial<CapabilityDefinition> = {}): CapabilityDefinition {
  return {
    id: 'capability_x',
    name: 'Capability X',
    description: 'does x',
    category: 'compute',
    tools: ['base'],
    contexts: ['generic'],
    risk: 'low',
    destructive: false,
    readOnly: false,
    riskLevel: 'low_risk',
    ...overrides,
  } as CapabilityDefinition
}

describe('Phase 2.4 — capability policy functions (pure)', () => {
  it('orders permission classes with bounded vocabulary', () => {
    expect(CAPABILITY_PERMISSION_ORDER.read).toBe(0)
    expect(CAPABILITY_PERMISSION_ORDER.write).toBe(1)
    expect(CAPABILITY_PERMISSION_ORDER.external_communication).toBe(2)
    expect(CAPABILITY_PERMISSION_ORDER.device_control).toBe(3)
    expect(CAPABILITY_PERMISSION_ORDER.financial).toBe(3)
    expect(CAPABILITY_PERMISSION_ORDER.destructive).toBe(4)
    expect(permissionClassAtMost('write', 'device_control')).toBe(true)
    expect(permissionClassAtMost('device_control', 'write')).toBe(false)
    expect(permissionClassAtMost('financial', 'device_control')).toBe(true)
    expect(permissionClassAtMost('destructive', 'destructive')).toBe(true)
  })

  it('classifies a registered tool permission tier into a capability class', () => {
    expect(classifyToolPermission(tool({ permission: 'read_only' }))).toBe('read')
    expect(classifyToolPermission(tool({ permission: 'low_risk' }))).toBe('write')
    expect(classifyToolPermission(tool({ permission: 'user_confirmation' }))).toBe('device_control')
    expect(classifyToolPermission(tool({ permission: 'high_risk' }))).toBe('destructive')
  })

  it('classifies tool risk and maps legacy tiers deterministically', () => {
    expect(classifyToolRisk(tool({ permission: 'read_only' }))).toBe('read_only')
    expect(classifyToolRisk(tool({ permission: 'low_risk' }))).toBe('low')
    expect(classifyToolRisk(tool({ permission: 'user_confirmation' }))).toBe('medium')
    expect(classifyToolRisk(tool({ permission: 'high_risk' }))).toBe('high')
    expect(riskFromLevel('read_only')).toBe('read_only')
    expect(riskFromLevel('low_risk')).toBe('low')
    expect(riskFromLevel('action')).toBe('medium')
    expect(riskFromLevel('sensitive_action')).toBe('high')
    expect(riskRank('read_only')).toBe(CAPABILITY_RISK_ORDER.read_only)
    expect(riskRank('high')).toBeGreaterThan(riskRank('read_only'))
  })

  it('derives the effective verification preference from Phase 2.4 field first', () => {
    expect(effectiveVerificationPreference(def({ preferredVerification: 'strong' }))).toBe('strong')
    expect(effectiveVerificationPreference(def({ preferredVerification: 'weak' }))).toBe('weak')
    expect(effectiveVerificationPreference(def({ preferredVerification: 'normal' }))).toBe('normal')
    // Legacy fallback: strong → strong; weak/none/undefined → normal.
    expect(effectiveVerificationPreference(def({ verification: 'strong' }))).toBe('strong')
    expect(effectiveVerificationPreference(def({ verification: 'weak' }))).toBe('normal')
    expect(effectiveVerificationPreference(def({ verification: 'none' }))).toBe('normal')
    expect(effectiveVerificationPreference(def({ verification: undefined }))).toBe('normal')
  })

  it('measures a tool verification strength from its own contract only', () => {
    expect(toolVerificationStrength(tool({ verifiable: true }))).toBe('strong')
    expect(toolVerificationStrength(tool({ verifiable: false }))).toBe('weak')
    expect(toolVerificationStrength(tool())).toBe('weak')
  })

  it('requires confirmation only when the APPLICATION policy marks it', () => {
    expect(requiresCapabilityConfirmation(def())).toBe(false)
    expect(requiresCapabilityConfirmation(def({ requiresConfirmation: true }))).toBe(true)
    expect(requiresCapabilityConfirmation(undefined)).toBe(false)
  })

  it('maps device labels to bounded context ids, unknown stay unscoped', () => {
    expect(deviceContextId('phone')).toBe('android')
    expect(deviceContextId('Android')).toBe('android')
    expect(deviceContextId(' tablet ')).toBe('android')
    expect(deviceContextId('desktop')).toBe('desktop')
    expect(deviceContextId('WINDOWS')).toBe('desktop')
    expect(deviceContextId('cloud')).toBeUndefined()
    expect(deviceContextId(undefined)).toBeUndefined()
  })

  it('treats strict verification as binding only when required', () => {
    expect(verificationRequired({}, undefined)).toBe(false)
    expect(verificationRequired({ requireVerification: true }, undefined)).toBe(true)
    expect(verificationRequired({}, { requiresVerification: true })).toBe(true)
  })

  it('policyFilterTool drops tools above the application permission ceiling', () => {
    const ceiling = def({ maximumPermission: 'read' })
    const verdict = policyFilterTool(ceiling, tool({ permission: 'low_risk' }), {}, undefined)
    expect(verdict.keep).toBe(false)
    expect(verdict.reason).toMatch(/above the capability ceiling/)
    // At or below the ceiling → kept.
    expect(policyFilterTool(ceiling, tool({ permission: 'read_only' }), {}, undefined).keep).toBe(true)
  })

  it('policyFilterTool never silently downgrades verification when it is required', () => {
    const strict = def()
    const weak = tool({ verifiable: false })
    const strong = tool({ verifiable: true })
    expect(policyFilterTool(strict, weak, { requireVerification: true }, undefined)).toMatchObject({
      keep: false,
      reason: expect.stringContaining('cannot self-verify'),
    })
    expect(policyFilterTool(strict, strong, { requireVerification: true }, undefined).keep).toBe(true)
    // Without the requirement the weak tool is still allowed by policy.
    expect(policyFilterTool(strict, weak, {}, undefined).keep).toBe(true)
    // Context can also carry the requirement.
    expect(policyFilterTool(strict, weak, {}, { requiresVerification: true }).keep).toBe(false)
  })

  it('policy decisions never depend on the model or runtime state', () => {
    // The gate reads only app-owned metadata + tool contracts.
    expect(policyFilterTool(def(), tool(), {}, undefined).keep).toBe(true)
  })
})