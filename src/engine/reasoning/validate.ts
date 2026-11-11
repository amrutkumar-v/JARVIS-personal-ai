/**
 * Phase 13 — strict validation of reasoning-provider output.
 *
 * The reasoning provider's raw output is UNTRUSTED by definition. Nothing it
 * returns may name a capability, an argument, a path or an application target
 * that has not been explicitly allowed here:
 *
 *   - capability ids must exist in the registered allow-list,
 *   - argument names must be declared by that capability's schema and match the
 *     declared types,
 *   - folders must be safe curated tokens (`{userprofile}\…`, `{workspace}`,
 *     `{temp}`) — never absolute paths, drives, UNC paths, `..`, shell
 *     expansions or system paths,
 *   - application targets must be names — never paths, `.exe` files or shell
 *     commands,
 *   - plans are capped in size, extra/invented fields are rejected.
 *
 * A single failed check rejects the WHOLE plan: nothing is ever partially
 * executed.
 */

import type { ReasoningCapabilityDescriptor, ReasoningIntent, ReasoningStep, StructuredPlan } from './contract'
import { REASONING_PLAN_LIMITS } from './contract'
import { isSafeFolder, isSafeApplicationTarget, isSafeWorkspacePath, isWorkspaceRelativeProperty } from '../goal/safety'

export type PlanValidationCode =
  | 'malformed'
  | 'unknown_intent'
  | 'no_steps'
  | 'too_many_steps'
  | 'unexpected_field'
  | 'unknown_capability'
  | 'invalid_arguments'
  | 'unsafe_path'

export type PlanValidation =
  | { ok: true; plan: StructuredPlan }
  | { ok: false; code: PlanValidationCode; reason: string }

const INTENTS = new Set<string>(['execute', 'status', 'unsupported', 'clarification', 'reject'])
const ALLOWED_PLAN_KEYS = new Set<string>(['intent', 'steps', 'asking', 'reason'])
const ALLOWED_STEP_KEYS = new Set<string>(['capabilityId', 'arguments', 'reason'])
/** Intents that never carry executable steps. */
const NON_EXECUTING_INTENTS = new Set<string>(['unsupported', 'clarification', 'reject'])

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function typeMatches(value: unknown, type: 'string' | 'number' | 'boolean'): boolean {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === 'boolean'
}

/**
 * Validate the raw reasoning-provider output against the CURRENT registered
 * allow-list. On ANY failure the whole plan is rejected (`ok: false`) — the
 * caller must refuse and execute nothing.
 */
export function parseAndValidatePlan(raw: unknown, catalog: ReasoningCapabilityDescriptor[]): PlanValidation {
  const allowList = new Map<string, ReasoningCapabilityDescriptor>(catalog.map((c) => [c.id, c]))

  if (!isPlainObject(raw)) {
    return { ok: false, code: 'malformed', reason: 'the model output was not a JSON object.' }
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_PLAN_KEYS.has(key)) {
      return { ok: false, code: 'unexpected_field', reason: `unexpected top-level field "${key}".` }
    }
  }

  const intent = raw.intent
  if (typeof intent !== 'string' || !INTENTS.has(intent)) {
    return { ok: false, code: 'unknown_intent', reason: 'missing or unknown intent.' }
  }

  const rawSteps = raw.steps
  if (!Array.isArray(rawSteps)) {
    return { ok: false, code: 'malformed', reason: '"steps" must be an array.' }
  }
  const isExecuting = intent === 'execute' || intent === 'status'
  if (isExecuting) {
    if (rawSteps.length === 0) {
      return { ok: false, code: 'no_steps', reason: 'an executable intent needs at least one step.' }
    }
    if (rawSteps.length > REASONING_PLAN_LIMITS.maxSteps) {
      return {
        ok: false,
        code: 'too_many_steps',
        reason: `plans are capped at ${REASONING_PLAN_LIMITS.maxSteps} steps.`,
      }
    }
  } else if (NON_EXECUTING_INTENTS.has(intent)) {
    if (rawSteps.length > 0) {
      return { ok: false, code: 'unexpected_field', reason: 'a non-executable intent must not carry steps.' }
    }
  } else {
    return { ok: false, code: 'unknown_intent', reason: 'unsupported intent.' }
  }

  const steps: ReasoningStep[] = []
  for (const step of rawSteps as unknown[]) {
    if (!isPlainObject(step)) {
      return { ok: false, code: 'malformed', reason: 'a step was not an object.' }
    }
    for (const key of Object.keys(step)) {
      if (!ALLOWED_STEP_KEYS.has(key)) {
        return { ok: false, code: 'unexpected_field', reason: `unexpected step field "${key}".` }
      }
    }
    const capabilityId = step.capabilityId
    if (typeof capabilityId !== 'string' || !allowList.has(capabilityId)) {
      return {
        ok: false,
        code: 'unknown_capability',
        reason: `"${String(capabilityId)}" is not a registered capability.`,
      }
    }
    const args = step.arguments
    if (!isPlainObject(args)) {
      return { ok: false, code: 'invalid_arguments', reason: `arguments for "${capabilityId}" must be an object.` }
    }
    const argKeys = Object.keys(args)
    if (argKeys.length > REASONING_PLAN_LIMITS.maxArgumentKeys) {
      return { ok: false, code: 'invalid_arguments', reason: 'too many arguments on one step.' }
    }
    const descriptor = allowList.get(capabilityId)!
    const declared = new Map<string, { type: 'string' | 'number' | 'boolean'; required: boolean }>(
      descriptor.arguments.map((a) => [a.name, { type: a.type, required: a.required }]),
    )
    const provided = new Set<string>()
    for (const key of argKeys) {
      const decl = declared.get(key)
      if (!decl) {
        // NEVER echo the offending (model-supplied) argument name: it could
        // carry a secret the model resonated back.
        return { ok: false, code: 'invalid_arguments', reason: `"${capabilityId}" received an unexpected argument.` }
      }
      if (!typeMatches(args[key], decl.type)) {
        // The type is schema-owned (safe); the name is model-supplied (not echoed).
        return { ok: false, code: 'invalid_arguments', reason: `"${capabilityId}" has an argument with the wrong type (expected ${decl.type}).` }
      }
      provided.add(key)
    }
    for (const arg of descriptor.arguments) {
      if (arg.required && !provided.has(arg.name)) {
        return { ok: false, code: 'invalid_arguments', reason: `"${capabilityId}" requires argument "${arg.name}".` }
      }
    }
    // Folders/paths must be bounded, curated tokens (never arbitrary paths).
    // Schema-based: arguments declared as folder/path in the capability schema are checked.
    // Fallback to name-based detection for schemas without descriptions (defense in depth).
    //
    // A workspace-relative path (the filesystem family, whose schema says
    // "relative to the workspace root") is a DIFFERENT contract: it is
    // resolved against a root the tool owns, and the tool re-validates it
    // through `normalizeSafePath` before the provider sees it. Both layers
    // still reject absolute paths and traversal.
    for (const arg of descriptor.arguments) {
      const value = args[arg.name]
      if (typeof value === 'string' && (arg.type === 'string')) {
        const isFolderArg = /folder|path|directory|location/i.test(arg.description ?? '') || /folder|path|directory|location|target/i.test(arg.name)
        if (isFolderArg) {
          const workspaceRelative = isWorkspaceRelativeProperty({ type: 'string', description: arg.description })
          const safe = workspaceRelative ? isSafeWorkspacePath(value) : isSafeFolder(value)
          if (!safe) {
            return {
              ok: false,
              code: 'unsafe_path',
              reason: workspaceRelative
                ? 'a path argument must be relative to the workspace root and is not - refusing the plan.'
                : 'a folder/path argument must be an allowed, bounded folder token and is not - refusing the plan.',
            }
          }
        }
      }
      if (typeof value === 'string' && arg.name === 'application_id') {
        if (!isSafeApplicationTarget(value)) {
          return {
            ok: false,
            code: 'unsafe_path',
            reason: 'the application target must be a name, not a path, executable or command.',
          }
        }
      }
    }
    steps.push({
      capabilityId,
      arguments: args,
      reason: typeof step.reason === 'string' ? step.reason : undefined,
    })
  }

  return {
    ok: true,
    plan: {
      intent: intent as ReasoningIntent,
      steps,
      asking: typeof raw.asking === 'string' ? raw.asking : undefined,
      reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    },
  }
}