import type { Tool } from '../../tools/Tool'

/**
 * Tool argument validation (Phase 1.0).
 *
 * Before any tool executes, the engine checks the AI's chosen arguments
 * against the tool's declared `inputSchema`: required keys present, and values
 * match their declared JSON-schema types. Failures become `invalid_input`
 * observations — the agent sees a structured rejection instead of running a
 * tool with garbage.
 */

export type ArgumentValidation = { ok: true } | { ok: false; reason: string }

/** Missing-but-required keys are considered absent when empty. */
function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

/** Validate an AI's tool call against its input contract. */
export function validateToolArguments(
  tool: Tool | undefined,
  payload: Record<string, unknown>,
): ArgumentValidation {
  if (!tool) return { ok: false, reason: 'That tool is not available.' }
  const schema = tool.inputSchema
  if (!schema || schema.type !== 'object') return { ok: false, reason: 'The tool has no input contract.' }

  const args = payload ?? {}

  const missing: string[] = []
  for (const key of schema.required ?? []) {
    if (isMissing(args[key])) missing.push(key)
  }
  if (missing.length) {
    return { ok: false, reason: `Missing required argument(s): ${missing.join(', ')}.` }
  }

  for (const [key, meta] of Object.entries(schema.properties ?? {})) {
    if (args[key] === undefined) continue
    if (meta.type === 'number' && typeof args[key] !== 'number') {
      return { ok: false, reason: `Argument "${key}" must be a number.` }
    }
    if (meta.type === 'string' && typeof args[key] !== 'string') {
      return { ok: false, reason: `Argument "${key}" must be a string.` }
    }
    if (meta.type === 'boolean' && typeof args[key] !== 'boolean') {
      return { ok: false, reason: `Argument "${key}" must be a boolean.` }
    }
  }

  return { ok: true }
}