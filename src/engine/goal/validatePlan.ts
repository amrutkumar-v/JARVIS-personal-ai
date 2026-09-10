import type { Tool } from '../../tools/Tool'
import { taskBudgetExceeded, GOAL_LIMITS } from './budget'
import type { CapabilityRegistryLike } from '../capabilities'
import type {
  CapabilityPermission,
  CapabilityRisk,
  CapabilitySelectionConstraints,
  PolicyDrop,
  PreferredVerification,
} from '../capabilities'
import { resolveCapability } from '../capabilities'

/**
 * Plan validation (Phase 2.0).
 *
 * A plan is UNTRUSTED model output. Before a single step executes, the engine
 * runs every request through this strict pre-flight. Rejected steps never
 * reach inspection, budgets or the desktop — they become `plan_rejected`
 * steps on the trace and the provider sees an honest rejection.
 *
 * A plan is never permission: passing `validatePlan` only means "this is a
 * well-formed, registered, in-budget request". Execution rails (permissions,
 * verification, budgets, cancellation) still gate every individual action.
 */

/** One requested tool call, exactly as the provider produced it. */
export interface PlanStepRequest {
  toolId: string
  payload?: Record<string, unknown>
  /**
   * Phase 2.3 — when present, this step names a CAPABILITY (e.g.
   * `open_application`) instead of a concrete tool. The engine resolves the
   * capability to a REGISTERED tool deterministically (see
   * `src/engine/capabilities`); the engine's tool registry remains the
   * authority over what executes. A capability id may also be placed directly
   * in `toolId` (tool ids win on collision). The model never invents
   * implementations.
   */
  capability?: string
  /**
   * Phase 2.2 — declared ordering constraint on an EARLIER request in the
   * SAME round (`0 <= dependsOn < stepIndex`). The engine enforces it: a
   * dependent step never executes until its prerequisite completed. It can
   * never reference a later/self step, and cannot escape the task budget.
   */
  dependsOn?: Array<string | number>
}

/** Stable reason code for a rejected request (Phase 2.2 recovery mapping).
 * Phase 2.3 adds capability verdict codes: an UNREGISTERED name and a
 * registered-but-unimplementable capability are distinct refusals. */
export type PlanVerdictCode =
  | 'reserved'
  | 'unregistered'
  | 'no_contract'
  | 'undeclared'
  | 'unavailable'
  | 'dependency'
  | 'budget'
  | 'capability_unregistered'
  | 'capability_unavailable'

export type PlanVerdict =
  | { ok: true }
  | { ok: false; stepIndex: number; toolId: string; code: PlanVerdictCode; reason: string }

export type PlanValidation = { verdicts: PlanVerdict[]; resolutions?: PlanStepResolution[] }

/**
 * Phase 2.3 — the concrete tool the ENGINE resolved for one capability step.
 * Recorded so the executor can run the exact registered tool the validator
 * approved (same deterministic inputs → same result). Present ONLY for
 * capability-based steps; plain tool steps keep using `request.toolId`.
 */
export interface PlanStepResolution {
  stepIndex: number
  /** The capability id the plan named (directly or via the `toolId` slot). */
  capability: string
  /** The concrete registered tool selected to implement the capability. */
  toolId: string
  /** True when a fallback implementation was chosen (preferred unavailable). */
  fallback: boolean
  /** The capability's first-declared (preferred) implementation tool id. */
  preferred: string
  /** Phase 2.4 — capability-permission class of the chosen tool (policy
   * ceiling stays approval-only; execution permission is enforced elsewhere). */
  permission?: CapabilityPermission
  /** Phase 2.4 — application-owned risk class of the capability. */
  risk?: CapabilityRisk
  /** Phase 2.4 — effective verification preference applied while ranking. */
  verificationPreference?: PreferredVerification
  /** Phase 2.4 — whether the capability's policy requires confirmation. */
  requiresConfirmation?: boolean
  /** Phase 2.4 — eligible candidates in ranked (best-first) order. */
  ranked?: string[]
  /** Phase 2.4 — candidates dropped by deterministic policy filters. */
  policyDropped?: PolicyDrop[]
}

/** Phase 2.4 — bounds/context that shape capability resolution (app-owned
 * only; the engine fills these, never the model). */
export interface CapabilityResolutionOptions {
  capabilityContext?: CapabilitySelectionConstraints['capabilityContext']
  requireVerification?: boolean
  reliability?: CapabilitySelectionConstraints['reliability']
  preferVerifiable?: boolean
}

/**
 * Orchestration/control parameters the model may NEVER pass to a tool. These
 * would let an untrusted plan mutate its own permissions, budgets, recovery
 * counters or cancellation — so they are rejected regardless of tool.
 */
const RESERVED_PLAN_PARAMETERS: readonly string[] = [
  'permission',
  'permission_level',
  'trust',
  'elevate',
  'admin',
  'budget',
  'budget_limit',
  'max_steps',
  'max_rounds',
  'task_budget',
  'recovery',
  'recovery_count',
  'reset_recovery',
  'recovery_limit',
  'cancel',
  'skip_cancellation',
  'skip_verification',
  'disable_verification',
  'skip_validation',
  'json_mode',
  'provider',
  'mode',
  '_inner',
]

/** Minimal lookup seam so unit tests can pass purpose-built fakes. */
export interface ToolLookup {
  get(id: string): Tool | undefined
}

/**
 * Validate one provider round of tool requests before anything executes.
 * Returns one verdict per request, in order. Violations are strict:
 *  - reserved orchestration parameters (permission/budget/cancel/… bypass)
 *  - tools that are not registered (arbitrary surface, shell, registry…)
 *  - parameters a registered tool does not declare
 *  - capabilities that are unavailable in the current environment
 *  - impossible declared dependencies (late/self references, or a dependency
 *    on a request that itself failed validation)
 *  - a plan that would exceed the per-goal task budget
 * Missing/invalid _arguments_ are left to the existing execution-time
 * validator (`invalid_input`), keeping that rail authoritative.
 */
export function validatePlan(
  steps: PlanStepRequest[],
  registry: ToolLookup,
  executedSoFar = 0,
  maxSteps = GOAL_LIMITS.maxTaskSteps,
  available?: (toolId: string) => boolean,
  capabilities?: CapabilityRegistryLike,
  capabilityOptions: CapabilityResolutionOptions = {},
): PlanValidation {
  const verdicts: PlanVerdict[] = []
  const resolutions: PlanStepResolution[] = []

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]
    const payload = step.payload ?? {}

    const reserved = RESERVED_PLAN_PARAMETERS.find((key) => typeof payload[key] !== 'undefined')
    if (reserved) {
      verdicts.push({
        ok: false,
        stepIndex: i,
        toolId: step.toolId,
        code: 'reserved',
        reason: `Plan rejected at step ${i + 1}: parameter "${reserved}" is managed by the engine and cannot be set by the model.`,
      })
      continue
    }

    // Phase 2.3 — capability-aware resolution. A step names a capability either
    // explicitly (`capability`) or by placing a REGISTERED capability id in the
    // `toolId` slot (a registered TOOL id always wins the slot). The capability
    // resolves to a concrete registered tool BEFORE any tool check runs.
    let effectiveToolId = step.toolId
    const isCapabilityStep =
      capabilities !== undefined &&
      (step.capability !== undefined ||
        (capabilities.get(step.toolId) !== undefined && registry.get(step.toolId) === undefined))

    if (isCapabilityStep) {
      const capabilityId = step.capability ?? step.toolId
      if (!capabilities.get(capabilityId)) {
        // Record the attempt so the executor can emit honest trace events even
        // for a name the engine refuses (see the engine capability-lifecycle
        // loop); `toolId` equals the named capability because nothing resolved.
        resolutions.push({
          stepIndex: i,
          capability: capabilityId,
          toolId: capabilityId,
          fallback: false,
          preferred: capabilityId,
        })
        verdicts.push({
          ok: false,
          stepIndex: i,
          toolId: capabilityId,
          code: 'capability_unregistered',
          reason: `Plan rejected at step ${i + 1}: capability "${capabilityId}" is not a registered capability.`,
        })
        continue
      }
      const resolution = resolveCapability(capabilityId, capabilities, registry, {
        available,
        ...capabilityOptions,
      })
      if (!resolution.ok) {
        resolutions.push({
          stepIndex: i,
          capability: capabilityId,
          toolId: capabilityId,
          fallback: false,
          preferred: capabilities.get(capabilityId)!.tools[0] ?? capabilityId,
        })
        verdicts.push({
          ok: false,
          stepIndex: i,
          toolId: capabilityId,
          code: 'capability_unavailable',
          reason: `Plan rejected at step ${i + 1}: ${resolution.reason}`,
        })
        continue
      }
      resolutions.push({
        stepIndex: i,
        capability: capabilityId,
        toolId: resolution.toolId,
        fallback: resolution.fallback,
        preferred: resolution.preferred,
        permission: resolution.permission,
        risk: resolution.risk,
        verificationPreference: resolution.verificationPreference,
        requiresConfirmation: resolution.requiresConfirmation,
        ranked: resolution.ranked,
        policyDropped: resolution.policyDropped,
      })
      effectiveToolId = resolution.toolId
    }

    const tool = registry.get(effectiveToolId)
    if (!tool) {
      verdicts.push({
        ok: false,
        stepIndex: i,
        toolId: effectiveToolId,
        code: 'unregistered',
        reason: `Plan rejected at step ${i + 1}: "${effectiveToolId}" is not a registered tool.`,
      })
      continue
    }

    const schema = tool.inputSchema
    if (!schema || schema.type !== 'object') {
      verdicts.push({
        ok: false,
        stepIndex: i,
        toolId: effectiveToolId,
        code: 'no_contract',
        reason: `Plan rejected at step ${i + 1}: "${effectiveToolId}" has no input contract.`,
      })
      continue
    }

    const declared: ReadonlySet<string> = new Set(Object.keys(schema.properties ?? {}))
    const unsupported = Object.keys(payload).find((key) => !declared.has(key))
    if (unsupported) {
      verdicts.push({
        ok: false,
        stepIndex: i,
        toolId: effectiveToolId,
        code: 'undeclared',
        reason: `Plan rejected at step ${i + 1}: "${effectiveToolId}" does not accept a parameter named "${unsupported}".`,
      })
      continue
    }

    if (available && !available(effectiveToolId)) {
      verdicts.push({
        ok: false,
        stepIndex: i,
        toolId: effectiveToolId,
        code: 'unavailable',
        reason: `Plan rejected at step ${i + 1}: "${effectiveToolId}" is not an available capability in this environment.`,
      })
      continue
    }

    if (step.dependsOn !== undefined) {
      const bad = invalidDependency(step.dependsOn, i)
      if (bad) {
        verdicts.push({
          ok: false,
          stepIndex: i,
          toolId: step.toolId,
          code: 'dependency',
          reason: bad,
        })
        continue
      }
      // A dependency on a request that itself failed validation is impossible.
      const depOnRejected = step.dependsOn.find((d) => {
        const index = Number(d)
        return index >= 0 && index < i && verdicts[index] && !verdicts[index].ok
      })
      if (depOnRejected !== undefined) {
        verdicts.push({
          ok: false,
          stepIndex: i,
          toolId: step.toolId,
          code: 'dependency',
          reason: `Plan rejected at step ${i + 1}: it depends on step ${Number(depOnRejected) + 1}, which was rejected.`,
        })
        continue
      }
    }

    if (taskBudgetExceeded(executedSoFar + i, maxSteps)) {
      verdicts.push({
        ok: false,
        stepIndex: i,
        toolId: step.toolId,
        code: 'budget',
        reason: `Plan rejected at step ${i + 1}: the goal's task budget would be exhausted (${executedSoFar + i} executed now + this request).`,
      })
      continue
    }

    verdicts.push({ ok: true })
  }

  return resolutions.length > 0 ? { verdicts, resolutions } : { verdicts }
}

/**
 * True when a declared dependency cannot exist: it must be an integer index
 * strictly before the referencing step (never self/later/negative).
 */
function invalidDependency(dependsOn: Array<string | number>, stepIndex: number): string | null {
  for (const raw of dependsOn) {
    const index = Number(raw)
    if (!Number.isInteger(index) || index < 0 || index >= stepIndex) {
      return `Plan rejected at step ${stepIndex + 1}: dependency "${raw}" is not an earlier step in this round.`
    }
  }
  return null
}