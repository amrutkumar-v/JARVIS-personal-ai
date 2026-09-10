import { describe, expect, it } from 'vitest'
import { findExpectedElement, verifyVisualTransition } from './verification'
import type { VisualElement } from './types'

function element(id: string, label: string): VisualElement {
  return { id, label, type: 'button', bounds: { x: 0, y: 0, width: 10, height: 10 }, confidence: 1 }
}

describe('findExpectedElement', () => {
  const after = [
    element('error', 'Error installing'),
    element('saved', 'Settings saved'),
    element('submit', 'Submit'),
  ]

  it('finds the expected element after a transition', () => {
    expect(findExpectedElement('Settings saved', after)).toBe(after[1])
  })

  it('returns undefined when the expected label is absent', () => {
    expect(findExpectedElement('Success', after)).toBeUndefined()
  })

  it('returns undefined for a blank query', () => {
    expect(findExpectedElement('', after)).toBeUndefined()
  })
})

describe('verifyVisualTransition', () => {
  it('verifies when expected_after is present AFTER the action', () => {
    const outcome = verifyVisualTransition({ expectedAfter: 'Settings saved', elements: [element('saved', 'Settings saved')] })
    expect(outcome.verdict).toBe('verified')
    expect(outcome.message).toContain('Settings saved')
  })

  it('refutes when expected_after is expected but not found', () => {
    const outcome = verifyVisualTransition({ expectedAfter: 'Success', elements: [element('error', 'Error installing')] })
    expect(outcome.verdict).toBe('refuted')
    expect(outcome.message).toContain('Refuted')
  })

  it('is unverified when no expected_after was requested', () => {
    const outcome = verifyVisualTransition({ expectedAfter: '', elements: [] })
    expect(outcome.verdict).toBe('unverified')
    expect(outcome.message).toContain('not confirmed')
  })

  it('verified block needs no text dump — only element metadata', () => {
    const outcome = verifyVisualTransition({ expectedAfter: 'Saved', elements: [element('saved', 'Saved')] })
    const json = JSON.stringify(outcome)
    expect(json).not.toContain('base64')
    expect(outcome).not.toHaveProperty('text')
  })
})