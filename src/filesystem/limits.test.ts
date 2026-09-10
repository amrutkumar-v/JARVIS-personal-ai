import { describe, expect, it } from 'vitest'
import { FS_LIMITS, boundedDepth, boundedLimit, clampedLength } from './limits'

describe('boundedLimit', () => {
  it('clamps caller limits into 1..cap, never unlimited', () => {
    expect(boundedLimit(5, 10)).toBe(5)
    expect(boundedLimit(50, 10)).toBe(10)
    expect(boundedLimit(undefined, 10)).toBe(10)
    expect(boundedLimit('abc', 10)).toBe(10)
    expect(boundedLimit(-3, 10)).toBe(10)
    expect(boundedLimit(0, 10)).toBe(10)
    expect(boundedLimit(2.9, 10)).toBe(2)
  })
})

describe('boundedDepth', () => {
  it('clamps depth to 0..cap with the fallback for absent/invalid', () => {
    expect(boundedDepth(2, 4, 4)).toBe(2)
    expect(boundedDepth(9, 4, 4)).toBe(4)
    expect(boundedDepth(undefined, 4, 4)).toBe(4)
    expect(boundedDepth(NaN, 4, 4)).toBe(4)
    expect(boundedDepth(0, 4, 4)).toBe(0)
  })
})

describe('clampedLength', () => {
  it('flags content above the cap', () => {
    expect(clampedLength('abc', 3)).toBe(true)
    expect(clampedLength('abcd', 3)).toBe(false)
  })
})

describe('FS_LIMITS sanity', () => {
  it('keeps every bound finite and positive', () => {
    expect(FS_LIMITS.MAX_LIST_RESULTS).toBeGreaterThan(0)
    expect(FS_LIMITS.MAX_SEARCH_RESULTS).toBeLessThanOrEqual(FS_LIMITS.MAX_LIST_RESULTS)
    expect(FS_LIMITS.MAX_READ_BYTES).toBeGreaterThan(0)
    expect(FS_LIMITS.MAX_WRITE_CHARS).toBeGreaterThan(0)
    expect(FS_LIMITS.MAX_COPY_BYTES).toBeGreaterThanOrEqual(FS_LIMITS.MAX_READ_BYTES)
    expect(FS_LIMITS.MAX_SEARCH_DEPTH).toBeGreaterThan(0)
  })
})