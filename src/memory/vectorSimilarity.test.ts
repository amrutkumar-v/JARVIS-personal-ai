import { describe, expect, it } from 'vitest'
import { cosineSimilarity, normalizeSimilarity, findMostSimilar } from '../memory/vectorSimilarity'

describe('Vector Similarity (cosine)', () => {
  it('identical vectors return 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10)
  })

  it('orthogonal vectors return 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10)
  })

  it('opposite vectors return -1', () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 10)
  })

  it('zero vectors return 0', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0)
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0)
  })

  it('dimension mismatch returns 0', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
    expect(cosineSimilarity([1], [1, 2])).toBe(0)
  })

  it('empty vectors return 0', () => {
    expect(cosineSimilarity([], [1, 2])).toBe(0)
    expect(cosineSimilarity([1, 2], [])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
  })

  it('NaN components are treated as 0', () => {
    expect(cosineSimilarity([NaN, 1], [1, 1])).toBeCloseTo(0.707, 2)
    expect(cosineSimilarity([1, NaN], [1, 1])).toBeCloseTo(0.707, 2)
  })

  it('Infinity components are treated as 0, resulting in reduced similarity', () => {
    // Infinity is treated as 0, so [Infinity, 1] becomes [0, 1]
    // cosine similarity of [0, 1] and [1, 1] = 1/sqrt(2) ≈ 0.707
    expect(cosineSimilarity([Infinity, 1], [1, 1])).toBeCloseTo(0.707, 2)
    expect(cosineSimilarity([1, -Infinity], [1, 1])).toBeCloseTo(0.707, 2)
  })
})

describe('normalizeSimilarity', () => {
  it('maps -1 to 0', () => {
    expect(normalizeSimilarity(-1)).toBe(0)
  })

  it('maps 0 to 0.5', () => {
    expect(normalizeSimilarity(0)).toBe(0.5)
  })

  it('maps 1 to 1', () => {
    expect(normalizeSimilarity(1)).toBe(1)
  })

  it('maps 0.5 to 0.75', () => {
    expect(normalizeSimilarity(0.5)).toBe(0.75)
  })
})

describe('findMostSimilar', () => {
  it('finds the most similar vector', () => {
    const query = [1, 0, 0]
    const candidates = [
      [1, 0, 0], // identical
      [0, 1, 0], // orthogonal
      [-1, 0, 0], // opposite
    ]
    const result = findMostSimilar(query, candidates)
    expect(result.index).toBe(0)
    expect(result.similarity).toBeCloseTo(1, 10)
  })

  it('returns -1 for empty candidates', () => {
    const result = findMostSimilar([1, 0], [])
    expect(result.index).toBe(-1)
    expect(result.similarity).toBe(-1)
  })

  it('handles dimension mismatch in candidates', () => {
    const query = [1, 0]
    const candidates = [
      [1, 0, 0], // mismatch - should be skipped
      [0, 1], // valid but orthogonal
    ]
    const result = findMostSimilar(query, candidates)
    expect(result.index).toBe(1)
    expect(result.similarity).toBeCloseTo(0, 5)
  })
})