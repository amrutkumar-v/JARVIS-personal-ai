import { describe, it, expect } from 'vitest'
import {
  ResearchEngine,
  evaluateSourceReliability,
  expandQueries,
  synthesizePresentationOutline,
  type ResearchReport,
} from '../../src/engine/research/ResearchEngine'
import type { WebProvider } from '../../src/web/provider'

describe('Phase 2 — Unified Research Intelligence (ResearchEngine)', () => {
  it('1. Expands user queries to reduce narrow query bias and discover related topics', () => {
    const queries = expandQueries('AI agents vs autonomous systems')
    expect(queries.length).toBeGreaterThanOrEqual(2)
    expect(queries[0]).toBe('AI agents vs autonomous systems')
    expect(queries.some((q) => q.includes('benchmarks') || q.includes('tradeoffs'))).toBe(true)
  })

  it('2. Evaluates source reliability and distinguishes primary, secondary, and community tiers', () => {
    const docReliability = evaluateSourceReliability('https://docs.python.org/3/library/unittest.html')
    expect(docReliability.isPrimary).toBe(true)
    expect(docReliability.sourceTier).toBe('primary')
    expect(docReliability.reliabilityScore).toBeGreaterThanOrEqual(0.9)

    const wikiReliability = evaluateSourceReliability('https://en.wikipedia.org/wiki/Artificial_intelligence')
    expect(wikiReliability.isPrimary).toBe(false)
    expect(wikiReliability.sourceTier).toBe('secondary')
    expect(wikiReliability.reliabilityScore).toBeGreaterThanOrEqual(0.8)

    const redditReliability = evaluateSourceReliability('https://www.reddit.com/r/MachineLearning/comments/xyz')
    expect(redditReliability.isPrimary).toBe(false)
    expect(redditReliability.sourceTier).toBe('community')
    expect(redditReliability.reliabilityScore).toBeLessThan(0.8)
  })

  it('3. Cross-checks statements across sources and identifies corroborated findings', () => {
    const engine = new ResearchEngine()
    const query = 'transformer self-attention computational complexity'
    const sources = [
      {
        id: 1,
        title: 'Attention is All You Need',
        url: 'https://arxiv.org/abs/1706.03762',
        snippet: 'Standard self-attention has quadratic O(n^2) computational complexity with sequence length.',
        domain: 'arxiv.org',
        fetched: true,
      },
      {
        id: 2,
        title: 'Efficient Transformers Survey',
        url: 'https://docs.example.org/transformers',
        snippet: 'Standard self-attention mechanisms exhibit quadratic O(n^2) computational complexity and memory usage.',
        domain: 'docs.example.org',
        fetched: true,
      },
    ]

    const { findings, discrepancies } = engine.crossCheck(query, sources, new Map())
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].claim).toContain('O(n^2)')
    // Since both sources corroborate the O(n^2) complexity, confidence is upgraded to high
    expect(findings[0].confidence).toBe('high')
    expect(findings[0].sourceIds).toEqual([1, 2])
  })

  it('4. Synthesizes a structured markdown report with verified citations table', () => {
    const engine = new ResearchEngine()
    const query = 'WebAssembly memory safety guarantees'
    const sources = [
      {
        id: 1,
        title: 'WebAssembly Specification',
        url: 'https://www.w3.org/TR/wasm-core-1/',
        snippet: 'WebAssembly memory is a linear array of bytes distinct from code space.',
        domain: 'w3.org',
        fetched: true,
        isPrimary: true,
        sourceTier: 'primary' as const,
        reliabilityScore: 0.95,
      },
    ]
    const findings = [
      {
        claim: 'WebAssembly memory is a linear array of bytes isolated from execution code.',
        sourceIds: [1],
        confidence: 'high' as const,
      },
    ]

    const report = engine.synthesizeReport(query, sources, findings, [])
    expect(report.query).toBe(query)
    expect(report.markdown).toContain('# Research Brief: WebAssembly memory safety guarantees')
    expect(report.markdown).toContain('## Executive Summary')
    expect(report.markdown).toContain('## Key Findings')
    expect(report.markdown).toContain('## Sources & Citations')
    expect(report.markdown).toContain('| [1] | [WebAssembly Specification](https://www.w3.org/TR/wasm-core-1/) | `w3.org` |')
  })

  it('5. Generates a multi-slide presentation outline from a research report (Workflow A)', () => {
    const mockReport: ResearchReport = {
      query: 'Autonomous AI Agents Architecture',
      summary: 'Comprehensive analysis of modern autonomous AI agents utilizing tool orchestration and durable memory.',
      findings: [
        { claim: 'Single cognitive authority prevents conflicting planner deadlocks.', sourceIds: [1], confidence: 'high' },
        { claim: 'Persistent task checkpointing enables crash recovery.', sourceIds: [2], confidence: 'high' },
      ],
      discrepancies: ['Varying definitions of autonomy across academic vs commercial platforms.'],
      sources: [
        {
          id: 1,
          title: 'Autonomous Agents Core',
          url: 'https://docs.jarvis.ai/agents',
          snippet: 'Single cognitive authority',
          domain: 'jarvis.ai',
          fetched: true,
          isPrimary: true,
        },
      ],
      markdown: '...',
      completedAt: Date.now(),
    }

    const presentation = synthesizePresentationOutline(mockReport)
    expect(presentation).toContain('# Presentation Outline: Autonomous AI Agents Architecture')
    expect(presentation).toContain('## Slide 1: Title & Executive Summary')
    expect(presentation).toContain('## Slide 2: Key Architecture & Findings')
    expect(presentation).toContain('Single cognitive authority')
    expect(presentation).toContain('## Slide 4: Critical Considerations & Discrepancies')
    expect(presentation).toContain('## Slide 5: Citations & Next Steps')
  })
})

