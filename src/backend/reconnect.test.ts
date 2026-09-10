import { describe, expect, it } from 'vitest'
import { ReconnectController } from './reconnect'
import type { ReconnectPhase } from './reconnect'

describe('ReconnectController', () => {
  it('starts idle and moves to connected on markConnected', () => {
    const phases: ReconnectPhase[] = []
    const rc = new ReconnectController({ maxAttempts: 3, baseMs: 100 }, (p) => phases.push(p))
    expect(rc.phase).toBe('idle')
    rc.markConnected()
    expect(rc.phase).toBe('connected')
    expect(rc.attempts).toBe(0)
    expect(phases).toEqual(['connected'])
  })

  it('applies bounded exponential backoff per attempt', () => {
    const rc = new ReconnectController({ maxAttempts: 9, baseMs: 100 })
    expect(rc.nextDelay()).toBe(100)
    expect(rc.nextDelay()).toBe(200)
    expect(rc.nextDelay()).toBe(400)
    expect(rc.nextDelay()).toBe(800)
    expect(rc.nextDelay()).toBe(1600)
  })

  it('never grows a delay past the configured ceiling', () => {
    const rc = new ReconnectController({ maxAttempts: 9, baseMs: 5000, maxDelayMs: 15_000 })
    expect(rc.nextDelay()).toBe(5000)
    expect(rc.nextDelay()).toBe(10_000)
    expect(rc.nextDelay()).toBe(15_000)
    expect(rc.nextDelay()).toBe(15_000)
  })

  it('reports giving up once attempts exceed the limit, inside a reconnect window', () => {
    const rc = new ReconnectController({ maxAttempts: 2, baseMs: 10 })
    rc.markConnected() // reset the attempt counter — connection was live
    expect(rc.nextDelay()).toBe(10)
    expect(rc.nextDelay()).toBe(20)
    expect(rc.nextDelay()).toBe(-1)
    expect(rc.phase).toBe('giving_up')
  })

  it('a fresh connection resets the attempt counter', () => {
    const rc = new ReconnectController({ maxAttempts: 1, baseMs: 10 })
    rc.nextDelay()
    rc.markConnected()
    expect(rc.attempts).toBe(0)
    expect(rc.nextDelay()).toBe(10)
    expect(rc.phase).toBe('waiting')
    expect(rc.attempts).toBe(1)
  })

  it('reset returns to idle', () => {
    const rc = new ReconnectController({ maxAttempts: 1, baseMs: 10 })
    rc.nextDelay()
    rc.reset()
    expect(rc.phase).toBe('idle')
    expect(rc.attempts).toBe(0)
  })
})