import { describe, expect, it } from 'vitest'
import {
  MAX_RELIABILITY_COUNTER,
  recordReliability,
  reliabilityKey,
  reliabilityScore,
} from './reliability'
import type { CapabilityReliabilityIndex } from './types'

/**
 * Phase 2.4 — bounded, content-free reliability history (PURE).
 * Immutable updates, clamped counters, deterministic weak score.
 */

describe('Phase 2.4 — capability reliability history (pure)', () => {
  it('updates immutably: the input index is never mutated', () => {
    const before: CapabilityReliabilityIndex = new Map()
    const after = recordReliability(before, 'open_application', 'app.launch', 'success')
    expect(before.size).toBe(0)
    expect(after.size).toBe(1)
    const record = after.get(reliabilityKey('open_application', 'app.launch'))
    expect(record?.successes).toBe(1)
    expect(record?.verifiedSuccesses).toBe(0)
    expect(record?.failures).toBe(0)
    expect(record?.lastOutcome).toBe('success')
  })

  it('accumulates per outcome and updates lastOutcome', () => {
    let index: CapabilityReliabilityIndex = new Map()
    index = recordReliability(index, 'click_at', 'desktop.click', 'verified_success')
    index = recordReliability(index, 'click_at', 'desktop.click', 'failure')
    index = recordReliability(index, 'click_at', 'desktop.click', 'success')
    const record = index.get(reliabilityKey('click_at', 'desktop.click'))
    expect(record?.verifiedSuccesses).toBe(1)
    expect(record?.successes).toBe(1)
    expect(record?.failures).toBe(1)
    expect(record?.lastOutcome).toBe('success')
  })

  it('keeps (capability, tool) pairs independent', () => {
    let index: CapabilityReliabilityIndex = new Map()
    index = recordReliability(index, 'click_at', 'desktop.click', 'verified_success')
    index = recordReliability(index, 'click_at', 'desktop.right_click', 'failure')
    index = recordReliability(index, 'type_text', 'desktop.type', 'success')
    expect(index.size).toBe(3)
  })

  it('clamps counters at the fixed ceiling', () => {
    const record = {
      capabilityId: 'click_at',
      toolId: 'desktop.click',
      verifiedSuccesses: MAX_RELIABILITY_COUNTER,
      successes: 0,
      failures: 0,
      lastOutcome: 'verified_success' as const,
    }
    const index: CapabilityReliabilityIndex = new Map([[reliabilityKey('click_at', 'desktop.click'), record]])
    const after = recordReliability(index, 'click_at', 'desktop.click', 'verified_success')
    expect(after.get(reliabilityKey('click_at', 'desktop.click'))?.verifiedSuccesses).toBe(MAX_RELIABILITY_COUNTER)
  })

  it('scores indifference (0.5) when no history exists', () => {
    expect(reliabilityScore(new Map(), 'click_at', 'desktop.click')).toBe(0.5)
  })

  it('scores a plain success above indifference and a failure below it', () => {
    let index: CapabilityReliabilityIndex = new Map()
    index = recordReliability(index, 'click_at', 'desktop.click', 'success')
    expect(reliabilityScore(index, 'click_at', 'desktop.click')).toBeCloseTo(0.75)
    index = recordReliability(index, 'click_at', 'desktop.right_click', 'failure')
    expect(reliabilityScore(index, 'click_at', 'desktop.right_click')).toBeCloseTo(0.25)
  })

  it('weights verified successes more strongly than plain successes', () => {
    let index: CapabilityReliabilityIndex = new Map()
    index = recordReliability(index, 'click_at', 'desktop.click', 'verified_success')
    const verified = reliabilityScore(index, 'click_at', 'desktop.click')
    index = recordReliability(index, 'click_at', 'desktop.right_click', 'success')
    const plain = reliabilityScore(index, 'click_at', 'desktop.right_click')
    expect(verified).toBeGreaterThan(plain)
    expect(verified).toBe(1)
  })

  it('is content-free: the store holds only ids and counts', () => {
    let index: CapabilityReliabilityIndex = new Map()
    index = recordReliability(index, 'send_message', 'messenger.send', 'verified_success')
    const keys = [...index.keys()]
    expect(keys).toEqual([reliabilityKey('send_message', 'messenger.send')])
    const values = [...index.values()]
    expect(Object.keys(values[0]).sort()).toEqual([
      'capabilityId',
      'failures',
      'lastOutcome',
      'successes',
      'toolId',
      'verifiedSuccesses',
    ])
  })
})