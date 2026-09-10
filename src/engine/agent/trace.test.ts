import { describe, expect, it } from 'vitest'
import { ExecutionTracer } from './trace'
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
})