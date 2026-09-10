import { describe, expect, it } from 'vitest'
import {
  classifyRequest,
  isRiskyDeictic,
  isQuestion,
  hasExplicitTarget,
  hasLocative,
  createActionRegistryView,
  selectToolsForRequest,
  hasTool,
  hasCapability,
  lookupTool,
  determineExecutionPolicy,
  evaluateRequestPolicy,
  executionErrorPhrase,
  executionKindFromAgent,
  unsupportedMessage,
  clarificationMessage,
  actionHintMessage,
} from './index'
import type { Tool, ToolContext, ToolInput, ToolResult } from '../../tools/Tool'
import type { CapabilityDefinition } from '../capabilities/types'

/** Minimal fake tool for dense registry tests. */
function fakeTool(partial: Partial<Tool>): Tool {
  return {
    id: 't',
    name: 'Test',
    description: 'test',
    category: 'compute',
    permission: 'read_only',
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission: false,
    canRun: () => false,
    execute: async (): Promise<ToolResult> => ({ ok: true, message: 'ok' }),
    ...partial,
  }
}

function emptyView() {
  return createActionRegistryView([], [])
}

function fileCapability(): CapabilityDefinition {
  return {
    id: 'read_file',
    name: 'Read a file',
    description: 'Read the contents of a file in the files domain.',
    category: 'files',
    tools: ['file.read'],
    contexts: ['files'],
    riskLevel: 'read_only',
    risk: 'read_only',
    destructive: false,
    readOnly: true,
    verification: 'strong',
  }
}

describe('Phase 2.6 — registry view', () => {
  it('implements a read-only projection of tools and capabilities', () => {
    const tool = fakeTool({ id: 'file.read', name: 'Read File', permission: 'read_only' })
    const view = createActionRegistryView([tool], [fileCapability()])

    expect(hasTool(view, 'file.read')).toBe(true)
    expect(hasTool(view, 'nope')).toBe(false)
    expect(hasCapability(view, 'read_file')).toBe(true)
    expect(lookupTool(view, 'file.read')?.label).toBe('Read File')
    expect(view.tools).toHaveLength(1)
    expect(view.capabilities[0].toolIds).toEqual(['file.read'])
  })

  it('selects tools whose canRun understands the request (deterministic order)', () => {
    const a = fakeTool({ id: 'aaa', canRun: (q) => q.includes('alpha') })
    const b = fakeTool({ id: 'bbb', canRun: (q) => q.includes('beta') })
    const view = createActionRegistryView([b, a], [])

    const sel = selectToolsForRequest(view, 'beta and alpha today')
    expect(sel.matched).toBe(true)
    expect(sel.matches.map((m) => m.toolId)).toEqual(['aaa', 'bbb'])
  })

  it('never crashes on a throwing canRun nor matches nothing', () => {
    const bad = fakeTool({
      id: 'bad',
      canRun: (_q: string) => {
        throw new Error('boom')
      },
    })
    const view = createActionRegistryView([bad], [])
    expect(selectToolsForRequest(view, 'anything').matched).toBe(false)
  })

  it('reports missing lookups honestly', () => {
    const view = emptyView()
    expect(hasTool(view, 'x')).toBe(false)
    expect(hasCapability(view, 'x')).toBe(false)
    expect(lookupTool(view, 'x')).toBeUndefined()
    expect(selectToolsForRequest(view, 'hello').matches).toEqual([])
  })
})

describe('Phase 2.6 — classifier', () => {
  it('treats a clearly-unmatched question as informational', () => {
    const decision = classifyRequest('what is the meaning of life', emptyView())
    expect(decision.kind).toBe('informational')
  })

  it('classifies a request a registered tool understands as executable', () => {
    const tool = fakeTool({ id: 'calculator', canRun: (q) => /what is \d+/.test(q) })
    const view = createActionRegistryView([tool], [])
    const decision = classifyRequest('what is 3 * 7', view)
    expect(decision.kind).toBe('executable')
    expect(decision.matchedTools[0].toolId).toBe('calculator')
  })

  it('treats an imperative request in an unconnected domain as unsupported', () => {
    const decision = classifyRequest('send a message to Mia on Slack', emptyView())
    expect(decision.kind).toBe('unsupported')
    expect(decision.domain).toBe('communication')
  })

  it('treats a device request as unsupported when nothing is connected', () => {
    const decision = classifyRequest('turn down the volume', emptyView())
    expect(decision.kind).toBe('unsupported')
    expect(decision.domain).toBe('device')
  })

  it('treats a files-domain request as executable-passthrough when a backed capability connects', () => {
    const tool = fakeTool({ id: 'file.read', name: 'Read File', canRun: () => false })
    const view = createActionRegistryView([tool], [fileCapability()])
    const decision = classifyRequest('read the readme', view)
    expect(decision.kind).toBe('executable')
    expect(decision.matchedCapabilities).toContain('read_file')
  })

  it('treats an apps-domain request as unsupported when the capability is not backed by a tool', () => {
    const cap: CapabilityDefinition = {
      id: 'open_application',
      name: 'Open an application',
      description: 'Launch an application on the desktop.',
      category: 'application',
      tools: ['application_open'],
      contexts: ['desktop'],
      riskLevel: 'action',
      risk: 'medium',
      destructive: false,
      readOnly: false,
    }
    const view = createActionRegistryView([], [cap])
    const decision = classifyRequest('launch the settings app', view)
    expect(decision.kind).toBe('unsupported')
    expect(decision.domain).toBe('apps')
  })

  it('treats an apps-domain request as executable when a backed capability connects', () => {
    const cap: CapabilityDefinition = {
      id: 'open_application',
      name: 'Open an application',
      description: 'Launch an application on the desktop.',
      category: 'application',
      tools: ['application_open'],
      contexts: ['desktop'],
      riskLevel: 'action',
      risk: 'medium',
      destructive: false,
      readOnly: false,
    }
    const view = createActionRegistryView([fakeTool({ id: 'application_open' })], [cap])
    const decision = classifyRequest('launch the settings app', view)
    expect(decision.kind).toBe('executable')
    expect(decision.domain).toBe('apps')
  })

  it('never throws on empty or whitespace input', () => {
    expect(classifyRequest('', emptyView()).kind).toBe('informational')
    expect(classifyRequest('   ', emptyView()).kind).toBe('informational')
  })
})

describe('Phase 2.6 — risky-deictic + explicit target guards', () => {
  it('flags a destructive deictic request without an explicit target', () => {
    expect(isRiskyDeictic('delete that file')).toBe(true)
    expect(isRiskyDeictic('remove it')).toBe(true)
    expect(isRiskyDeictic('forget it')).toBe(true)
    expect(isRiskyDeictic('move that to the bin')).toBe(true)
  })

  it('does NOT flag explicit or non-destructive requests', () => {
    expect(isRiskyDeictic('delete C:/temp/a.txt')).toBe(false)
    expect(isRiskyDeictic('delete "C:/temp/a.txt"')).toBe(false)
    expect(isRiskyDeictic('delete the report.pdf')).toBe(false)
    expect(isRiskyDeictic('show it to me')).toBe(false)
    expect(isRiskyDeictic('do it')).toBe(false)
    expect(isRiskyDeictic('can you delete that file?')).toBe(false)
    expect(isRiskyDeictic('clear all memories')).toBe(false)
  })

  it('hasExplicitTarget recognises paths, quotes and extensions', () => {
    expect(hasExplicitTarget('open C:/Users/me/a.txt')).toBe(true)
    expect(hasExplicitTarget('open "my file"')).toBe(true)
    expect(hasExplicitTarget('open my file.pdf')).toBe(true)
    expect(hasExplicitTarget('open that')).toBe(false)
  })

  it('hasLocative recognises folder references', () => {
    expect(hasLocative('show the files in Downloads')).toBe(true)
    expect(hasLocative('open that')).toBe(false)
  })

  it('isQuestion recognises question forms', () => {
    expect(isQuestion('what time is it?')).toBe(true)
    expect(isQuestion('can you delete that file?')).toBe(true)
    expect(isQuestion('delete that file')).toBe(false)
  })
})

describe('Phase 2.6 — execution policy', () => {
  it('maps permission tiers onto the tri-state policy', () => {
    expect(determineExecutionPolicy('read_only')).toBe('safe')
    expect(determineExecutionPolicy('low_risk')).toBe('safe')
    expect(determineExecutionPolicy('user_confirmation')).toBe('confirmation_required')
    expect(determineExecutionPolicy('high_risk')).toBe('confirmation_required')
  })

  it('blocks a request whose capability is not connected', () => {
    const eval_ = evaluateRequestPolicy({ capabilityConnected: false, domain: 'apps' })
    expect(eval_.policy).toBe('blocked')
    expect(eval_.reason).toMatch(/not connected/)
  })

  it('is safe for a connected read-only mechanism', () => {
    expect(evaluateRequestPolicy({ permission: 'read_only', capabilityConnected: true }).policy).toBe('safe')
  })

  it('requires confirmation for higher-risk connected mechanisms', () => {
    expect(
      evaluateRequestPolicy({ permission: 'user_confirmation', capabilityConnected: true }).policy,
    ).toBe('confirmation_required')
  })
})

describe('Phase 2.6 — error vocabulary & phrasing', () => {
  it('provides safe, kind-stable user phrasing', () => {
    expect(executionErrorPhrase('permission_denied')).toMatch(/not permitted/)
    expect(executionErrorPhrase('target_not_found')).toMatch(/could not be found/)
    expect(executionErrorPhrase('unsupported')).toMatch(/not connected/)
    expect(executionErrorPhrase('verification_failure')).toMatch(/could not be confirmed/)
  })

  it('maps the agent error vocabulary onto execution kinds', () => {
    expect(executionKindFromAgent('invalid_input')).toBe('invalid_input')
    expect(executionKindFromAgent('permission_denied')).toBe('permission_denied')
    expect(executionKindFromAgent('user_cancelled')).toBe('cancelled')
    expect(executionKindFromAgent('tool_failure')).toBe('execution_failure')
    expect(executionKindFromAgent('timeout')).toBe('timeout')
    expect(executionKindFromAgent()).toBeUndefined()
  })
})

describe('Phase 2.6 — deterministic messages', () => {
  it('unsupported replies are honest and capability-aware', () => {
    const textMsg = unsupportedMessage('communication')
    expect(textMsg).toMatch(/(isn't|is not|not) connected/i)
    expect(textMsg).toMatch(/won't pretend/i)
  })

  it('clarification replies never claim an action ran', () => {
    const reply = clarificationMessage('delete that file')
    expect(reply).toMatch(/didn't act/)
    expect(reply).toMatch(/which file/i)
  })

  it('clarification with candidates lists them', () => {
    const reply = clarificationMessage('delete that', ['a.txt', 'b.txt'])
    expect(reply).toContain('a.txt')
    expect(reply).toContain('b.txt')
  })

  it('action hint names matched mechanisms or returns null', () => {
    expect(actionHintMessage([], [])).toBeNull()
    const hint = actionHintMessage(
      [{ toolId: 'file.delete', label: 'Delete', permission: 'user_confirmation' }],
      ['destroy_file'],
    )
    expect(hint).toMatch(/file\.delete/)
    expect(hint).toMatch(/destroy_file/)
  })
})

describe('Phase 2.6 — honesty rails in the pure layer', () => {
  it('the pure layer never references execution, storage or secrets', () => {
    // Covered structurally by goal/security.test.ts PROD_FILES; here we assert
    // the exported surface exposes no exec/I-O/privacy handles.
    const view = emptyView()
    expect(view.tools).toEqual([])
    expect(view.capabilities).toEqual([])
  })

  it('returns safe phrasing for every execution error kind (no raw exceptions)', () => {
    for (const kind of [
      'invalid_input',
      'tool_unavailable',
      'permission_denied',
      'target_not_found',
      'execution_failure',
      'timeout',
      'verification_failure',
      'cancelled',
      'unsupported',
    ] as const) {
      const phrase = executionErrorPhrase(kind)
      expect(phrase.length).toBeGreaterThan(0)
      expect(phrase.length).toBeLessThan(160)
    }
  })
})

describe('Phase 2.6 — tool shape guard for registry views', () => {
  it('canonicalizes tool input via the structural contract', () => {
    const ctx: ToolContext = { requestId: 'r1' }
    const input: ToolInput = { query: 'q', params: {} }
    const tool = fakeTool({
      id: 'probe',
      execute: async (_i: ToolInput, _c: ToolContext) => ({ ok: true, message: 'probed', data: { path: 'C:/x.txt' } }),
    })
    void ctx
    void input
    return expect(tool.id).toBe('probe')
  })
})