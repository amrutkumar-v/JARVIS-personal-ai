import { describe, expect, it } from 'vitest'
import { parseAndValidatePlan, isPlainObject } from './validate'
import { buildReasoningRequest } from './context'
import { isStructuredPlanProvider, reasoningFailureKind } from './provider'
import { ProviderError } from '../providers/ProviderError'
import { RemoteProvider } from '../providers/RemoteProvider'
import type { ReasoningCapabilityDescriptor, StructuredPlan } from './contract'
import { REASONING_PLAN_LIMITS } from './contract'
import type { Tool } from '../../tools/Tool'
import type { CapabilityDefinition } from '../capabilities'

/**
 * Phase 13 — the strict reasoning contract.
 *
 * Unit coverage of the ONLY thing the engine accepts from a reasoning
 * provider: `parseAndValidatePlan`. Every adversarial shape must be rejected
 * with a typed code and the whole plan refused — nothing is ever partially
 * executed.
 */

const OPEN_APP: ReasoningCapabilityDescriptor = {
  id: 'open_application',
  name: 'Open application',
  description: 'Launch a registered app.',
  arguments: [{ name: 'application_id', type: 'string', required: true }],
  requiresConfirmation: false,
  readOnly: false,
}

const STATUS: ReasoningCapabilityDescriptor = {
  id: 'application_status',
  name: 'Check application status',
  description: 'Check whether an application is running.',
  arguments: [{ name: 'application_id', type: 'string', required: true }],
  requiresConfirmation: false,
  readOnly: true,
}

const OPEN_FOLDER: ReasoningCapabilityDescriptor = {
  id: 'open_folder',
  name: 'Open folder',
  description: 'Open a known folder in Explorer.',
  arguments: [
    { name: 'folder', type: 'string', required: true },
    { name: 'refresh', type: 'boolean', required: false },
  ],
  requiresConfirmation: false,
  readOnly: false,
}

const CATALOG: ReasoningCapabilityDescriptor[] = [OPEN_APP, STATUS, OPEN_FOLDER]

const ok = (raw: unknown) => {
  const v = parseAndValidatePlan(raw, CATALOG)
  if (!v.ok) throw new Error(`expected ok plan, got ${v.code}: ${v.reason}`)
  return v.plan
}

const bad = (raw: unknown, code: string) => {
  const v = parseAndValidatePlan(raw, CATALOG)
  expect(v.ok).toBe(false)
  if (v.ok) throw new Error('unreachable')
  expect(v.code).toBe(code)
}

describe('Phase 13 — parseAndValidatePlan (strict contract)', () => {
  it('accepts a valid single-step execute plan', () => {
    const plan = ok({
      intent: 'execute',
      steps: [{ capabilityId: 'open_application', arguments: { application_id: 'notepad' }, reason: 'user asked' }],
    })
    expect(plan.steps[0]).toMatchObject({ capabilityId: 'open_application', arguments: { application_id: 'notepad' } })
  })

  it('accepts a valid read-only status plan', () => {
    const plan: StructuredPlan = ok({
      intent: 'status',
      steps: [{ capabilityId: 'application_status', arguments: { application_id: 'calculator' } }],
    })
    expect(plan.intent).toBe('status')
  })

  it('accepts a safe folder token (not a raw path)', () => {
    const plan = ok({
      intent: 'execute',
      steps: [{ capabilityId: 'open_folder', arguments: { folder: '{userprofile}\\Downloads' } }],
    })
    expect(plan.steps[0].arguments.folder).toBe('{userprofile}\\Downloads')
  })

  it('accepts boolean and number arguments with the declared types', () => {
    const plan = ok({
      intent: 'execute',
      steps: [{ capabilityId: 'open_folder', arguments: { folder: '{workspace}', refresh: true } }],
    })
    expect(plan.steps[0].arguments.refresh).toBe(true)
  })

  it('non-executing intents may carry a reason or asking, never steps', () => {
    const unsupported = ok({ intent: 'unsupported', reason: 'no such capability', steps: [] })
    expect(unsupported.reason).toBe('no such capability')
    const clarification = ok({ intent: 'clarification', asking: 'Which app?', steps: [] })
    expect(clarification.asking).toBe('Which app?')
    const reject = ok({ intent: 'reject', reason: 'against policy', steps: [] })
    expect(reject.intent).toBe('reject')
  })

  it('REJECTS output that is not a JSON object (malformed)', () => {
    bad(null, 'malformed')
    bad('a string', 'malformed')
    bad(42, 'malformed')
    bad([{ intent: 'execute' }], 'malformed')
  })

  it('REJECTS unknown/absent intents', () => {
    bad({ steps: [] }, 'unknown_intent')
    bad({ intent: 'run', steps: [] }, 'unknown_intent')
    bad({ intent: 'EXECUTE', steps: [{ capabilityId: 'open_application', arguments: {} }] }, 'unknown_intent')
  })

  it('REJECTS an executable intent with no steps', () => {
    bad({ intent: 'execute', steps: [] }, 'no_steps')
    bad({ intent: 'status', steps: [] }, 'no_steps')
  })

  it('REJECTS plans above the step cap', () => {
    bad(
      {
        intent: 'execute',
        steps: Array.from({ length: REASONING_PLAN_LIMITS.maxSteps + 1 }, () => ({
          capabilityId: 'open_application',
          arguments: { application_id: 'x' },
        })),
      },
      'too_many_steps',
    )
  })

  it('REJECTS unknown top-level fields (strict schema)', () => {
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'open_application', arguments: { application_id: 'x' } }], tools: [] },
      'unexpected_field',
    )
  })

  it('REJECTS unknown step fields (strict schema)', () => {
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'open_application', arguments: { application_id: 'x' }, payload: 'x' }] },
      'unexpected_field',
    )
  })

  it('REJECTS a non-executing intent that carries steps', () => {
    bad({ intent: 'unsupported', steps: [{ capabilityId: 'open_application', arguments: {} }] }, 'unexpected_field')
  })

  it('REJECTS an invented / unregistered capability id', () => {
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'run_any_command', arguments: { command: 'calc' } }] },
      'unknown_capability',
    )
  })

  it('REJECTS a shell-command capability id (cmd.exe)', () => {
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'cmd.exe', arguments: { command: 'calc' } }] },
      'unknown_capability',
    )
  })

  it('REJECTS an invented capability that sounds plausible', () => {
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'system_admin', arguments: {} }] },
      'unknown_capability',
    )
  })

  it('REJECTS wrong argument types', () => {
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'open_application', arguments: { application_id: 5 } }] },
      'invalid_arguments',
    )
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'open_folder', arguments: { folder: '{workspace}', refresh: 'yes' } }] },
      'invalid_arguments',
    )
  })

  it('REJECTS undeclared argument names', () => {
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'open_application', arguments: { application_id: 'x', command: 'calc' } }] },
      'invalid_arguments',
    )
  })

  it('REJECTS missing required arguments', () => {
    bad({ intent: 'execute', steps: [{ capabilityId: 'open_application', arguments: {} }] }, 'invalid_arguments')
  })

  it('REJECTS non-object arguments', () => {
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'open_application', arguments: 'notepad' }] },
      'invalid_arguments',
    )
  })

  it('REJECTS absolute/folder-drive paths (C:\\Windows\\System32)', () => {
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'open_folder', arguments: { folder: 'C:\\Windows\\System32' } }] },
      'unsafe_path',
    )
  })

  it('REJECTS traversal in folder tokens and UNC paths', () => {
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'open_folder', arguments: { folder: '{userprofile}\\..\\Windows' } }] },
      'unsafe_path',
    )
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'open_folder', arguments: { folder: '\\\\server\\share' } }] },
      'unsafe_path',
    )
  })

  it('REJECTS env-expansion style folder tokens', () => {
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'open_folder', arguments: { folder: '%USERPROFILE%\\Windows' } }] },
      'unsafe_path',
    )
  })

  it('REJECTS an exe filename as an application target (cmd.exe)', () => {
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'open_application', arguments: { application_id: 'cmd.exe' } }] },
      'unsafe_path',
    )
  })

  it('REJECTS an absolute executable path as an application target', () => {
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'open_application', arguments: { application_id: 'C:\\Windows\\System32\\cmd.exe' } }] },
      'unsafe_path',
    )
  })

  it('REJECTS shell-style injection in an application target', () => {
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'open_application', arguments: { application_id: 'notepad; shutdown /s' } }] },
      'unsafe_path',
    )
    bad(
      { intent: 'execute', steps: [{ capabilityId: 'open_application', arguments: { application_id: 'calc && echo hacked' } }] },
      'unsafe_path',
    )
  })

  it('REJECTS a success-looking response with no executable plan', () => {
    bad({ intent: 'execute', steps: [] }, 'no_steps')
  })

  it('rejects whole plan on a single bad step (nothing partially accepted)', () => {
    bad(
      {
        intent: 'execute',
        steps: [
          { capabilityId: 'open_application', arguments: { application_id: 'notepad' } },
          { capabilityId: 'open_application', arguments: { application_id: 'C:\\evil' } },
        ],
      },
      'unsafe_path',
    )
  })

  it('rejection reasons never echo argument VALUES (secret-safe)', () => {
    const v = parseAndValidatePlan(
      {
        intent: 'execute',
        steps: [{ capabilityId: 'open_application', arguments: { application_id: 'notepad', TOPSECRET: 'hunter2' } }],
      },
      CATALOG,
    )
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reason).not.toContain('TOPSECRET')
    expect(v.reason).not.toContain('hunter2')
  })
})

describe('Phase 13 — buildReasoningRequest derives the allow-list from REAL engine state', () => {
  const lookupTool = (id: string): Tool | undefined => {
    if (id !== 'app.launch') return undefined
    return ({
      id,
      inputSchema: { type: 'object', properties: { application_id: { type: 'string', description: 'app key' } }, required: ['application_id'] },
    }) as unknown as Tool
  }

  const CATALOG_DEFS: CapabilityDefinition[] = [
    {
      id: 'open_application',
      name: 'Open application',
      description: 'Launch a registered app.',
      category: 'application',
      tools: ['app.launch'],
      contexts: ['app'],
      riskLevel: 'action',
      risk: 'medium',
      destructive: false,
      readOnly: false,
      verification: 'strong',
    },
    {
      id: 'ghost_capability',
      name: 'Ghost',
      description: 'Nothing registers its tool.',
      category: 'other',
      tools: ['app.ghost'],
      contexts: ['generic'],
      riskLevel: 'action',
      risk: 'medium',
      destructive: false,
      readOnly: false,
    },
  ]

  it('advertises only capabilities that currently resolve to a registered tool', () => {
    const request = buildReasoningRequest('open the thing', CATALOG_DEFS, lookupTool)
    expect(request.capabilities.map((c) => c.id)).toEqual(['open_application'])
    expect(request.capabilities[0].arguments).toEqual([
      { name: 'application_id', type: 'string', description: 'app key', required: true },
    ])
    expect(request.text).toBe('open the thing')
    expect(request.constraints.length).toBeGreaterThan(100)
  })
})

describe('Phase 13 — provider capability detection', () => {
  function makeFake() {
    return {
      id: 'remote',
      label: 'X',
      plan: async () => ({}),
      generate: async () => ({ text: '' }),
      isConfigured: () => true,
      isReachable: async () => true,
    }
  }

  it('detects a provider that implements plan()', () => {
    expect(isStructuredPlanProvider(new RemoteProvider())).toBe(false)
    const fake = { ...makeFake(), id: 'remote' }
    expect(isStructuredPlanProvider(fake as never)).toBe(true)
  })

  it('maps provider failures to stable kinds (never raw contents)', () => {
    expect(reasoningFailureKind(new ProviderError('timeout', 'x'))).toBe('timeout')
    expect(reasoningFailureKind(new ProviderError('auth', 'x'))).toBe('auth')
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(reasoningFailureKind(abort)).toBe('timeout')
    expect(reasoningFailureKind(new Error('boom'))).toBe('unknown')
    expect(reasoningFailureKind('junk')).toBe('unknown')
  })

  it('isPlainObject sanity', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject('x')).toBe(false)
  })
})