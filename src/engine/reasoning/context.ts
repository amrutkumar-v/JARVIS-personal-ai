/**
 * Phase 13 — build the reasoning request from the ACTUAL registered engine
 * state (never a hard-coded list). The reasoning provider sees exactly what
 * the engine can genuinely run today:
 *
 *   - capabilities are filtered to those that currently resolve to a
 *     registered tool (a capability that cannot run is NOT advertised),
 *   - argument schemas come from the resolved tool's input schema,
 *   - a static, mandatory security-constraints block is always attached.
 */

import type { CapabilityDefinition } from '../capabilities/types'
import type { Tool } from '../../tools/Tool'
import type { ReasoningCapabilityArgument, ReasoningRequest } from './contract'

/** Schematic constraints the model must obey — a fixed, strict policy string. */
export const REASONING_CONSTRAINTS =
  'You convert ONE user request into ONE strict JSON plan. The reply must be ONLY the JSON object ' +
  '{"intent":"execute"|"status"|"unsupported"|"clarification"|"reject","steps":[...],"asking":...,"reason":...}. ' +
  'HARD RULES (never optional): ' +
  '(1) Every "capabilityId" MUST be one of the registered capability ids listed below; never invent or alter one. ' +
  '(2) "arguments" MAY ONLY contain documented parameter names with exactly the documented types; a missing required ' +
  'parameter, an unknown name, or a wrong type is an error. ' +
  '(3) Folders/paths: use ONLY a safe token like "{userprofile}\\Downloads", "{workspace}" or "{temp}"; NEVER absolute ' +
  'paths, drive letters, "..", system paths, or any path text copied from the user. ' +
  '(4) Application targets: use the application NAME (e.g. "Calculator"); NEVER a path, a file name with ".exe", or a ' +
  'shell command. ' +
  '(5) Shell commands, arbitrary script/command execution, unrestricted web browsing and system administration do NOT ' +
  'exist in this environment. If the request needs one, return {"intent":"unsupported","reason":"..."} with EMPTY steps. ' +
  '(6) If the request cannot be satisfied with the given capabilities+arguments, return unsupported — never guess, never ' +
  'invent parameters. ' +
  '(7) For genuine questions where you need one detail, there is NO clarify step in the interactive user list; only prefer ' +
  '"clarification" when the request is genuinely ambiguous about WHICH action to take. ' +
  '(8) Multi-step plans: at most 4 ordered steps, each independently meaningful; a "then ..." request should chain steps ' +
  'in order. ' +
  '(9) "status" intents answer read-only questions; never change state for a question. ' +
  '(10) Never include reasoning, chain-of-thought or any text outside the JSON object. ' +
  'The word "json" is allowed in the output because the response must be JSON.'

/**
 * Build a `ReasoningRequest` from the LIVE engine state. Capabilities whose
 * preferred tools are not resolvable right now are omitted from the allow-list
 * so the model can never select something that cannot run.
 */
export function buildReasoningRequest(
  text: string,
  catalog: CapabilityDefinition[],
  lookupTool: (toolId: string) => Tool | undefined,
): ReasoningRequest {
  const capabilities: ReasoningRequest['capabilities'] = []
  for (const def of catalog) {
    const tool = def.tools.map((id) => lookupTool(id)).find((t): t is Tool => Boolean(t))
    if (!tool) continue
    const args: ReasoningCapabilityArgument[] = []
    for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
      args.push({
        name,
        type: property.type === 'number' || property.type === 'integer' ? 'number' : property.type === 'boolean' ? 'boolean' : 'string',
        description: property.description,
        required: (tool.inputSchema.required ?? []).includes(name),
      })
    }
    capabilities.push({
      id: def.id,
      name: def.name,
      description: def.description,
      arguments: args,
      requiresConfirmation: def.requiresConfirmation === true,
      readOnly: def.readOnly,
    })
  }
  return { text, capabilities, constraints: REASONING_CONSTRAINTS }
}