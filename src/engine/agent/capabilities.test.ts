import { describe, expect, it } from 'vitest'
import type { Tool, ToolContext, ToolInput, ToolResult, ToolVerification } from '../../tools/Tool'
import {
  capabilityCatalog,
  deriveContexts,
  describeCapability,
  isActionableCapability,
  isReadOnlyCapability,
  permissionAtMost,
  resolveCapability,
} from './capabilities'

class ClickTool implements Tool {
  readonly id = 'desktop.click'
  readonly category = 'compute'
  readonly name = 'Click'
  readonly description = 'clicks a point at (x, y)'
  readonly permission = 'user_confirmation'
  readonly inputSchema = {
    type: 'object' as const,
    properties: { window_id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
    required: ['window_id'],
  }
  readonly requiresPermission = true
  readonly verifiable = true
  canRun(): boolean { return true }
  async execute(): Promise<ToolResult> { return { ok: true, message: 'clicked' } }
  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    return { ok: true, message: 'confirmed' }
  }
}

class ReadOnlyTool implements Tool {
  readonly id = 'notes.get'
  readonly category = 'memory'
  readonly name = 'Notes Get'
  readonly description = 'reads a note'
  readonly permission = 'read_only'
  readonly inputSchema = { type: 'object' as const, properties: {}, required: [] }
  readonly requiresPermission = false
  canRun(): boolean { return true }
  async execute(): Promise<ToolResult> { return { ok: true, message: 'none' } }
}

const registry = {
  ids: () => ['notes.get', 'desktop.click'],
  get: (id: string) => (id === 'desktop.click' ? new ClickTool() : id === 'notes.get' ? new ReadOnlyTool() : undefined),
}

describe('Phase 2.2 — capability description (pure, registry-backed)', () => {
  it('derives contexts from declarations, then by id/prefix convention', () => {
    expect(deriveContexts(new ClickTool())).toEqual(['desktop'])
    expect(deriveContexts(new ReadOnlyTool())).toEqual(['memory'])
  })

  it('readOnly/actionable split on the public permission tier', () => {
    expect(isReadOnlyCapability(new ReadOnlyTool())).toBe(true)
    expect(isActionableCapability(new ReadOnlyTool())).toBe(false)
    expect(isReadOnlyCapability(new ClickTool())).toBe(false)
    expect(isActionableCapability(new ClickTool())).toBe(true)
  })

  it('permissionAtMost orders read_only < low_risk < user_confirmation < high_risk', () => {
    expect(permissionAtMost('user_confirmation', 'high_risk')).toBe(true)
    expect(permissionAtMost('high_risk', 'user_confirmation')).toBe(false)
    expect(permissionAtMost('read_only', 'read_only')).toBe(true)
  })

  it('describes a registered capability with its constraints', () => {
    const cap = describeCapability(new ClickTool())
    expect(cap?.id).toBe('desktop.click')
    expect(cap?.risk).toBe('user_confirmation')
    expect(cap?.actionable).toBe(true)
    expect(cap?.verifiable).toBe(true)
    expect(cap?.parameters).toContain('window_id')
    expect(cap?.selectable).toBe(true)
  })

  it('is not selectable when unavailable, above the permission ceiling, or out of budget', () => {
    expect(describeCapability(new ClickTool(), { available: (id) => id !== 'desktop.click' })?.selectable).toBe(false)
    expect(describeCapability(new ClickTool(), { maxPermission: 'low_risk' })?.selectable).toBe(false)
    expect(describeCapability(new ClickTool(), { remainingSteps: 0 })?.selectable).toBe(false)
    expect(describeCapability(new ReadOnlyTool(), { maxPermission: 'low_risk' })?.selectable).toBe(true)
  })

  it('context constraints exclude non-matching capabilities (generic matches all)', () => {
    expect(describeCapability(new ClickTool(), { context: 'web' })?.fitsContext).toBe(false)
    expect(describeCapability(new ClickTool(), { context: 'desktop' })?.selectable).toBe(true)
  })

  it('resolveCapability returns undefined for unknown tools, never throws', () => {
    expect(resolveCapability('shell.exec', registry)).toBeUndefined()
    expect(resolveCapability('desktop.click', registry)?.id).toBe('desktop.click')
  })

  it('capabilityCatalog is a deterministic, sorted mirror of the registry', () => {
    expect(capabilityCatalog(registry).map((c) => c.id)).toEqual(['desktop.click', 'notes.get'])
  })
})