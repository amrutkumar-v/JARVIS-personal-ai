/**
 * Phase 2.3 + Phase 2.4 — Universal Software Capability Layer.
 *
 * Pure contracts and deterministic resolution ONLY: no providers, no I/O, no
 * tool execution, no registry mutation from the model. The engine owns
 * orchestration; these helpers decide WHAT capability a plan step means and
 * WHICH registered tool implements it — bounded, deterministic, and never a
 * bypass of the existing execution rails.
 *
 * Phase 2.4 adds capability intelligence and personalization on top of the
 * same pure layer: application-owned risk metadata, a bounded permission
 * ceiling vocabulary, deterministic implementation ranking, bounded
 * reliability history (a weak signal), and safe, explainable fallback.
 */
export { CapabilityRegistry } from './registry'
export { resolveCapability, resolveDefinition } from './resolve'
export type { ToolSource } from './resolve'
export { DEFAULT_CAPABILITIES, PARAM_HINTS } from './defaults'
export { toCapabilityDefinition } from './toDefinition'
export {
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
export { rankCapabilityCandidates, contextMatchScore, rankKeyLegend } from './rank'
export type { RankedCandidate, RankInput } from './rank'
export { MAX_RELIABILITY_COUNTER, recordReliability, reliabilityKey, reliabilityScore } from './reliability'
export type { ReliabilityOutcome } from './reliability'
export type {
  CapabilityContext,
  CapabilityContextId,
  CapabilityDefinition,
  CapabilityPermission,
  CapabilityPreview,
  CapabilityReliability,
  CapabilityReliabilityIndex,
  CapabilityResolution,
  CapabilityRisk,
  CapabilityRiskLevel,
  CapabilitySelectionConstraints,
  CapabilityVerification,
  PolicyDrop,
  PreferredVerification,
} from './types'
export type { CapabilityRegistryLike } from './registry'