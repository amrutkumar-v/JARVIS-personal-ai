/**
 * Vector Similarity Utilities — Phase 0.6A
 *
 * Pure, deterministic cosine similarity with robust edge-case handling.
 * Never returns NaN. Safe for zero vectors and dimension mismatches.
 */

export type VectorLike = readonly number[] | Float32Array

/**
 * Compute cosine similarity between two vectors.
 *
 * Returns a value in [-1, 1]:
 * - 1: identical direction (perfect similarity)
 * - 0: orthogonal (no similarity)
 * - -1: opposite direction
 *
 * Edge cases:
 * - Zero vectors: returns 0 (no defined direction)
 * - Dimension mismatch: returns 0 (cannot compare)
 * - NaN components: treated as 0
 */
export function cosineSimilarity(a: VectorLike, b: VectorLike): number {
  const lenA = a.length
  const lenB = b.length

  if (lenA === 0 || lenB === 0 || lenA !== lenB) {
    return 0
  }

  let dot = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < lenA; i++) {
    const av = Number.isFinite(a[i]) ? a[i] : 0
    const bv = Number.isFinite(b[i]) ? b[i] : 0
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }

  const norm = Math.sqrt(normA) * Math.sqrt(normB)
  if (norm === 0) {
    return 0
  }

  const similarity = dot / norm
  // Clamp to [-1, 1] to handle floating point errors
  return Math.max(-1, Math.min(1, similarity))
}

/**
 * Convert similarity score from [-1, 1] range to [0, 1] range for ranking.
 * This maps -1->0, 0->0.5, 1->1
 */
export function normalizeSimilarity(similarity: number): number {
  return (similarity + 1) / 2
}

/**
 * Find the index of the most similar vector in a list.
 * Returns -1 if list is empty or all vectors have dimension mismatch.
 * Skips candidates with dimension mismatch.
 */
export function findMostSimilar(
  query: VectorLike,
  candidates: readonly VectorLike[],
): { index: number; similarity: number } {
  if (candidates.length === 0) {
    return { index: -1, similarity: -1 }
  }

  let bestIndex = -1
  let bestSimilarity = -1

  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].length !== query.length) {
      continue // Skip dimension mismatch
    }
    const sim = cosineSimilarity(query, candidates[i])
    if (sim > bestSimilarity) {
      bestSimilarity = sim
      bestIndex = i
    }
  }

  return { index: bestIndex, similarity: bestSimilarity }
}