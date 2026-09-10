import { describe, expect, it } from 'vitest'
import {
  ConversationContextManager,
  assembleConversationWindow,
  rankConversationCandidates,
  conversationScore,
  conversationMessageTokens,
  MAX_CONVERSATION_CONTEXT_TOKENS,
} from './conversationContextManager'
import type { ConversationWindowSelectionConfig } from './conversationContextManager'
import { buildContextWindow } from './context'
import { EmbeddingManager } from '../memory/embeddingManager'
import type { EmbeddingProvider, EmbeddingVector, ProviderHealth } from '../memory/embeddings'
import type { ConversationMessage } from '../conversation/types'

const BASE_CONFIG: ConversationWindowSelectionConfig = {
  recentCount: 8,
  maxTokens: MAX_CONVERSATION_CONTEXT_TOKENS,
  candidateLimit: 40,
  weights: { semantic: 0.6, lexical: 0.4 },
}

function msg(id: string, actor: 'user' | 'assistant', text: string, index = 1): ConversationMessage {
  return { id, actor, text, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() }
}

function ids(messages: ConversationMessage[]): string[] {
  return messages.map((m) => m.id)
}

/** Deterministic content-dependent vectors for a fake REAL provider. */
function contentVector(text: string): number[] {
  if (/coffee|java|bean/.test(text)) return [1, 0, 0]
  if (/cat/.test(text)) return [0, 1, 0]
  return [0, 0, 1]
}

/** Configurable fake of a real embedding provider (never calls the network). */
class FakeRealProvider implements EmbeddingProvider {
  readonly id = 'fake-real'
  readonly label = 'Fake Real Embeddings'
  readonly dimensions = 3
  fail = false

  async embed(text: string): Promise<EmbeddingVector> {
    if (this.fail) throw new Error('embed failed')
    return { values: contentVector(text), dimensions: this.dimensions }
  }

  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    if (this.fail) throw new Error('embed failed')
    return texts.map((t) => ({ values: contentVector(t), dimensions: this.dimensions }))
  }

  isConfigured(): boolean {
    return !this.fail
  }

  async isReachable(): Promise<boolean> {
    return !this.fail
  }

  getHealth(): ProviderHealth {
    return {
      configured: !this.fail,
      status: this.fail ? 'unhealthy' : 'healthy',
      providerId: this.id,
      label: this.label,
      model: 'fake-model',
      dimensions: this.dimensions,
      fallbackActive: false,
      lastError: this.fail ? 'embed failed' : undefined,
    }
  }
}

function realScorer(provider: FakeRealProvider): (texts: string[]) => Promise<Array<number[] | undefined>> {
  const manager = new EmbeddingManager({ provider, maxRetries: 0, retryDelayMs: 0 })
  return async (texts: string[]): Promise<Array<number[] | undefined>> => {
    if (!manager.hasRealEmbeddings()) return texts.map(() => undefined)
    return manager.generateEmbeddingsBatch(texts)
  }
}

describe('conversationMessageTokens', () => {
  it('estimates content tokens plus framing overhead, never 0', () => {
    expect(conversationMessageTokens('')).toBe(2)
    expect(conversationMessageTokens('abcd')).toBe(2)
    expect(conversationMessageTokens('abcdefgh')).toBe(3)
  })
})

describe('conversationScore', () => {
  it('combines semantic and lexical weighted, normalized to [0,1]', () => {
    const needle = new Set(['coffee'])
    const tokens = ['coffee']
    expect(conversationScore('coffee', tokens, needle, 1)).toBe(1)
    expect(conversationScore('coffee', tokens, needle, undefined)).toBe(0.4)
    expect(conversationScore('caffeine', tokens, needle, undefined)).toBe(0)
    expect(conversationScore('caffeine', tokens, needle, 1)).toBe(0.6)
  })

  it('respects custom weights and disallows negative/NaN semantic input', () => {
    const needle = new Set(['coffee'])
    const tokens = ['coffee']
    expect(conversationScore('coffee', tokens, needle, undefined, { semantic: 1, lexical: 0 })).toBe(0)
    expect(conversationScore('coffee', tokens, needle, 0.5, { semantic: 1, lexical: 0 })).toBe(0.5)
    expect(conversationScore('coffee', tokens, needle, -1, { semantic: 0.6, lexical: 0.4 })).toBe(0.4)
  })
})

describe('rankConversationCandidates', () => {
  it('is deterministic and orders by lexical overlap', () => {
    const a = msg('a', 'user', 'alpha beta gamma', 1)
    const b = msg('b', 'user', 'alpha only', 2)
    const q = 'alpha beta'
    expect(rankConversationCandidates([a, b], q).map((r) => r.message.id)).toEqual(['a', 'b'])
    expect(rankConversationCandidates([b, a], q).map((r) => r.message.id)).toEqual(['a', 'b'])
  })

  it('breaks score ties by recency (newer first)', () => {
    const older = msg('older', 'user', 'alpha beta', 1)
    const newer = msg('newer', 'user', 'alpha beta', 2)
    const ranked = rankConversationCandidates([older, newer], 'alpha beta')
    expect(ranked.map((r) => r.message.id)).toEqual(['newer', 'older'])
  })

  it('returns empty for empty candidates or empty query', () => {
    expect(rankConversationCandidates([], 'alpha')).toEqual([])
    expect(rankConversationCandidates([msg('a', 'user', 'alpha beta')], '')).toEqual([])
  })
})

describe('A/F — recent window behavior', () => {
  it('always preserves the appropriate recent block on an empty/irrelevant query', () => {
    const msgs = Array.from({ length: 12 }, (_, i) => msg(`m${i}`, 'user', `line ${i}`, i + 1))
    const ctx = assembleConversationWindow(msgs, '', BASE_CONFIG)
    expect(ids(ctx.messages)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11'])
    expect(ctx.recentCount).toBe(8)
    expect(ctx.retrievedCount).toBe(0)
    expect(ctx.tokenEstimate).toBeLessThanOrEqual(MAX_CONVERSATION_CONTEXT_TOKENS)
  })

  it('keeps recent messages intact through the manager even on an irrelevant query', async () => {
    const msgs = Array.from({ length: 12 }, (_, i) => msg(`m${i}`, 'user', `line ${i}`, i + 1))
    const ctx = await new ConversationContextManager().build({ messages: msgs, query: 'zzzz no overlap' })
    expect(ids(ctx.messages)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11'])
    expect(ctx.recentCount).toBe(8)
  })
})

describe('B/L — older relevant messages are retrieved, chronologically ordered and deduplicated', () => {
  it('brings back an old cybersecurity mention for a later presentation question', async () => {
    const transcript: ConversationMessage[] = [
      msg('m0', 'user', 'I am building a presentation about cybersecurity.', 1),
    ]
    for (let i = 1; i <= 21; i += 1) {
      transcript.push(msg(`m${i}`, 'assistant', `weather update number ${i}`, i + 1))
    }
    const current = msg('current', 'user', 'What points should I put in the presentation?', 99)
    const ctx = await new ConversationContextManager().build({
      messages: [...transcript, current],
      query: 'What points should I put in the presentation?',
      excludeIds: ['current'],
    })

    expect(ctx.messages.some((m) => m.id === 'm0')).toBe(true)
    expect(ctx.retrievedCount).toBeGreaterThanOrEqual(1)
    expect(ctx.recentCount).toBe(8)

    // Chronological ordering is coherent.
    const times = ctx.messages.map((m) => Date.parse(m.createdAt))
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    // The retrieved (oldest) message leads the recent window.
    expect(ctx.messages[0].id).toBe('m0')

    // No duplicate transcript messages.
    expect(new Set(ids(ctx.messages)).size).toBe(ctx.messages.length)
    expect(ctx.tokenEstimate).toBeLessThanOrEqual(MAX_CONVERSATION_CONTEXT_TOKENS)
  })
})

describe('C — lexical determinism', () => {
  it('produces identical windows for identical inputs', async () => {
    const msgs = Array.from({ length: 14 }, (_, i) => msg(`m${i}`, 'user', `relevant token ${i}`, i + 1))
    const manager = new ConversationContextManager()
    const a = await manager.build({ messages: msgs, query: 'relevant' })
    const b = await manager.build({ messages: msgs, query: 'relevant' })
    expect(ids(a.messages)).toEqual(ids(b.messages))
  })
})

describe('D — semantic retrieval through the existing embedding abstraction', () => {
  it('recovers a differently-worded older message only with real embeddings', async () => {
    const old = msg('old-java', 'user', 'I usually grab a java every morning', 1)
    const fillers = Array.from({ length: 10 }, (_, i) => msg(`fill${i}`, 'assistant', `noise about weather ${i}`, i + 2))
    const current = msg('current', 'user', 'What coffee beans do I prefer?', 20)
    const input = {
      messages: [old, ...fillers, current] as ConversationMessage[],
      query: 'What coffee beans do I prefer?',
      excludeIds: ['current'],
    }
    const manager = new ConversationContextManager({ recentCount: 3, candidateLimit: 40 })

    const lexicalOnly = await manager.build(input)
    expect(lexicalOnly.messages.some((m) => m.id === 'old-java')).toBe(false)
    expect(lexicalOnly.semanticRanked).toBe(false)

    const semantic = await manager.build({ ...input, semanticScorer: realScorer(new FakeRealProvider()) })
    expect(semantic.messages.some((m) => m.id === 'old-java')).toBe(true)
    expect(semantic.semanticRanked).toBe(true)
    expect(semantic.tokenEstimate).toBeLessThanOrEqual(MAX_CONVERSATION_CONTEXT_TOKENS)
  })
})

describe('E — semantic failure gracefully falls back', () => {
  async function buildWith(
    scorer: (texts: string[]) => Promise<Array<number[] | undefined>>,
  ) {
    const old = msg('old-match', 'user', 'I like coffee a lot', 1)
    const fillers = Array.from({ length: 9 }, (_, i) => msg(`fill${i}`, 'assistant', `noise about weather ${i}`, i + 2))
    const current = msg('current', 'user', 'tell me about coffee', 20)
    return new ConversationContextManager({ recentCount: 3, candidateLimit: 40 }).build({
      messages: [old, ...fillers, current],
      query: 'tell me about coffee',
      excludeIds: ['current'],
      semanticScorer: scorer,
    })
  }

  it('falls back to lexical-only when the scorer throws', async () => {
    const ctx = await buildWith(async () => {
      throw new Error('embed endpoint down')
    })
    expect(ctx.messages.some((m) => m.id === 'old-match')).toBe(true)
    expect(ctx.semanticRanked).toBe(false)
  })

  it('falls back when the scorer returns a malformed/wrong-length result', async () => {
    const ctx = await buildWith(async (_texts) => [[1, 2, 3]])
    expect(ctx.messages.some((m) => m.id === 'old-match')).toBe(true)
    expect(ctx.semanticRanked).toBe(false)
  })

  it('falls back when the scorer returns all-undefined embeddings', async () => {
    const ctx = await buildWith(async (texts) => texts.map(() => undefined))
    expect(ctx.messages.some((m) => m.id === 'old-match')).toBe(true)
    expect(ctx.semanticRanked).toBe(false)
  })

  it('never scores cross-dimension vectors', async () => {
    // Query is 3-dim but every candidate vector is 2-dim: each candidate must
    // be treated as unscored (semantic 0) instead of producing a bogus cosine.
    const mismatched = async (texts: string[]): Promise<Array<number[] | undefined>> =>
      texts.map((_, i) => (i === 0 ? [1, 0, 0] : [0, 0]))
    const ctx = await buildWith(mismatched)
    expect(ctx.messages.some((m) => m.id === 'old-match')).toBe(true)
    expect(ctx.semanticRanked).toBe(false)
  })
})

describe('G — deduplication against the recent window', () => {
  it('never injects a recent-window message again through retrieval', async () => {
    const transcript: ConversationMessage[] = [
      msg('old-match', 'user', 'I love coffee', 1),
    ]
    for (let i = 1; i <= 9; i += 1) {
      transcript.push(msg(`fill${i}`, 'assistant', `weather update number ${i}`, i + 1))
    }
    transcript.push(msg('recent-match', 'assistant', 'coffee is served here', 20))
    const current = msg('current', 'user', 'Tell me about coffee', 21)

    const ctx = await new ConversationContextManager().build({
      messages: [...transcript, current],
      query: 'Tell me about coffee',
      excludeIds: ['current'],
    })

    const counted = ids(ctx.messages)
    // The old match was added by retrieval; the recent match stays in the
    // window — and neither appears twice.
    expect(counted.filter((id) => id === 'old-match')).toHaveLength(1)
    expect(counted.filter((id) => id === 'recent-match')).toHaveLength(1)
    expect(new Set(counted).size).toBe(counted.length)
  })
})

describe('H — token budget is never exceeded', () => {
  it('keeps the window under a very small budget', async () => {
    const msgs = Array.from({ length: 20 }, (_, i) => msg(`m${i}`, 'user', `relevant token ${i}`, i + 1))
    const ctx = await new ConversationContextManager({ recentCount: 3, maxTokens: 30, candidateLimit: 10 }).build({
      messages: msgs,
      query: 'relevant',
    })
    expect(ctx.tokenEstimate).toBeLessThanOrEqual(30)
    expect(new Set(ids(ctx.messages)).size).toBe(ctx.messages.length)
  })
})

describe('I — oversized messages are handled safely', () => {
  it('drops an older message larger than the whole budget but keeps cheaper ones', async () => {
    const huge = msg('huge', 'user', 'x'.repeat(7000), 1)
    const small = msg('small', 'user', 'I like coffee', 2)
    const ctx = await new ConversationContextManager().build({
      messages: [huge, small],
      query: 'coffee',
    })
    expect(ctx.messages.some((m) => m.id === 'small')).toBe(true)
    expect(ctx.messages.some((m) => m.id === 'huge')).toBe(false)
    expect(ctx.tokenEstimate).toBeLessThanOrEqual(MAX_CONVERSATION_CONTEXT_TOKENS)
  })

  it('never throws and returns an empty window for a single oversized message', async () => {
    const huge = msg('huge', 'user', 'y'.repeat(7000), 1)
    const ctx = await new ConversationContextManager().build({ messages: [huge], query: 'anything' })
    expect(ctx.messages).toEqual([])
    expect(ctx.tokenEstimate).toBe(0)
  })
})

describe('J — empty and short transcripts', () => {
  it('handles an empty transcript', async () => {
    const ctx = await new ConversationContextManager().build({ messages: [], query: 'anything' })
    expect(ctx.messages).toEqual([])
    expect(ctx.recentCount).toBe(0)
    expect(ctx.retrievedCount).toBe(0)
  })

  it('handles a one-message transcript', async () => {
    const only = msg('only', 'assistant', 'hi there', 1)
    const ctx = await new ConversationContextManager().build({ messages: [only], query: 'anything' })
    expect(ids(ctx.messages)).toEqual(['only'])
  })

  it('keeps every message when the transcript is shorter than the window', async () => {
    const msgs = [msg('a', 'user', 'one', 1), msg('b', 'assistant', 'two', 2), msg('c', 'user', 'three', 3)]
    const ctx = await new ConversationContextManager().build({ messages: msgs, query: 'zzz' })
    expect(ids(ctx.messages)).toEqual(['a', 'b', 'c'])
  })
})

describe('K — long transcripts stay bounded', () => {
  it('caps candidate scanning and selection regardless of transcript size', async () => {
    const many = Array.from({ length: 200 }, (_, i) => msg(`n${i}`, 'user', `relevant token ${i}`, i + 1))
    let maxInputs = 0
    const spyScorer = async (texts: string[]): Promise<Array<number[] | undefined>> => {
      maxInputs = Math.max(maxInputs, texts.length)
      return texts.map(() => undefined)
    }
    const ctx = await new ConversationContextManager({ recentCount: 3, candidateLimit: 4, maxTokens: 40 }).build({
      messages: many,
      query: 'relevant',
      semanticScorer: spyScorer,
    })

    // The scorer is only ever asked about the candidateLimit pool (+ query).
    expect(maxInputs).toBeLessThanOrEqual(5)
    // Selection stays tiny and within budget for a 200-message transcript.
    expect(ctx.messages.length).toBeLessThanOrEqual(7)
    expect(ctx.tokenEstimate).toBeLessThanOrEqual(40)
  })
})

describe('exclusion handling', () => {
  it('excludes ids given as an array or a Set', async () => {
    const msgs = [msg('a', 'user', 'one', 1), msg('b', 'user', 'two', 2)]
    const manager = new ConversationContextManager()
    const viaArray = await manager.build({ messages: msgs, query: 'x', excludeIds: ['a'] })
    expect(ids(viaArray.messages)).toEqual(['b'])
    const viaSet = await manager.build({ messages: msgs, query: 'x', excludeIds: new Set(['b']) })
    expect(ids(viaSet.messages)).toEqual(['a'])
  })
})

describe('manager configuration', () => {
  it('honors recentCount/maxTokens/candidateLimit setters', async () => {
    const manager = new ConversationContextManager({ recentCount: 2, maxTokens: 20, candidateLimit: 3 })
    manager.setRecentCount(4)
    manager.setMaxTokens(50)
    manager.setCandidateLimit(5)
    manager.setWeights({ semantic: 0.5 })
    const msgs = Array.from({ length: 6 }, (_, i) => msg(`m${i}`, 'user', `line ${i}`, i + 1))
    const ctx = await manager.build({ messages: msgs, query: '' })
    expect(ctx.recentCount).toBe(4)
    expect(ctx.tokenEstimate).toBeLessThanOrEqual(50)
  })
})

describe('buildContextWindow backward compatibility', () => {
  it('keeps the original recency-slice behavior without options', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, 'user', `line ${i}`, i + 1))
    expect(ids(buildContextWindow(msgs, 4).messages)).toEqual(['m6', 'm7', 'm8', 'm9'])
  })

  it('applies an optional token budget that never drops the newest messages', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, 'user', `line ${i}`, i + 1))
    const ctx = buildContextWindow(msgs, 4, { maxTokens: 12 })
    expect(ctx.messages.length).toBeLessThanOrEqual(4)
    expect(ctx.messages[ctx.messages.length - 1].id).toBe('m9')
  })
})