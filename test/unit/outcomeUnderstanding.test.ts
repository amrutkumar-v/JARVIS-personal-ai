import { describe, it, expect } from 'vitest'
import { UniversalIntentRouter } from '../../src/engine/orchestrator/UniversalIntentRouter'

describe('Phase 1 — Universal Intelligence: Structured Outcome Understanding', () => {
  const router = new UniversalIntentRouter()

  it('1. Analyzes autonomous software development outcome with verification requirements and constraints', () => {
    const prompt = 'Inspect D:\\Project, create a Python circle area program, run tests, and generate a completion report.'
    const route = router.classify(prompt)

    expect(route.strategy).toBe('AUTONOMOUS_DEV')
    expect(route.outcomeUnderstanding).toBeDefined()
    const outcome = route.outcomeUnderstanding!

    expect(outcome.executionMode).toBe('CODE_EXECUTION')
    expect(outcome.requiresDurableTask).toBe(true)
    expect(outcome.desiredOutcome).toContain('passing tests')
    expect(outcome.constraints.some((c) => c.includes('workspace'))).toBe(true)
    expect(outcome.verificationRequirements.some((v) => v.includes('exit code 0'))).toBe(true)
    expect(outcome.relevantContext.targetPath).toBe('D:\\Project')
  })

  it('2. Analyzes data analysis outcome with schema validation and chart generation constraints', () => {
    const prompt = 'Analyze this dataset, calculate average, detect trend, and plot a chart'
    const route = router.classify(prompt)

    expect(route.strategy).toBe('DATA_ANALYSIS')
    const outcome = route.outcomeUnderstanding!

    expect(outcome.executionMode).toBe('DATA_ANALYSIS')
    expect(outcome.desiredOutcome).toContain('statistical summary')
    expect(outcome.constraints.some((c) => c.includes('Do not invent'))).toBe(true)
    expect(outcome.verificationRequirements.some((v) => v.includes('calculations'))).toBe(true)
  })

  it('3. Analyzes browser workflow outcome with URL extraction and SSRF security constraints', () => {
    const prompt = 'Open the browser, navigate to https://playwright.dev and extract the docs overview'
    const route = router.classify(prompt)

    expect(route.strategy).toBe('BROWSER_WORKFLOW')
    const outcome = route.outcomeUnderstanding!

    expect(outcome.executionMode).toBe('BROWSER_INTERACTION')
    expect(outcome.requiresDurableTask).toBe(true)
    expect(outcome.relevantContext.targetUrl).toBe('https://playwright.dev')
    expect(outcome.constraints.some((c) => c.includes('SSRF protection'))).toBe(true)
    expect(outcome.potentialRisks.some((r) => r.includes('SSRF'))).toBe(true)
  })

  it('4. Analyzes compound multi-domain workflow (research + report + presentation)', () => {
    const prompt = 'Research the latest developments in AI agents, compare major approaches, prepare a report and create a presentation outline.'
    const route = router.classify(prompt)

    const outcome = route.outcomeUnderstanding!
    expect(outcome.executionMode).toBe('MULTIPLE_COMBINED')
    expect(outcome.requiresDurableTask).toBe(true)
    expect(outcome.desiredOutcome).toContain('multi-step workflow')
    expect(outcome.constraints.some((c) => c.includes('Durable task'))).toBe(true)
  })

  it('5. Identifies deictic ambiguity and provides targeted clarification question', () => {
    const prompt = 'Please delete it'
    const route = router.classify(prompt)

    expect(route.strategy).toBe('CLARIFICATION_REQUIRED')
    const outcome = route.outcomeUnderstanding!
    expect(outcome.clarificationNeeded).toBeDefined()
    expect(outcome.clarificationNeeded).toContain('Which specific file')
  })

  it('6. Honestly reports blocked capability limitation for live microphone input', () => {
    const prompt = 'Listen to me through the microphone and transcribe my voice'
    const route = router.classify(prompt)

    const outcome = route.outcomeUnderstanding!
    expect(outcome.limitationExplanation).toBeDefined()
    expect(outcome.limitationExplanation).toContain('Live microphone audio hardware input is currently blocked')
  })

  it('7. Understands mathematical calculation as local reasoning without durable task overhead', () => {
    const prompt = 'Calculate 125 * 48'
    const route = router.classify(prompt)

    expect(route.strategy).toBe('DIRECT_ANSWER')
    const outcome = route.outcomeUnderstanding!
    expect(outcome.executionMode).toBe('LOCAL_REASONING')
    expect(outcome.requiresDurableTask).toBe(false)
    expect(outcome.desiredOutcome).toContain('mathematical')
  })

  it('8. Understands chitchat as direct conversational response', () => {
    const prompt = 'Hello JARVIS'
    const route = router.classify(prompt)

    expect(route.strategy).toBe('DIRECT_ANSWER')
    const outcome = route.outcomeUnderstanding!
    expect(outcome.executionMode).toBe('DIRECT_ANSWER')
    expect(outcome.requiresDurableTask).toBe(false)
  })

  it('9. Direct call to understandOutcome returns the OutcomeUnderstanding model', () => {
    const outcome = router.understandOutcome('Research WebAssembly benchmarks across modern engines')
    expect(outcome.userObjective).toContain('WebAssembly')
    expect(outcome.desiredOutcome).toContain('research report')
    expect(outcome.executionMode).toBe('WEB_RESEARCH')
  })
})
