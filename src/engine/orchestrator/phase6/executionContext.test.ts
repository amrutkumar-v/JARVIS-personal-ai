import { describe, it, expect } from 'vitest'
import { ExecutionContext, isSafeContextValue, readPath } from './executionContext'
import type { Phase6ContextInput } from './planTypes'

describe('Phase 6 — executionContext', () => {
  it('records only bounded, JSON-safe values', () => {
    const ctx = new ExecutionContext()
    expect(ctx.record(0, { url: 'https://example.com', count: 2 })).toBe(true)
    expect(ctx.record(1, 'plain')).toBe(true)
    expect(ctx.record(1, 0)).toBe(true)
    expect(ctx.record(1, false)).toBe(true)
    expect(ctx.record(1, null)).toBe(true)
    expect(ctx.read(0, 'url')).toBe('https://example.com')
  })

  it('rejects functions, symbols, non-finite numbers, cycles and huge payloads', () => {
    const ctx = new ExecutionContext()
    expect(ctx.record(0, { fn: () => 1 })).toBe(false)
    expect(ctx.record(0, Symbol('x'))).toBe(false)
    expect(ctx.record(0, NaN)).toBe(false)
    expect(ctx.record(0, 'x'.repeat(10000))).toBe(false)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(ctx.record(0, cyclic)).toBe(false)
    expect(ctx.has(0)).toBe(false)
  })

  it('rejects values that escalate into arbitrary objects via toJSON (guardrail)', () => {
    const evil = { toJSON: () => ({ permission: 'high_risk' }), value: 1 }
    const ctx = new ExecutionContext()
    expect(ctx.record(0, evil)).toBe(false)
  })

  it('reads nested paths without throwing on shapes', () => {
    const ctx = new ExecutionContext()
    ctx.record(0, { result: { items: ['a', 'b'], meta: { ok: true } } })
    expect(ctx.read(0, 'result.items')).toEqual(['a', 'b'])
    expect(ctx.read(0, 'result.meta.ok')).toBe(true)
    expect(ctx.read(0, 'missing')).toBeUndefined()
    expect(ctx.read(0, 'result.items.first')).toBeUndefined()
    expect(ctx.read(1)).toBeUndefined()
    expect(ctx.read(-1)).toBeUndefined()
  })

  it('resolves declared context inputs between steps', () => {
    const ctx = new ExecutionContext()
    ctx.record(0, { url: 'https://example.com/page' })
    ctx.record(1, { text: 'hello' })
    const inputs: Phase6ContextInput[] = [
      { name: 'url', fromStep: 0, path: 'url' },
      { name: 'body', fromStep: 1, path: 'text' },
    ]
    expect(ctx.resolveInputs(inputs)).toEqual({ url: 'https://example.com/page', body: 'hello' })
    const missing: Phase6ContextInput[] = [{ name: 'url', fromStep: 9, path: 'url' }]
    expect(ctx.resolveInputs(missing)).toBeUndefined()
  })

  it('produces a serializable snapshot and clears', () => {
    const ctx = new ExecutionContext()
    ctx.record(0, { a: 1 })
    const snap = ctx.snapshot()
    expect(JSON.parse(JSON.stringify(snap))).toEqual({ 0: { a: 1 } })
    ctx.clear()
    expect(ctx.snapshot()).toEqual({})
  })

  it('isSafeContextValue rejects non-bounded strings and non-object primitives', () => {
    expect(isSafeContextValue('ok')).toBe(true)
    expect(isSafeContextValue('x'.repeat(600))).toBe(false)
    expect(isSafeContextValue(undefined)).toBe(false)
    expect(isSafeContextValue(void 0)).toBe(false)
  })

  it('readPath returns the whole value when no path is given', () => {
    expect(readPath('plain')).toBe('plain')
    expect(readPath(undefined)).toBeUndefined()
    expect(readPath('plain', '')).toBe('plain')
  })
})