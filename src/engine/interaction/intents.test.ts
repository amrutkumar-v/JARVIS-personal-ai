import { describe, it, expect } from 'vitest'
import {
  detectDirectIntent,
  normalizeRequest,
  capabilityCatalogReply,
  renderCapabilityCatalogReply,
} from './intents'
import type { CapabilityDefinition } from '../capabilities/types'

const def = (id: string, category: CapabilityDefinition['category']): CapabilityDefinition => ({
  id,
  name: id.replace(/_/g, ' '),
  description: `${id} does something`,
  category,
  tools: [id],
  contexts: ['files'],
  riskLevel: 'read_only',
  risk: 'low',
  destructive: false,
  readOnly: true,
})

const ONLINE: CapabilityDefinition[] = [
  def('search_web', 'data'),
  def('open_application', 'application'),
  def('remember_fact', 'system'),
]

const ENV = {
  applicationConnected: false,
  observationConnected: true,
  desktopConnected: false,
  visionConnected: false,
  deviceConnected: false,
}

describe('interaction intents', () => {
  it('normalizes request text', () => {
    expect(normalizeRequest('  What can you do?! ')).toBe('what can you do')
    expect(normalizeRequest('HELP ME!!!')).toBe('help me')
  })

  it('detects capabilities meta-request', () => {
    expect(detectDirectIntent('what can you do')).toBe('capabilities')
    expect(detectDirectIntent('What are your capabilities?')).toBe('capabilities')
  })

  it('detects help meta-request', () => {
    expect(detectDirectIntent('help')).toBe('help')
    expect(detectDirectIntent('Help me with my code')).toBe('help')
  })

  it('does not detect ordinary requests', () => {
    expect(detectDirectIntent('open chrome')).toBe('none')
    expect(detectDirectIntent('what is the weather')).toBe('none')
    expect(detectDirectIntent('')).toBe('none')
  })
})

describe('capabilityCatalogReply', () => {
  it('groups live catalog by category', () => {
    const reply = capabilityCatalogReply(ONLINE, ENV)
    const labels = reply.groups.map((g) => g.label)
    expect(labels).toContain('Quick answers')
    expect(labels).toContain('Application control')
    expect(labels).toContain('Knowledge & memory')
  })

  it('is honest about unavailable seams', () => {
    const reply = capabilityCatalogReply(ONLINE, ENV)
    expect(reply.notes.join('\n')).toContain('native agent connection, which is not active')
    expect(reply.notes.join('\n')).toContain('vision provider')
  })

  it('does not claim connected seams as unavailable', () => {
    const env = { ...ENV, observationConnected: true }
    const reply = capabilityCatalogReply([def('observe_windows', 'desktop')], env)
    expect(reply.notes.join('\n')).not.toContain('observation')
  })
})

describe('renderCapabilityCatalogReply', () => {
  it('renders title, group headings and items', () => {
    const out = renderCapabilityCatalogReply(capabilityCatalogReply(ONLINE, ENV))
    expect(out).toContain('Here is what I can help you with right now')
    expect(out).toContain('QUICK ANSWERS')
    expect(out).toContain('- search web — search_web does something')
    expect(out).toBeTruthy()
  })
})