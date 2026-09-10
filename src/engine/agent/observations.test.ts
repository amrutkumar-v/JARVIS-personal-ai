import { describe, expect, it } from 'vitest'
import type { ToolExecutionResult } from './runTool'
import { classifyObservation } from './observations'
import type { AgentVerification } from './types'

function result(overrides: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
  return {
    success: true,
    toolId: 'fake',
    summary: 'did the thing',
    output: { ok: true },
    durationMs: 10,
    attempts: 1,
    ...overrides,
  }
}

const verification = (partial: Pick<AgentVerification, 'status'> & Partial<AgentVerification>): AgentVerification => ({
  message: '',
  durationMs: 5,
  ...partial,
})

describe('classifyObservation', () => {
  it('maps an execution failure to failure with its errorKind', () => {
    const obs = classifyObservation(result({ success: false, errorKind: 'tool_failure', summary: 'boom' }))
    expect(obs.kind).toBe('failure')
    expect(obs.errorKind).toBe('tool_failure')
    expect(obs.attempts).toBe(1)
  })

  it('maps verified success to success', () => {
    const obs = classifyObservation(result(), verification({ status: 'verified', message: 'confirmed' }))
    expect(obs.kind).toBe('success')
    expect(obs.verification?.status).toBe('verified')
  })

  it('maps refuted success to verification (verifier said no)', () => {
    const obs = classifyObservation(result(), verification({ status: 'failed', message: 'File not found.' }))
    expect(obs.kind).toBe('verification')
    expect(obs.errorKind).toBe('tool_failure')
    expect(obs.summary).toContain('File not found.')
  })

  it('maps unverified success to partial (effect not confirmed)', () => {
    const obs = classifyObservation(result(), verification({ status: 'unverified', message: 'Could not confirm.' }))
    expect(obs.kind).toBe('partial')
    expect(obs.summary).toContain('unverified')
  })

  it('maps non-verifiable success to informational with no verification record', () => {
    const obs = classifyObservation(result())
    expect(obs.kind).toBe('informational')
    expect(obs.verification).toBeUndefined()
  })

  it('carries data and timing through every classification', () => {
    const obs = classifyObservation(result({ output: { answer: 42 }, durationMs: 99, attempts: 3 }))
    expect(obs.data).toEqual({ answer: 42 })
    expect(obs.durationMs).toBe(99)
    expect(obs.attempts).toBe(3)
  })
})