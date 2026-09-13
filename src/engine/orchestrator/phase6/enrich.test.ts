import { describe, it, expect } from 'vitest'
import {
  buildPhase6PlanMeta,
  buildPhase6StepMeta,
  applyResolutionToStepMeta,
} from './enrich'

describe('Phase 6 — plan enrichment', () => {
  it('builds deterministic goal metadata for the same goal', () => {
    const a = buildPhase6PlanMeta({ goal: 'open notepad', requestClass: 'multi_step_goal', stepCount: 2, hasDependencies: true })
    const b = buildPhase6PlanMeta({ goal: 'open notepad', requestClass: 'multi_step_goal', stepCount: 2, hasDependencies: true })
    expect(a.planId).toBe(b.planId)
    expect(a.planId).toMatch(/^plan-/)
    expect(a.intent).toContain('multi-step')
    expect(a.assumptions).toEqual(
      expect.arrayContaining(['permissions, budgets and timeouts are never bypassed']),
    )
    expect(a.constraints.join(' ')).toContain('at most 2 plan steps')
    expect(b.planId).not.toBe(buildPhase6PlanMeta({ goal: 'close notepad', requestClass: 'multi_step_goal', stepCount: 2, hasDependencies: true }).planId)
  })

  it('attaches a depends_on_success precondition mirroring dependsOn', () => {
    const meta = buildPhase6StepMeta({
      capability: 'type_text',
      description: 'Type text.',
      dependsOn: [0],
      stepCount: 2,
      hasDependents: false,
    })
    expect(meta.precondition).toEqual({ kind: 'depends_on_success', sources: [0] })
    expect(meta.verification).toBe('tool_owned_then_post_action')
    expect(meta.failurePolicy).toBe('replan')
  })

  it('drops precondition source indices outside the plan', () => {
    const meta = buildPhase6StepMeta({
      capability: 'x',
      description: 'x',
      dependsOn: [0, 9],
      stepCount: 2,
      hasDependents: false,
    })
    expect(meta.precondition?.sources).toEqual([0])
  })

  it('applies the real resolved risk and retry policy after preflight', () => {
    const base = buildPhase6StepMeta({
      capability: 'open_application',
      description: 'Launch notepad.',
      stepCount: 1,
      hasDependents: false,
    })
    const merged = applyResolutionToStepMeta(base, {
      risk: 'high',
      verifiable: true,
      retry: { retryable: true, maxRetries: 2, backoffMs: 200 },
    })
    expect(merged.risk).toBe('high')
    expect(merged.verification).toBe('tool_owned_then_post_action')
    expect(merged.retryPolicy).toEqual({ retryable: true, maxRetries: 2, backoffMs: 200 })
  })

  it('downgrades verification policy to post_action for non-verifiable tools', () => {
    const base = buildPhase6StepMeta({
      capability: 'type_text',
      description: 'Type text.',
      stepCount: 1,
      hasDependents: false,
    })
    const merged = applyResolutionToStepMeta(base, { verifiable: false })
    expect(merged.verification).toBe('post_action')
    expect(merged.risk).toBe('low')
  })
})