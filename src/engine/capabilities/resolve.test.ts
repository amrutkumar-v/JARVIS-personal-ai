import { describe, expect, it } from 'vitest'
import type { Tool, ToolContext, ToolInput, ToolResult, ToolVerification } from '../../tools/Tool'
import { CapabilityRegistry } from './registry'
import { resolveCapability, resolveDefinition } from './resolve'
import type { CapabilityDefinition } from './types'

class LaunchTool implements Tool {
  readonly id = 'app.launch'
  readonly category = 'system'
  readonly name = 'Launch app'
  readonly description = 'launches an app'
  readonly permission = 'user_confirmation'
  readonly inputSchema = { type: 'object' as const, properties: { app: { type: 'string' } }, required: ['app'] }
  readonly requiresPermission = true
  readonly verifiable = true
  canRun(): boolean { return true }
  async execute(): Promise<ToolResult> { return { ok: true, message: 'launched' } }
  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    return { ok: true, message: 'confirmed' }
  }
}

class StatusTool implements Tool {
  readonly id = 'window.status'
  readonly category = 'compute'
  readonly name = 'Window status'
  readonly description = 'reports a window'
  readonly permission = 'read_only'
  readonly inputSchema = { type: 'object' as const, properties: {}, required: [] }
  readonly requiresPermission = false
  readonly verifiable = true
  canRun(): boolean { return true }
  async execute(): Promise<ToolResult> { return { ok: true, message: 'open' } }
  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    return { ok: true, message: 'confirmed' }
  }
}

class ScreenshotTool implements Tool {
  readonly id = 'desktop.screenshot'
  readonly category = 'compute'
  readonly name = 'Screenshot'
  readonly description = 'captures the screen'
  readonly permission = 'low_risk'
  readonly inputSchema = { type: 'object' as const, properties: {}, required: [] }
  readonly requiresPermission = false
  readonly verifiable = true
  canRun(): boolean { return true }
  async execute(): Promise<ToolResult> { return { ok: true, message: 'captured' } }
  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    return { ok: true, message: 'confirmed' }
  }
}

class UnverifiableTool implements Tool {
  readonly id = 'window.list'
  readonly category = 'compute'
  readonly name = 'List windows'
  readonly description = 'lists windows'
  readonly permission = 'read_only'
  readonly inputSchema = { type: 'object' as const, properties: {}, required: [] }
  readonly requiresPermission = false
  canRun(): boolean { return true }
  async execute(): Promise<ToolResult> { return { ok: true, message: 'list' } }
}

const tools: Record<string, Tool> = {
  'app.launch': new LaunchTool(),
  'window.status': new StatusTool(),
  'desktop.screenshot': new ScreenshotTool(),
  'window.list': new UnverifiableTool(),
}

const registry = { get: (id: string) => tools[id] }

function openApp(): CapabilityDefinition {
  return {
    id: 'open_application',
    name: 'Open application',
    description: 'launch an app',
    category: 'application',
    tools: ['app.launch'],
    contexts: ['app', 'desktop', 'generic'],
    riskLevel: 'action',
    risk: 'medium',
    destructive: false,
    readOnly: false,
    verification: 'strong',
  }
}

function observe(): CapabilityDefinition {
  return {
    id: 'observe_desktop',
    name: 'Observe desktop',
    description: 'see the screen',
    category: 'desktop',
    tools: ['window.status', 'desktop.screenshot'],
    contexts: ['desktop'],
    riskLevel: 'read_only',
    risk: 'read_only',
    destructive: false,
    readOnly: true,
    verification: 'none',
  }
}

function listWindows(): CapabilityDefinition {
  return {
    ...observe(),
    id: 'list_windows',
    tools: ['window.list', 'window.status'],
  }
}

describe('Phase 2.3 — deterministic capability → tool resolution (pure)', () => {
  it('resolves the preferred declared implementation when it is registered and selectable', () => {
    const caps = new CapabilityRegistry()
    caps.register(openApp())
    const r = resolveCapability('open_application', caps, registry)
    expect(r).toMatchObject({ ok: true, toolId: 'app.launch', fallback: false, preferred: 'app.launch' })
  })

  it('never invents an implementation: unknown capability ids fail honestly', () => {
    const caps = new CapabilityRegistry()
    caps.register(openApp())
    const r = resolveCapability('shell.exec', caps, registry)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('capability_unavailable')
  })

it('reports capability_unavailable when no DECLARED tool is registered', () => {
    const caps = new CapabilityRegistry()
    caps.register({ ...openApp(), tools: ['android.activity'] })
    const r = resolveCapability('open_application', caps, registry)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('capability_unavailable')
  })

  it('drops candidates above an optional maxPermission ceiling', () => {
    const caps = new CapabilityRegistry()
    caps.register(openApp())
    const r = resolveCapability('open_application', caps, registry, { maxPermission: 'low_risk' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no registered, selectable implementation/)
  })

  it('filters candidates by the TOOL&apos;S derived context, dropping non-matching ones', () => {
    const caps = new CapabilityRegistry()
    caps.register(observe())
    const capsApp = new CapabilityRegistry()
    capsApp.register(openApp())
    const rDesktop = resolveCapability('observe_desktop', caps, registry, { context: 'desktop' })
    expect(rDesktop).toMatchObject({ ok: true, toolId: 'window.status' })
    const rWeb = resolveCapability('observe_desktop', caps, registry, { context: 'web' })
    expect(rWeb.ok).toBe(false)
    // window.status derives context `desktop` → `app` drops it; app.launch
    // derives `app` → an `app`-only resolution succeeds for open_application.
    const rAppWrong = resolveCapability('observe_desktop', caps, registry, { context: 'app' })
    expect(rAppWrong.ok).toBe(false)
    const rApp = resolveCapability('open_application', capsApp, registry, { context: 'app' })
    expect(rApp).toMatchObject({ ok: true, toolId: 'app.launch' })
  })

  it('bounded fallback: a lower declared preference wins when the first is unavailable', () => {
    const caps = new CapabilityRegistry()
    caps.register(listWindows())
    const r = resolveCapability('list_windows', caps, registry, { available: (id) => id !== 'window.list' })
    expect(r).toMatchObject({ ok: true, toolId: 'window.status', fallback: true, preferred: 'window.list' })
  })

  it('stably orders verifiable candidates first when preferVerifiable is set', () => {
    const caps = new CapabilityRegistry()
    caps.register(listWindows())
    const r = resolveCapability('list_windows', caps, registry, { preferVerifiable: true })
    expect(r).toMatchObject({ ok: true, toolId: 'window.status', fallback: true })
  })

  it('when EVERY candidate is unavailable the resolution fails honestly', () => {
    const caps = new CapabilityRegistry()
    caps.register(listWindows())
    const r = resolveCapability('list_windows', caps, registry, { available: (id) => id !== 'window.list' && id !== 'window.status' })
    expect(r.ok).toBe(false)
  })

  it('resolveDefinition is deterministic and reports a readable reason', () => {
    const r = resolveDefinition(observe(), registry)
    expect(r).toMatchObject({ ok: true, toolId: 'window.status', fallback: false, verifiable: true })
    if (r.ok) expect(r.reason).toContain('observe_desktop')
  })

  it('verification hints are advisory: a resolved tool without verify() is flagged, never refused', () => {
    const caps = new CapabilityRegistry()
    caps.register({ ...listWindows(), tools: ['window.list'], verification: 'strong' })
    const r = resolveCapability('list_windows', caps, registry)
    expect(r).toMatchObject({ ok: true, toolId: 'window.list' })
    if (r.ok) {
      expect(r.verifiable).toBe(false)
      expect(r.verificationCompatible).toBe(false)
      expect(r.reason).toMatch(/cannot self-verify/)
    }
  })

  describe('Phase 2.4 — policy, ranking and preview fields', () => {
    it('exposes application-owned preview fields on a successful resolution', () => {
      const caps = new CapabilityRegistry()
      caps.register(openApp())
      const r = resolveCapability('open_application', caps, registry)
      expect(r).toMatchObject({
        ok: true,
        toolId: 'app.launch',
        permission: 'device_control',
        risk: 'medium',
        verificationPreference: 'strong',
        requiresConfirmation: false,
        ranked: ['app.launch'],
        policyDropped: [],
      })
    })

    it('orders observe candidates by risk and reports the ranked list', () => {
      const caps = new CapabilityRegistry()
      caps.register(observe())
      const r = resolveCapability('observe_desktop', caps, registry)
      // window.status (read_only) outranks desktop.screenshot (low_risk).
      expect(r).toMatchObject({
        ok: true,
        toolId: 'window.status',
        permission: 'read',
        ranked: ['window.status', 'desktop.screenshot'],
      })
      if (r.ok) expect(r.reason).toContain('window.status')
    })

    it('device scope is a HARD filter: a capability never silently moves devices', () => {
      const caps = new CapabilityRegistry()
      caps.register(observe())
      const rPhone = resolveCapability('observe_desktop', caps, registry, {
        capabilityContext: { activeDevice: 'phone' },
      })
      expect(rPhone.ok).toBe(false)
      if (!rPhone.ok) expect(rPhone.reason).toMatch(/requested device "android"/)
      // Same capability on the desktop is fine.
      const rDesktop = resolveCapability('observe_desktop', caps, registry, {
        capabilityContext: { activeDevice: 'desktop' },
      })
      expect(rDesktop).toMatchObject({ ok: true, toolId: 'window.status' })
    })

    it('drops an implementation above the application permission ceiling, honestly', () => {
      const caps = new CapabilityRegistry()
      caps.register({ ...observe(), maximumPermission: 'read' })
      const r = resolveCapability('observe_desktop', caps, registry)
      expect(r).toMatchObject({ ok: true, toolId: 'window.status', fallback: false })
      if (r.ok) {
        expect(r.policyDropped).toHaveLength(1)
        expect(r.policyDropped[0].toolId).toBe('desktop.screenshot')
        expect(r.policyDropped[0].reason).toMatch(/ceiling/)
      }
    })

    it('strict verification requirement drops non-verifiable implementations', () => {
      const caps = new CapabilityRegistry()
      caps.register(listWindows())
      const r = resolveCapability('list_windows', caps, registry, { requireVerification: true })
      expect(r).toMatchObject({ ok: true, toolId: 'window.status', fallback: true })
      if (r.ok) {
        expect(r.policyDropped).toHaveLength(1)
        expect(r.policyDropped[0].toolId).toBe('window.list')
        expect(r.policyDropped[0].reason).toMatch(/cannot self-verify/)
      }
      // When every implementation is non-verifiable, resolution fails honestly.
      const rNone = resolveCapability('list_windows', caps, registry, {
        requireVerification: true,
        available: (id) => id !== 'window.status',
      })
      expect(rNone).toMatchObject({ ok: false, code: 'capability_unavailable' })
      if (!rNone.ok) expect(rNone.reason).toMatch(/allowed by the application policy/)
    })

    it('context requiresVerification behaves like the constraint flag', () => {
      const caps = new CapabilityRegistry()
      caps.register(listWindows())
      const r = resolveCapability('list_windows', caps, registry, {
        capabilityContext: { requiresVerification: true },
      })
      expect(r).toMatchObject({ ok: true, toolId: 'window.status', fallback: true })
    })

    it('a capability flagged requiresConfirmation surfaces the app policy', () => {
      const caps = new CapabilityRegistry()
      caps.register({ ...openApp(), requiresConfirmation: true })
      const r = resolveCapability('open_application', caps, registry)
      expect(r).toMatchObject({ ok: true, requiresConfirmation: true })
      // Defaults stay false unless the application marks the capability.
      const caps2 = new CapabilityRegistry()
      caps2.register(openApp())
      expect(resolveCapability('open_application', caps2, registry)).toMatchObject({
        ok: true,
        requiresConfirmation: false,
      })
    })

    it('ranking drives bounded fallback with a readable ranked rationale', () => {
      const caps = new CapabilityRegistry()
      caps.register(listWindows())
      const r = resolveCapability('list_windows', caps, registry, {
        available: (id) => id !== 'window.list',
      })
      expect(r).toMatchObject({ ok: true, toolId: 'window.status', fallback: true, preferred: 'window.list' })
      if (r.ok) {
        // Only one candidate survived availability-filtering, so it is the
        // deterministic winner and the fallback is explained honestly.
        expect(r.ranked).toEqual(['window.status'])
        expect(r.reason).toContain('via deterministic ranking')
        expect(r.reason).toContain('approved fallback "window.status"')
      }
    })
  })
})