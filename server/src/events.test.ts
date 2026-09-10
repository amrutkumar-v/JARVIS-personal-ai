import { describe, expect, it, vi } from 'vitest'
import { EventBus } from './events.js'
import type { SseClient } from './events.js'

describe('EventBus', () => {
  it('fans an event out to every client', () => {
    const bus = new EventBus()
    const received: string[] = []
    const a: SseClient = { id: 'a', send: (type) => received.push(type) }
    const b: SseClient = { id: 'b', send: (type) => received.push(type) }
    bus.subscribe(a)
    bus.subscribe(b)
    bus.publish({ type: 'notify', at: 1, data: { title: 'T' } })
    expect(received).toEqual(['notify', 'notify'])
    expect(bus.clientCount()).toBe(2)
  })

  it('stops delivering to unsubscribed clients', () => {
    const bus = new EventBus()
    const received: string[] = []
    const a: SseClient = { id: 'a', send: (type) => received.push(type) }
    const unsubscribe = bus.subscribe(a)
    unsubscribe()
    bus.publish({ type: 'device', at: 1, data: {} })
    expect(received).toEqual([])
  })

  it('a throwing client does not break fan-out', () => {
    const bus = new EventBus()
    const received: string[] = []
    const bad: SseClient = {
      id: 'bad',
      send: () => {
        throw new Error('boom')
      },
    }
    const good: SseClient = { id: 'good', send: (type) => received.push(type) }
    bus.subscribe(bad)
    bus.subscribe(good)
    expect(() => bus.publish({ type: 'inbound', at: 1, data: { text: 'x' } })).not.toThrow()
    expect(received).toEqual(['inbound'])
    void vi
  })
})