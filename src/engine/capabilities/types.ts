import type { ToolContextId, ToolPermission } from '../../tools/Tool'

/**
 * Phase 2.3 — Universal Software Capability Layer (pure contracts).
 *
 * A CAPABILITY is a high-level, model-addressable ability ("open an
 * application", "click the UI at a point") — WHAT the operator wants. A TOOL is
 * a concrete, registered mechanism that implements it — HOW it happens. The
 * engine resolves capabilities to registered tools; the model must NEVER invent
 * an implementation.
 *
 * Everything in this module is pure data + deterministic selection policy: no
 * I/O, no registry mutation, no execution, no permission granting. The
 * engine's tool registry stays the single authority over what can run, and the
 * existing execution rails (permission, argument validation, budgets,
 * repeated-action, verification, cancellation) are NEVER bypassed by a
 * capability.
 */

/** Reuse the tool vocabulary: a capability is real only where a registered
 * context backs it. `android` / `network` are architectural seams — no Android
 * or network tools are implemented yet. */
export type CapabilityContextId = ToolContextId

/** Advisory tier used ONLY for catalog readability. The tool permission system
 * is the real enforcement; this label grants nothing. */
export type CapabilityRiskLevel = 'read_only' | 'low_risk' | 'action' | 'sensitive_action'

/** Planning hint about how confirmable the capability's effects are. NEVER
 * evidence: only the tool-owned verifier's recorded outcome counts. */
export type CapabilityVerification = 'strong' | 'weak' | 'none'

/**
 * Phase 2.4 — deterministic, application-owned risk class of a CAPABILITY.
 * Never authored or overridden by providers/models; every default capability
 * carries one (see `defaults.ts`).
 */
export type CapabilityRisk = 'read_only' | 'low' | 'medium' | 'high'

/**
 * Phase 2.4 — bounded application-owned permission vocabulary used as an
 * ADDITIONAL policy layer on capability resolution. The tool permission system
 * remains the real enforcement; these classes only express what a capability
 * is allowed to select (a capability declared `read` must never resolve to a
 * `destructive` implementation).
 */
export type CapabilityPermission =
  | 'read'
  | 'write'
  | 'external_communication'
  | 'device_control'
  | 'financial'
  | 'destructive'

/**
 * Phase 2.4 — how strongly the APPLICATION prefers evidence-producing
 * implementations when several can satisfy the same capability. Ranking only:
 * a strict requirement is expressed separately (`requireVerification` /
 * `CapabilityContext.requiresVerification`).
 */
export type PreferredVerification = 'strong' | 'normal' | 'weak'

/**
 * One registered capability. Registration is EXPLICIT and BOUNDED: only
 * engine/admin code may add these; the model cannot create, modify or delete
 * them (see `CapabilityRegistry`).
 */
export interface CapabilityDefinition {
  /** Stable, unique id the MODEL may name (e.g. `open_application`). */
  id: string
  /** Short user-facing name (e.g. "Open application"). */
  name: string
  /** What the operator wants — one or two sentences, never instructions. */
  description: string
  /** Organizational grouping ONLY (desktop/application/web/files/…). Never
   * does anything by itself. */
  category: string
  /** Registered tool ids that implement this capability, IN PREFERENCE ORDER.
   * Selection NEVER invents tools: only ids present in the engine's tool
   * registry at resolution time are eligible. */
  tools: string[]
  /** Contexts this capability applies to (desktop / app / files / …). */
  contexts: CapabilityContextId[]
  /** Advisory risk tier (see `CapabilityRiskLevel`). The tool permission
   * system remains the real gate. */
  riskLevel: CapabilityRiskLevel
  /** Phase 2.4 — deterministic application-owned risk class of the capability
   * (see `CapabilityRisk`). Never authored by providers/models. */
  risk: CapabilityRisk
  /** Phase 2.4 — true when the capability permanently destroys state (e.g. a
   * delete). Application-owned. */
  destructive: boolean
  /** Phase 2.4 — application policy: explicit user confirmation is REQUIRED
   * before any implementation of this capability may execute. This is never a
   * model decision — the model only requests the capability. */
  requiresConfirmation?: boolean
  /** Phase 2.4 — application-owned verification preference used when ranking
   * several implementations (see `PreferredVerification`). */
  preferredVerification?: PreferredVerification
  /** Phase 2.4 — bounded permission ceiling: a capability MUST never resolve
   * to an implementation whose capability-permission class exceeds this (e.g.
   * a `read` capability never selects a `destructive` tool). */
  maximumPermission?: CapabilityPermission
  /** True when the capability only reads local state. */
  readOnly: boolean
  /** Human-meaningful permission labels (e.g. `screen_observation`,
   * `desktop_control`). INFORMATIONAL ONLY — enforcement stays in the
   * existing execution rails; capability metadata never grants permission. */
  requiredPermissions?: string[]
  /** Planning-only confirmation hint: 'strong' | 'weak' | 'none'. */
  verification?: CapabilityVerification
  /** Expected parameter names, used as provider-facing hints. The resolved
   * TOOL's schema is still the enforced input contract. */
  requiredParameters?: string[]
}

/** Selection constraints for deterministic capability resolution. */
export interface CapabilitySelectionConstraints {
  /** Live availability predicate over TOOL ids (environment/device state). */
  available?: (toolId: string) => boolean
  /** Ceiling on tool permission; tools above it are not selectable. When
   * absent, all registered permissions are eligible and the execution-time
   * permission gate remains the backstop. */
  maxPermission?: ToolPermission
  /** Required context; tools not fitting it (nor `generic`) are not
   * selectable. */
  context?: CapabilityContextId
  /** When true, candidates are stably partitioned so verifiable tools rank
   * before non-verifiable ones (evidence-aware ordering). Deterministic;
   * never changes safety. */
  preferVerifiable?: boolean
  /** Phase 2.4 — bounded execution context used as a ranking signal (and, for
   * an explicitly device-scoped request, a hard filter — a capability is
   * never silently re-targeted to a different device). App-owned; the model
   * cannot set it. */
  capabilityContext?: CapabilityContext
  /** Phase 2.4 — application-owned reliability history (a WEAK ranking
   * signal only; it can never override permission, availability, risk,
   * verification or policy). Bounded and content-free. */
  reliability?: CapabilityReliabilityIndex
  /** Phase 2.4 — strict verification requirement: when true, implementations
   * that cannot self-verify their effect are REJECTED rather than silently
   * downgraded. Application-owned; the model cannot disable it. */
  requireVerification?: boolean
}

/**
 * Phase 2.4 — bounded execution context for capability resolution. Contains
 * only data JARVIS already legitimately holds; the ENGINE fills it (never the
 * model). It is a ranking signal that can never override security boundaries.
 */
export interface CapabilityContext {
  /** The device the request is scoped to (e.g. `phone`, `desktop`). When set,
   * resolution is DEVICE-SCOPED: an implementation on an unrelated device is
   * never silently substituted. */
  activeDevice?: string
  /** The active application/asset the request concerns (ranking boost for
   * application implementation tools). */
  activeApplication?: string
  availableDevices?: string[]
  availableApplications?: string[]
  interactionMode?: 'text' | 'voice' | 'visual'
  /** True when the goal explicitly demands confirmable evidence. With this
   * set, non-verifiable implementations are rejected, never downgraded. */
  requiresVerification?: boolean
}

/** Phase 2.4 — bounded reliability record for one (capability, tool) pair.
 * CONTENT-FREE by design: only ids and derived counters, never payloads,
 * user content or secrets. A WEAK ranking signal only. */
export interface CapabilityReliability {
  capabilityId: string
  toolId: string
  /** Executed-and-confirmed (verified) outcomes. */
  verifiedSuccesses: number
  /** Executed-and-successful outcomes (confirmed or not). */
  successes: number
  failures: number
  lastOutcome?: 'success' | 'verified_success' | 'failure'
}

/** Read-only index over (capability, tool) reliability entries. */
export type CapabilityReliabilityIndex = ReadonlyMap<string, CapabilityReliability>

export interface CapabilityPreview {
  /** Risk class of the capability (application-owned metadata). */
  risk: CapabilityRisk
  /** Capability-permission class of the chosen implementation. */
  permission: CapabilityPermission
  /** Effective verification preference applied during selection. */
  verification: PreferredVerification
  /** Whether the capability's application policy requires confirmation. */
  requiresConfirmation: boolean
}

/** One candidate dropped by a deterministic policy filter (Phase 2.4), with
 * the readable reason — used for operational trace events. */
export interface PolicyDrop {
  toolId: string
  reason: string
}

/** Deterministic outcome of resolving a capability to a registered tool. */
export type CapabilityResolution =
  | {
      ok: true
      capability: string
      /** The concrete registered tool selected for execution. */
      toolId: string
      /** True when a lower-preference implementation was chosen because the
       * declared first choice was unavailable/not selectable (bounded
       * fallback). */
      fallback: boolean
      /** The capability's first-declared tool id (the preferred
       * implementation). */
      preferred: string
      /** Whether the chosen tool can self-verify its effect. */
      verifiable: boolean
      /** Whether the capability's declared verification hint is satisfied by
       * the chosen tool. Advisory — never evidence. */
      verificationCompatible: boolean
      /** Deterministic, human-readable selection rationale (audit/UI). */
      reason: string
      /** Phase 2.4 — capability-permission class of the chosen tool. */
      permission: CapabilityPermission
      /** Phase 2.4 — application-owned risk class of the capability. */
      risk: CapabilityRisk
      /** Phase 2.4 — effective verification preference applied. */
      verificationPreference: PreferredVerification
      /** Phase 2.4 — whether the capability's policy requires confirmation. */
      requiresConfirmation: boolean
      /** Phase 2.4 — eligible candidates in ranked (best-first) order. */
      ranked: string[]
      /** Phase 2.4 — candidates dropped by deterministic policy filters. */
      policyDropped: PolicyDrop[]
    }
  | {
      ok: false
      capability: string
      code: 'capability_unavailable'
      reason: string
    }