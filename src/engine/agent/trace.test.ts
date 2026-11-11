import { describe, expect, it } from 'vitest'
import { ExecutionTracer } from './trace'
import { classifyTaskStep } from '../goal/evidence'
import type { AgentObservation, AgentVerification } from './types'

const verification: AgentVerification = {
  status: 'verified',
  message: 'confirmed',
  checks: ['exists'],
  durationMs: 3,
}

const observation: AgentObservation = {
  kind: 'success',
  toolId: 'send',
  summary: 'done',
  data: { id: 1 },
  attempts: 1,
  durationMs: 3,
  verification,
}

describe('ExecutionTracer', () => {
  it('returns an empty snapshot before a run starts', () => {
    const tracer = new ExecutionTracer()
    expect(tracer.active).toBe(false)
    expect(tracer.snapshot()).toEqual({ goal: '', steps: [] })
  })

  it('begins a run and records steps', () => {
    const tracer = new ExecutionTracer()
    tracer.begin('send the message')
    expect(tracer.active).toBe(true)
    tracer.addStep({
      toolId: 'send',
      action: 'Send',
      arguments: { to: 'a' },
      status: 'COMPLETED',
      observation,
      verification,
    })
    const trace = tracer.snapshot()
    expect(trace.goal).toBe('send the message')
    expect(trace.steps).toHaveLength(1)
    expect(trace.steps[0].observation?.kind).toBe('success')
    expect(trace.steps[0].verification?.status).toBe('verified')
  })

  it('end() stamps the final state and completion time', () => {
    const tracer = new ExecutionTracer()
    tracer.begin('goal')
    const trace = tracer.end('completed')
    expect(trace.finalState).toBe('completed')
    expect(trace.completedAt).toBeTypeOf('number')
  })

  it('begin() overwrites the previous run', () => {
    const tracer = new ExecutionTracer()
    tracer.begin('first')
    tracer.addStep({ toolId: 'a', action: 'A', arguments: {}, status: 'COMPLETED' })
    tracer.begin('second')
    expect(tracer.snapshot()).toMatchObject({ goal: 'second', steps: [] })
  })

  it('returns a detached copy (mutations do not leak into the trace)', () => {
    const tracer = new ExecutionTracer()
    tracer.begin('goal')
    tracer.addStep({
      toolId: 'a',
      action: 'A',
      arguments: { nested: { b: 1 } },
      status: 'COMPLETED',
      observation,
    })
    const snapshot = tracer.snapshot()
    const nested = snapshot.steps[0].arguments.nested as { b: number }
    nested.b = 999
    snapshot.steps[0].observation!.summary = 'mutated'
    const second = tracer.snapshot()
    expect((second.steps[0].arguments.nested as { b: number }).b).toBe(1)
    expect(second.steps[0].observation!.summary).toBe('done')
  })

  it('updateStepVerification upgrades the LAST matching COMPLETED step (Phase 6)', () => {
    const tracer = new ExecutionTracer()
    tracer.begin('goal')
    tracer.addStep({
      toolId: 'type_text',
      action: 'Type',
      arguments: { text: 'hi' },
      status: 'COMPLETED',
      observation: { kind: 'partial', toolId: 'type_text', summary: 'typed, unverified', attempts: 1, durationMs: 3 },
      verification: { status: 'unverified', message: 'could not confirm', durationMs: 3 },
    })
    tracer.addStep({
      toolId: 'clipboard.read',
      action: 'Read clipboard',
      arguments: {},
      status: 'COMPLETED',
      observation: { kind: 'success', toolId: 'clipboard.read', summary: 'contains hi', data: { text: 'hi' }, attempts: 1, durationMs: 3 },
    })
    const upgraded = tracer.updateStepVerification('type_text', {
      status: 'verified',
      message: 'clipboard contained the typed text',
    })
    expect(upgraded).toBe(true)
    const trace = tracer.snapshot()
    expect(trace.steps[0].verification?.status).toBe('verified')
    expect(trace.steps[0].verification?.message).toContain('clipboard')
    // The observe step itself is untouched (it never had verification of its own).
    expect(trace.steps[1].verification?.status).toBeUndefined()
  })

  it('updateStepVerification only upgrades a matching step with an observation', () => {
    const tracer = new ExecutionTracer()
    tracer.begin('goal')
    tracer.addStep({ toolId: 'a', action: 'A', arguments: {}, status: 'COMPLETED' })
    expect(
      tracer.updateStepVerification('a', { status: 'verified', message: 'x' }),
    ).toBe(false)
    expect(tracer.snapshot().steps[0].verification).toBeUndefined()
  })

  it('updateStepVerification is a no-op when no run is active', () => {
    const tracer = new ExecutionTracer()
    expect(
      tracer.updateStepVerification('a', { status: 'verified', message: 'x' }),
    ).toBe(false)
  })

  it('records a post-action refutation as failed/refuted evidence, never as unverified', () => {
    const tracer = new ExecutionTracer()
    tracer.begin('goal')
    tracer.addStep({
      toolId: 'app.launch',
      action: 'Launch app',
      arguments: { applicationId: 'notepad' },
      status: 'COMPLETED',
      observation: { kind: 'partial', toolId: 'app.launch', summary: 'launch reported success, state unknown', attempts: 1, durationMs: 3 },
      verification: { status: 'unverified', message: 'running state was not observable', durationMs: 3 },
    })

    expect(tracer.updateStepVerification('app.launch', { status: 'failed', message: 'verified not running' })).toBe(true)
    const step = tracer.snapshot().steps[0]!
    expect(step.status).toBe('FAILED')
    expect(step.observation?.kind).toBe('verification')
    expect(step.verification?.status).toBe('failed')
    expect(classifyTaskStep(step)).toBe('refuted')
  })
})
