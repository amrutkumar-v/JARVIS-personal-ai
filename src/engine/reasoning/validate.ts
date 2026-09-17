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

/** Anything a folder/path argument must NEVER contain. */
const UNSAFE_PATH =
  /([a-zA-Z]:[\\/]|^\s*[\\/][\\/]|\.\.|[\u0001-\u001f]|(^|[/\\])etc([/\\]|$)|[/\\]system32([/\\]|$)|%[a-zA-Z][a-zA-Z0-9_]*%)/i
/** Application targets must not look like paths, executables or commands. */
const PATH_LIKE_APP_TARGET = /[\\/:[\]|]/
/** Characters that would turn a name into a compound command. */
const SHELL_INJECTION = /[;&|$`<>]/

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function typeMatches(value: unknown, type: 'string' | 'number' | 'boolean'): boolean {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === 'boolean'
}

const SAFE_FOLDER_PREFIXES = ['{userprofile}', '{workspace}', '{temp}']

/** A folder argument is only safe when it is a bounded curated token under the
 * user profile / workspace / temp roots. No absolute paths, never a raw
 * user-supplied path. */
function isSafeFolder(value: string): boolean {
  if (value.trim().length === 0 || value.length > 260) return false
  if (UNSAFE_PATH.test(value)) return false
  return SAFE_FOLDER_PREFIXES.some((prefix) => {
    if (value === prefix) return true
    if (value.startsWith(prefix)) {
      return value.charAt(prefix.length) === '\\' && !value.includes('..')
    }
    return false
  })
}

/** An application target (id/alias typed by the model) must be a NAME. */
function isSafeApplicationTarget(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 64) return false
  if (PATH_LIKE_APP_TARGET.test(trimmed)) return false
  if (SHELL_INJECTION.test(trimmed)) return false
  if (/\.exe$/i.test(trimmed)) return false
  if (/\.(bat|cmd|ps1|sh|com)$/i.test(trimmed)) return false
  if (UNSAFE_PATH.test(trimmed)) return false
  return true
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
    for (const key of argKeys) {
      const value = args[key]
      if (typeof value === 'string' && /folder|path|location|directory|target/i.test(key)) {
        if (!isSafeFolder(value)) {
          return {
            ok: false,
            code: 'unsafe_path',
            // The argument NAME is model-supplied and never echoed; the schema
            // keyword "folder token" is static and safe to say.
            reason: 'a folder/path argument must be an allowed, bounded folder token and is not - refusing the plan.',
          }
        }
      }
    }
    // Application targets must be names — never paths, executables or commands.
    if (typeof args.application_id === 'string') {
      if (!isSafeApplicationTarget(args.application_id)) {
        return {
          ok: false,
          code: 'unsafe_path',
          reason: 'the application target must be a name, not a path, executable or command.',
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