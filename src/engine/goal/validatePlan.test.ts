import { describe, expect, it } from 'vitest'
import type { Tool, ToolContext, ToolInput, ToolResult, ToolVerification } from '../../tools/Tool'
import { validatePlan, type ToolLookup } from './validatePlan'
import { CapabilityRegistry } from '../capabilities'
import type { CapabilityDefinition } from '../capabilities'

class NoOpTool implements Tool {
  readonly id = 'desktop.click'
  readonly category = 'compute'
  readonly name = 'Click'
  readonly description = 'clicks'
  readonly permission = 'low_risk'
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      window_id: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
    },
    required: ['window_id'],
  }
  readonly requiresPermission = false
  canRun(): boolean { return true }
  async execute(): Promise<ToolResult> { return { ok: true, message: 'done' } }
  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    return { ok: true, message: '' }
  }
}

class OtherTool implements Tool {
  readonly id = 'notes.get'
  readonly category = 'memory'
  readonly name = 'Notes Get'
  readonly description = 'reads notes'
  readonly permission = 'read_only'
  readonly inputSchema = { type: 'object' as const, properties: {}, required: [] }
  readonly requiresPermission = false
  canRun(): boolean { return true }
  async execute(): Promise<ToolResult> { return { ok: true, message: 'none' } }
}

const registry: ToolLookup = {
  get: (id) => (id === 'desktop.click' ? new NoOpTool() : id === 'notes.get' ? new OtherTool() : undefined),
}

describe('Phase 2.0 — plan validation (untrusted model output)', () => {
  it('accepts a well-formed registered plan within budget', () => {
    const { verdicts } = validatePlan([{ toolId: 'desktop.click', payload: { window_id: '1' } }], registry)
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toEqual({ ok: true })
  })

  it('rejects orchestration/reserved parameters the model must never set', () => {
    for (const key of ['permission', 'permission_level', 'trust', 'elevate', 'budget', 'max_steps', 'cancel', 'skip_verification', 'reset_recovery', 'recovery_count']) {
      const { verdicts } = validatePlan([{ toolId: 'desktop.click', payload: { window_id: '1', x: 1, y: 1, [key]: 'yes' } }], registry)
      expect(verdicts[0].ok).toBe(false)
      expect(verdicts[0]).toMatchObject({
        stepIndex: 0,
        toolId: 'desktop.click',
        reason: expect.stringContaining(key) as string,
      })
    }
  })

  it('rejects unsupported tools (shell/exec/registry surfaces) before execution', () => {
    const { verdicts } = validatePlan([{ toolId: 'shell.exec', payload: { command: 'rm -rf /' } }, { toolId: 'desktop.click', payload: { window_id: '1' } }], registry)
    expect(verdicts[0].ok).toBe(false)
    expect(verdicts[0]).toMatchObject({ stepIndex: 0, toolId: 'shell.exec' })
    expect(verdicts[1]).toEqual({ ok: true })
  })

  it('rejects parameters a registered tool does not declare', () => {
    const { verdicts } = validatePlan([{ toolId: 'desktop.click', payload: { window_id: '1', argv: ['--force'] } }], registry)
    expect(verdicts[0].ok).toBe(false)
    expect(verdicts[0]).toMatchObject({ reason: expect.stringContaining('argv') as string })
  })

  it('rejects a plan that would exhaust the per-goal task budget', () => {
    const { verdicts } = validatePlan(
      [{ toolId: 'desktop.click', payload: { window_id: '1' } }, { toolId: 'desktop.click', payload: { window_id: '1' } }],
      registry,
      9,
    )
    expect(verdicts[0].ok).toBe(true)
    expect(verdicts[1].ok).toBe(false)
    expect(verdicts[1]).toMatchObject({ stepIndex: 1, reason: expect.stringContaining('budget') as string })
  })

  it('flagged invalid arguments are deferred to the execution-time validator', () => {
    // The engine's existing validator reports missing args as invalid_input;
    // plan validation passes the shape so it stays authoritative.
    const { verdicts } = validatePlan([{ toolId: 'desktop.click', payload: {} }], registry)
    expect(verdicts[0].ok).toBe(true)
  })

  it('rejected verdicts carry a stable code for recovery mapping', () => {
    const { verdicts } = validatePlan(
      [{ toolId: 'shell.exec' }, { toolId: 'desktop.click', payload: { window_id: '1', argv: ['x'] } }],
      registry,
    )
    expect(verdicts[0]).toMatchObject({ code: 'unregistered' })
    expect(verdicts[1]).toMatchObject({ code: 'undeclared' })
    const { verdicts: budget } = validatePlan(
      [{ toolId: 'desktop.click', payload: { window_id: '1' } }],
      registry,
      10,
    )
    expect(budget[0]).toMatchObject({ code: 'budget' })
  })

  it('rejects an unavailable capability with a dedicated code', () => {
    const { verdicts } = validatePlan([{ toolId: 'desktop.click', payload: { window_id: '1' } }], registry, 0, 10, (id) => id !== 'desktop.click')
    expect(verdicts[0].ok).toBe(false)
    expect(verdicts[0]).toMatchObject({ code: 'unavailable' })
  })
})

describe('Phase 2.3 — capability resolution in plan validation', () => {
  function caps(): CapabilityRegistry {
    const registry2 = new CapabilityRegistry()
    registry2.register({
      id: 'click_at',
      name: 'Click at',
      description: 'click a point on a window',
      category: 'desktop',
      tools: ['desktop.click'],
      contexts: ['desktop'],
      riskLevel: 'action',
      risk: 'medium',
      destructive: false,
      readOnly: false,
    } satisfies CapabilityDefinition)
    return registry2
  }

  it('resolves an explicit capability step to its registered implementation tool', () => {
    const { verdicts, resolutions } = validatePlan(
      [{ toolId: 'ignored', capability: 'click_at', payload: { window_id: '1', x: 1, y: 1 } }],
      registry,
      0,
      10,
      undefined,
      caps(),
    )
    expect(verdicts[0]).toEqual({ ok: true })
    expect(resolutions).toEqual([
      {
        stepIndex: 0,
        capability: 'click_at',
        toolId: 'desktop.click',
        fallback: false,
        preferred: 'desktop.click',
        permission: 'write',
        risk: 'medium',
        verificationPreference: 'normal',
        requiresConfirmation: false,
        ranked: ['desktop.click'],
        policyDropped: [],
      },
    ])
  })

  it('accepts a REGISTERED capability id in the toolId slot (tool ids still win)', () => {
    const { verdicts, resolutions } = validatePlan(
      [{ toolId: 'click_at', payload: { window_id: '1', x: 1, y: 1 } }],
      registry,
      0,
      10,
      undefined,
      caps(),
    )
    expect(verdicts[0]).toEqual({ ok: true })
    expect(resolutions?.[0]).toMatchObject({ capability: 'click_at', toolId: 'desktop.click' })
  })

  it('a REGISTERED tool id in the toolId slot beats the capability namespace', () => {
    const withTool = caps()
    withTool.register({
      id: 'notes.get',
      name: 'Notes Get',
      description: 'read notes',
      category: 'memory',
      tools: ['notes.get'],
      contexts: ['memory'],
      riskLevel: 'read_only',
      risk: 'read_only',
      destructive: false,
      readOnly: true,
    })
    const { verdicts, resolutions } = validatePlan([{ toolId: 'notes.get' }], registry, 0, 10, undefined, withTool)
    expect(verdicts[0]).toEqual({ ok: true })
    expect(resolutions).toBeUndefined()
  })

  it('rejects an unregistered capability name before any tool check', () => {
    const { verdicts } = validatePlan(
      [{ toolId: 'whatever', capability: 'not_a_capability', payload: { window_id: '1' } }],
      registry,
      0,
      10,
      undefined,
      caps(),
    )
    expect(verdicts[0]).toMatchObject({ code: 'capability_unregistered' })
  })

  it('returns capability_unavailable when the capability exists but no tool is registered', () => {
    const empty = new CapabilityRegistry()
    empty.register({
      id: 'click_at',
      name: 'Click at',
      description: 'click',
      category: 'desktop',
      tools: ['android.click'],
      contexts: ['desktop'],
      riskLevel: 'action',
      risk: 'medium',
      destructive: false,
      readOnly: false,
    })
    const { verdicts } = validatePlan([{ toolId: 'click_at', payload: {} }], registry, 0, 10, undefined, empty)
    expect(verdicts[0]).toMatchObject({ code: 'capability_unavailable' })
  })

  it('validates the RESOLVED tool contract (undeclared payloads still rejected)', () => {
    const { verdicts } = validatePlan(
      [{ toolId: 'click_at', payload: { window_id: '1', argv: ['--force'] } }],
      registry,
      0,
      10,
      undefined,
      caps(),
    )
    expect(verdicts[0]).toMatchObject({ code: 'undeclared' })
  })

  it('applies environment availability to the RESOLVED tool, not the capability name', () => {
    const { verdicts } = validatePlan(
      [{ toolId: 'click_at', payload: { window_id: '1' } }],
      registry,
      0,
      10,
      (id) => id !== 'desktop.click',
      caps(),
    )
    expect(verdicts[0]).toMatchObject({ code: 'capability_unavailable' })
  })

  it('capability steps produce no resolutions when no capabilities are supplied (pure tool plans)', () => {
    const { verdicts, resolutions } = validatePlan([{ toolId: 'desktop.click', payload: { window_id: '1' } }], registry)
    expect(verdicts[0]).toEqual({ ok: true })
    expect(resolutions).toBeUndefined()
  })
})

describe('Phase 2.2 — declared dependencies in plan validation', () => {
  it('accepts a dependency on an earlier, valid request', () => {
    const { verdicts } = validatePlan(
      [
        { toolId: 'desktop.click', payload: { window_id: '1' } },
        { toolId: 'notes.get', dependsOn: [0] },
      ],
      registry,
    )
    expect(verdicts[0]).toEqual({ ok: true })
    expect(verdicts[1]).toEqual({ ok: true })
  })

  it('rejects self/later/negative/non-integer dependencies', () => {
    for (const bad of [[1], [-1], ['1.5'], [0.5], [1, -1]]) {
      const { verdicts } = validatePlan(
        [
          { toolId: 'desktop.click', payload: { window_id: '1' } },
          { toolId: 'notes.get', dependsOn: bad as number[] },
        ],
        registry,
      )
      expect(verdicts[1].ok).toBe(false)
      expect(verdicts[1]).toMatchObject({ code: 'dependency' })
    }
  })

  it('rejects a dependency on a request that itself failed validation', () => {
    const { verdicts } = validatePlan(
      [
        { toolId: 'shell.exec' },
        { toolId: 'notes.get', dependsOn: [0] },
      ],
      registry,
    )
    expect(verdicts[0].ok).toBe(false)
    expect(verdicts[1].ok).toBe(false)
    expect(verdicts[1]).toMatchObject({ code: 'dependency' })
  })
})