import { describe, expect, it } from 'vitest'
import { CapabilityRegistry } from './registry'
import type { CapabilityDefinition } from './types'

function def(id: string, tools: string[] = ['app.launch']): CapabilityDefinition {
  return {
    id,
    name: id,
    description: `does ${id}`,
    category: 'application',
    tools,
    contexts: ['app', 'desktop', 'generic'],
    riskLevel: 'action',
    risk: 'medium',
    destructive: false,
    readOnly: false,
    verification: 'strong',
  }
}

describe('Phase 2.3 — CapabilityRegistry (bounded, deterministic, model-immune)', () => {
  it('registers a bounded, explicit catalogue and returns a sorted snapshot', () => {
    const registry = new CapabilityRegistry()
    registry.register(def('open_application'))
    registry.register(def('click_at'))
    expect(registry.size).toBe(2)
    expect(registry.ids()).toEqual(['click_at', 'open_application'])
    expect(registry.all().map((c) => c.id)).toEqual(['click_at', 'open_application'])
  })

  it('defends its own tools array against caller mutation', () => {
    const source = def('open_application', ['app.launch'])
    const registry = new CapabilityRegistry()
    registry.register(source)
    source.tools.push('window.list')
    expect(registry.get('open_application')!.tools).toEqual(['app.launch'])
  })

  it('refuses empty ids, duplicate ids and definitions with no implementation tools', () => {
    const registry = new CapabilityRegistry()
    expect(() => registry.register({ ...def(''), tools: [] })).toThrow(/non-empty id/)
    expect(() => registry.register(def('open_application'))).not.toThrow()
    expect(() => registry.register(def('open_application'))).toThrow(/already registered/)
    expect(() => registry.register({ ...def('broken'), tools: [] })).toThrow(/at least one implementation tool/)
    expect(registry.size).toBe(1)
  })

  it('get/has are exact and unknown ids are never invented', () => {
    const registry = new CapabilityRegistry()
    registry.register(def('open_application'))
    expect(registry.has('open_application')).toBe(true)
    expect(registry.get('open_application')!.name).toBe('open_application')
    expect(registry.has('shell.exec')).toBe(false)
    expect(registry.get('shell.exec')).toBeUndefined()
  })

  it('a capability declares tools but the REGISTRY never runs or resolves them', () => {
    // The registry is a catalogue only: no execution, no resolution, no
    // mutation of any tool registry lived here — resolution lives in resolve.ts.
    const registry = new CapabilityRegistry()
    registry.register(def('open_application', ['app.launch']))
    expect(registry.get('open_application')!.tools).toEqual(['app.launch'])
  })

  it('unregister removes a capability so a later register is possible again', () => {
    const registry = new CapabilityRegistry()
    registry.register(def('send_device_notification'))
    expect(registry.has('send_device_notification')).toBe(true)
    registry.unregister('send_device_notification')
    expect(registry.has('send_device_notification')).toBe(false)
    expect(registry.get('send_device_notification')).toBeUndefined()
    expect(() => registry.register(def('send_device_notification'))).not.toThrow()
  })
})