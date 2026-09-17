import { describe, expect, it } from 'vitest'
import {
  SYNTHESIS_LIMITS,
  buildSynthesisFacts,
  buildSynthesisMessages,
  composeFinalAnswer,
  hasSynthesizableFacts,
  normalizeSynthesisText,
  synthesisUpgradesVerdict,
} from './answerSynthesis'
import type { OrchestrationExecutionResult } from './execution'
import type { AgentTrace } from '../agent/types'

function result(over: Partial<OrchestrationExecutionResult> = {}): OrchestrationExecutionResult {
  return {
    status: 'completed',
    goal: 'Open Chrome and search for the latest NVIDIA driver version',
    requestClass: 'multi_step_goal',
    plan: [
      { id: 'step-1', capability: 'open_application', description: 'Launch Chrome.', payload: { application_id: 'chrome' } },
      { id: 'step-2', capability: 'web_search', description: 'Search the web.', payload: { query: 'the latest NVIDIA driver version' } },
    ],
    steps: [
      {
        capability: 'open_application',
        toolId: 'app.launch',
        status: 'success',
        verified: true,
        observation: { kind: 'success', summary: 'Launched "Chrome" (chrome).' },
      },
      {
        capability: 'web_search',
        toolId: 'web.search',
        status: 'success',
        verified: false,
        observation: { kind: 'info', summary: 'Found 1 result(s) for "the latest NVIDIA driver version": 616.92 WHQL.' },
      },
    ],
    completedSteps: 2,
    failedSteps: 0,
    skippedSteps: 0,
    verifiedSteps: 1,
    unverifiedSteps: 1,
    observations: [],
    verification: [],
    targetDevices: [],
    finishedAt: Date.now(),
    ...over,
  }
}

const TRACE: AgentTrace = {
  goal: 'Open Chrome and search for the latest NVIDIA driver version',
  steps: [
    {
      toolId: 'app.launch',
      action: 'Launch application',
      arguments: { application_id: 'chrome' },
      status: 'success',
      verification: { status: 'verified', message: 'Confirmed "Chrome" is running.', durationMs: 12 },
    },
    {
      toolId: 'web.search',
      action: 'Search the web',
      arguments: { query: 'the latest NVIDIA driver version' },
      status: 'success',
    },
  ],
  finalState: 'completed',
}

describe('buildSynthesisFacts', () => {
  it('carries the real arguments, observations and verification state', () => {
    const facts = buildSynthesisFacts(result(), TRACE)
    expect(facts.goal).toBe('Open Chrome and search for the latest NVIDIA driver version')
    expect(facts.steps).toHaveLength(2)
    expect(facts.steps[0]).toMatchObject({
      index: 1,
      capability: 'open_application',
      toolId: 'app.launch',
      arguments: { application_id: 'chrome' },
      outcome: 'success',
      verified: 'verified',
      verificationMessage: 'Confirmed "Chrome" is running.',
    })
    expect(facts.steps[1]).toMatchObject({
      index: 2,
      capability: 'web_search',
      toolId: 'web.search',
      arguments: { query: 'the latest NVIDIA driver version' },
      verified: 'unverified',
    })
    expect(facts.steps[1]?.observation?.summary).toContain('616.92 WHQL')
    expect(facts.counts).toEqual({ executed: 2, verified: 1, failed: 0, skipped: 0 })
    expect(facts.fullyVerified).toBe(false)
  })

  it('marks a fully verified run as such', () => {
    const single = result({
      goal: 'Open Notepad.',
      plan: [{ id: 'step-1', capability: 'open_application', description: 'Launch.', payload: { application_id: 'notepad' } }],
      steps: [
        {
          capability: 'open_application',
          toolId: 'app.launch',
          status: 'success',
          verified: true,
          observation: { kind: 'success', summary: 'Launched "Notepad".' },
        },
      ],
    })
    expect(buildSynthesisFacts(single, TRACE).fullyVerified).toBe(true)
  })

  it('exposes what is worth narrating, and refuses when nothing ran', () => {
    expect(hasSynthesizableFacts(buildSynthesisFacts(result(), TRACE))).toBe(true)
    const nothing = result({ plan: [], steps: [], status: 'blocked', reason: 'Plan validation rejected.' })
    expect(hasSynthesizableFacts(buildSynthesisFacts(nothing, { goal: '', steps: [] }))).toBe(false)
  })

  it('keeps a real finding that sits deep in a long tool summary (live regression)', () => {
    // A web-search summary carries its results IN ORDER: the answer-bearing
    // result is often far past the start (the live driver version sat at char
    // 1030). The record must keep everything the engine showed the model.
    const filler = '- Result '.padEnd(160, '.')
    const summary = `${filler.repeat(6)} 616.92 WHQL is the latest driver.`
    const facts = buildSynthesisFacts(
      result({
        steps: [
          {
            capability: 'web_search',
            toolId: 'web.search',
            status: 'success',
            verified: false,
            observation: { kind: 'info', summary },
          },
        ],
      }),
      { goal: '', steps: [] },
    )
    expect(facts.steps[0]!.observation!.summary).toContain('616.92 WHQL')
    expect(SYNTHESIS_LIMITS.maxObservationChars).toBeGreaterThanOrEqual(summary.length)
  })

  it('bounds every embedded text field', () => {
    const huge = result({
      steps: [
        {
          capability: 'web_search',
          toolId: 'web.search',
          status: 'success',
          verified: false,
          observation: { kind: 'info', summary: 'x'.repeat(SYNTHESIS_LIMITS.maxObservationChars * 3) },
        },
      ],
    })
    const facts = buildSynthesisFacts(huge, { goal: '', steps: [] })
    expect(facts.steps[0]!.observation!.summary.length).toBeLessThanOrEqual(SYNTHESIS_LIMITS.maxObservationChars)
  })
})

describe('buildSynthesisMessages', () => {
  it('hands the model the record and forbids inventing facts', () => {
    const messages = buildSynthesisMessages(buildSynthesisFacts(result(), TRACE))
    expect(messages).toHaveLength(2)
    const system = messages[0]!
    expect(system.role).toBe('system')
    expect(system.content).toContain('Use ONLY facts present in the record')
    expect(system.content).toContain('must not be described as done')
    const user = messages[1]!
    expect(user.content).toContain('EXECUTION RECORD')
    expect(user.content).toContain('616.92 WHQL')
    expect(user.content).toContain('the latest NVIDIA driver version')
  })
})

describe('synthesisUpgradesVerdict — the honesty gate', () => {
  const partial = buildSynthesisFacts(result(), TRACE)
  const complete = buildSynthesisFacts(
    result({
      plan: [{ id: 'step-1', capability: 'open_application', description: 'Launch.', payload: {} }],
      steps: [
        {
          capability: 'open_application',
          toolId: 'app.launch',
          status: 'success',
          verified: true,
          observation: { kind: 'success', summary: 'Launched "Notepad".' },
        },
      ],
    }),
    TRACE,
  )

  it('rejects completion claims on a run that is not fully verified', () => {
    expect(synthesisUpgradesVerdict(partial, 'All steps verified and everything is complete.')).toBe(true)
    expect(synthesisUpgradesVerdict(partial, 'The task was completed successfully.')).toBe(true)
    expect(synthesisUpgradesVerdict(partial, 'Both steps ran without problems.')).toBe(true)
  })

  it('allows a grounded summary of a partial run', () => {
    expect(
      synthesisUpgradesVerdict(partial, 'Chrome is open; the search returned NVIDIA driver 616.92 WHQL.'),
    ).toBe(false)
    expect(synthesisUpgradesVerdict(partial, 'Chrome launched, but the search result could not be confirmed.')).toBe(false)
  })

  it('does not restrict a fully verified run', () => {
    expect(synthesisUpgradesVerdict(complete, 'Notepad is now open.')).toBe(false)
    expect(synthesisUpgradesVerdict(complete, 'Done: the application launched successfully.')).toBe(false)
  })
})

describe('normalizeSynthesisText / composeFinalAnswer', () => {
  it('rejects empty and non-string output', () => {
    expect(normalizeSynthesisText(undefined)).toBeNull()
    expect(normalizeSynthesisText('   ')).toBeNull()
  })

  it('strips fences, quotes and collapses whitespace', () => {
    expect(normalizeSynthesisText('```text\n  The   driver is 616.92.\n```')).toBe('The driver is 616.92.')
    expect(normalizeSynthesisText('"Chrome is open."')).toBe('Chrome is open.')
  })

  it('bounds the prose length', () => {
    const long = normalizeSynthesisText('a'.repeat(SYNTHESIS_LIMITS.maxChars * 2))!
    expect(long).toHaveLength(SYNTHESIS_LIMITS.maxChars)
  })

  it('always keeps the deterministic evidence line', () => {
    expect(composeFinalAnswer('Prose.', 'Done. — all 1 step completed and verified.')).toBe(
      'Prose.\nDone. — all 1 step completed and verified.',
    )
    expect(composeFinalAnswer(null, 'Partially done. 1 of 2 steps verified.')).toBe(
      'Partially done. 1 of 2 steps verified.',
    )
    expect(composeFinalAnswer('   ', 'Evidence.')).toBe('Evidence.')
  })
})
