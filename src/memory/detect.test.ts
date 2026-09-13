import { describe, expect, it } from 'vitest'
import {
  isMemorableInput,
  looksLikeCredential,
  detectMemoryType,
  isDurableFact,
  normalizeFact,
  classifyFact,
  isExplicitMemoryCommand,
  looksLikeQuestion,
  shouldAutoCapture,
  detectSource,
} from '../memory/detect'

describe('memory detection heuristics', () => {
  it('refuses empty or trivial input', () => {
    expect(isMemorableInput('')).toBe(false)
    expect(isMemorableInput('x')).toBe(false)
    expect(isMemorableInput('remember')).toBe(false)
    expect(isMemorableInput('remember that')).toBe(false)
  })

  it('accepts a real remember request', () => {
    expect(isMemorableInput('remember my favorite food is sushi')).toBe(true)
  })

  it('flags credentials so they never enter memory', () => {
    expect(looksLikeCredential('my password is hunter2')).toBe(true)
    expect(looksLikeCredential('sk-abcdefghijklmnopqrstuvwxyz1234567890')).toBe(true)
    expect(looksLikeCredential('handle: otto@example.com')).toBe(false)
  })

  it('classifies my-name statements as PROFILE', () => {
    expect(detectMemoryType('My name is Samantha')).toBe('PROFILE')
    expect(detectMemoryType('Call me Rex')).toBe('PROFILE')
  })

  it('classifies preferences as PREFERENCE', () => {
    expect(detectMemoryType('I prefer concise replies')).toBe('PREFERENCE')
    expect(detectMemoryType('my favorite color is teal')).toBe('PREFERENCE')
  })

  it('classifies working/living facts as FACT', () => {
    expect(detectMemoryType('I work at Acme')).toBe('FACT')
    expect(detectMemoryType('I live in Berlin')).toBe('FACT')
  })

  it('treats a bare remember as always durable', () => {
    expect(isDurableFact('remember my name is Jordan')).toBe(true)
  })

  it('rejects credential-looking durable facts', () => {
    expect(isDurableFact('remember my password is hunter2')).toBe(false)
  })

  it('normalizes "remember that" prefixes', () => {
    expect(normalizeFact('remember that I use Linux')).toBe('I use Linux')
    expect(normalizeFact('please remember I use Linux')).toBe('I use Linux')
  })

  it('classifyFact returns a typed draft with content', () => {
    const draft = classifyFact('remember my name is Aria')
    expect(draft.content).toBe('my name is Aria')
    expect(draft.type).toBe('PROFILE')
    expect(draft.importance).toBeGreaterThan(0.5)
  })
})

describe('detectSource — fact origin classification (Work 3)', () => {
  it('marks explicit memory commands as user-voiced', () => {
    expect(detectSource('remember my favorite color is teal')).toBe('user')
    // A vocative ("jarvis, …") is the user addressing JARVIS — still user-voiced.
    expect(detectSource('jarvis, remember my name is Aria')).toBe('user')
  })

  it('marks first-person personal statements as user-voiced', () => {
    expect(detectSource('My name is Aria')).toBe('user')
    expect(detectSource('I prefer concise replies')).toBe('user')
    expect(detectSource('I work at Acme on the platform team')).toBe('user')
    expect(detectSource('my favorite OS is Linux')).toBe('user')
  })

  it('marks third-person / derived phrasing as inferred (JARVIS-derived)', () => {
    expect(detectSource('prefers concise replies')).toBe('inferred')
    expect(detectSource('the user works at Acme')).toBe('inferred')
    expect(detectSource('jarvis recalled their preference for teal')).toBe('inferred')
  })

  it('defaults to inferred for detached summaries', () => {
    expect(detectSource('summary of today')).toBe('inferred')
    expect(detectSource('session notes')).toBe('inferred')
  })

  it('never fabricates system origin from free text', () => {
    expect(detectSource('this looks like it came from a process')).toBe('inferred')
  })

  it('classifyFact keeps the explicit source on the typed draft', () => {
    const draft = classifyFact('remember I use Linux')
    expect(draft.source).toBe('user')
  })
})

describe('auto-capture safety net (Phase 0.7)', () => {
  it('detects explicit memory commands', () => {
    expect(isExplicitMemoryCommand('remember my name is Jordan')).toBe(true)
    expect(isExplicitMemoryCommand('recall what I like')).toBe(true)
    expect(isExplicitMemoryCommand('forget that')).toBe(true)
    expect(isExplicitMemoryCommand('list my memories')).toBe(true)
    expect(isExplicitMemoryCommand('how are you today')).toBe(false)
  })

  it('detects obvious questions', () => {
    expect(looksLikeQuestion('do you like coffee?')).toBe(true)
    expect(looksLikeQuestion('what is my name')).toBe(true)
    expect(looksLikeQuestion('how does this work')).toBe(true)
    expect(looksLikeQuestion('I like coffee')).toBe(false)
  })

  it('would auto-capture a durable personal fact', () => {
    expect(shouldAutoCapture('I work at Acme on the platform team')).toBe(true)
    expect(shouldAutoCapture('my favorite color is teal')).toBe(true)
  })

  it('refuses to auto-capture commands, questions and credentials', () => {
    expect(shouldAutoCapture('remember my name is Jordan')).toBe(false)
    expect(shouldAutoCapture('what is your name')).toBe(false)
    expect(shouldAutoCapture('do you like coffee')).toBe(false)
    expect(shouldAutoCapture('my password is hunter2')).toBe(false)
  })
})