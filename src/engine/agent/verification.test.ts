import { describe, expect, it, vi } from 'vitest'
import { runToolVerification, verificationPassed, verificationSuffix } from './verification'
import type { Tool, ToolContext, ToolResult, ToolInput, ToolVerification } from '../../tools/Tool'
import type { ToolExecutionResult } from './runTool'

const ctx: ToolContext = { requestId: 'r1', memory: {} as never }

function mockTool(verifyImpl?: Tool['verify']): Tool {
  const tool: Tool = {
    id: 'fake',
    category: 'info',
    name: 'Fake',
    description: 'fake',
    permission: 'read_only',
    inputSchema: { type: 'object', properties: {}, required: [] },
    verifiable: Boolean(verifyImpl),
    verify: verifyImpl,
    requiresPermission: false,
    canRun: () => true,
    execute: async () => ({ ok: true, message: 'done' }),
  }
  return tool
}

function success(): ToolExecutionResult {
  return { success: true, toolId: 'fake', summary: 'done', output: null, durationMs: 5, attempts: 1 }
}

describe('runToolVerification', () => {
  it('returns not_applicable for tools without a verifier', async () => {
    const verification = await runToolVerification(mockTool(), { query: 'q', params: {} }, success(), ctx)
    expect(verification.status).toBe('not_applicable')
  })

  it('returns verified when the verifier confirms', async () => {
    const tool = mockTool(async (_i: ToolInput, _r: ToolResult) => ({
      ok: true,
      message: 'File exists.',
      checks: ['exists', 'size>0'],
    }))
    const verification = await runToolVerification(tool, { query: 'q', params: {} }, success(), ctx)
    expect(verification.status).toBe('verified')
    expect(verification.message).toBe('File exists.')
    expect(verification.checks).toEqual(['exists', 'size>0'])
  })

  it('returns failed when the verifier refutes the claim', async () => {
    const tool = mockTool(async () => ({ ok: false, message: 'Destination is missing.' }))
    const verification = await runToolVerification(tool, { query: 'q', params: {} }, success(), ctx)
    expect(verification.status).toBe('failed')
    expect(verification.message).toContain('Destination is missing.')
  })

  it('degrades to unverified when the verifier throws', async () => {
    const spy = vi.fn(async () => {
      throw new Error('verifier crashed')
    })
    const tool = mockTool(spy)
    const verification = await runToolVerification(tool, { query: 'q', params: {} }, success(), ctx)
    expect(verification.status).toBe('unverified')
    expect(verification.message).toContain('could not confirm')
  })

  it('degrades to unverified when the verifier returns a malformed result', async () => {
    const tool = mockTool(async () => ({ okeydokey: true } as never))
    const verification = await runToolVerification(tool, { query: 'q', params: {} }, success(), ctx)
    expect(verification.status).toBe('unverified')
  })
})

describe('verificationPassed', () => {
  it('is false only for a refuted verification', () => {
    expect(verificationPassed(undefined)).toBe(true)
    expect(verificationPassed({ status: 'not_applicable', message: '', durationMs: 0 })).toBe(true)
    expect(verificationPassed({ status: 'verified', message: '', durationMs: 0 })).toBe(true)
    expect(verificationPassed({ status: 'unverified', message: '', durationMs: 0 })).toBe(true)
    expect(verificationPassed({ status: 'failed', message: '', durationMs: 0 })).toBe(false)
  })
})

describe('verificationSuffix', () => {
  it('renders compact provider-safe suffixes', () => {
    expect(verificationSuffix(undefined)).toBe('')
    expect(verificationSuffix({ status: 'not_applicable', message: '', durationMs: 0 })).toBe('')
    expect(verificationSuffix({ status: 'verified', message: '', durationMs: 0 })).toBe('[verified]')
    expect(verificationSuffix({ status: 'unverified', message: '', durationMs: 0 })).toBe('[unverified]')
    expect(
      verificationSuffix({ status: 'failed', message: 'Destination missing.', durationMs: 0 }),
    ).toBe('[verification failed: Destination missing.]')
  })

  it('returns a ToolVerification for consumers of the contract type', () => {
    const t: ToolVerification = { ok: true }
    expect(t.ok).toBe(true)
  })
})