import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ResearchEngine, type ResearchSource } from './ResearchEngine'
import type { WebDocument, WebProvider, WebSearchResponse } from '../../web/provider'

class FakeWebProvider implements WebProvider {
  readonly id = 'fake-web'
  private available = true
  private searchResults: WebSearchResponse | null = null
  private docs = new Map<string, WebDocument>()

  setAvailable(v: boolean) {
    this.available = v
  }

  setSearchResults(res: WebSearchResponse) {
    this.searchResults = res
  }

  setDocument(url: string, doc: WebDocument) {
    this.docs.set(url, doc)
  }

  capabilities() {
    return {
      available: this.available,
      search: this.available,
      fetch: this.available,
      download: this.available,
    }
  }

  async search(): Promise<WebSearchResponse> {
    if (!this.searchResults) throw new Error('Search failed')
    return this.searchResults
  }

  async fetchDocument(url: string): Promise<WebDocument> {
    const doc = this.docs.get(url)
    if (!doc) throw new Error(`404: Not found ${url}`)
    return doc
  }

  async download(): Promise<any> {
    throw new Error('Not implemented')
  }
}

describe('ResearchEngine (Universal Web Search & Deep Research)', () => {
  let fakeWeb: FakeWebProvider
  let engine: ResearchEngine

  beforeEach(() => {
    fakeWeb = new FakeWebProvider()
    engine = new ResearchEngine(fakeWeb)
  })

  // --------------------------------------------------------------------------
  // 1. Wikipedia Fallback Search
  // --------------------------------------------------------------------------
  describe('searchWikipedia', () => {
    it('queries open Wikipedia API and parses results with HTML stripped', async () => {
      const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            search: [
              {
                title: 'Quantum computing',
                snippet: 'Quantum computing is a rapidly-emerging technology that harnesses the laws of <span class="searchmatch">quantum</span> mechanics.',
                pageid: 12345,
              },
            ],
          },
        }),
      } as any)

      const results = await engine.searchWikipedia('Quantum computing', 2)
      expect(results.length).toBe(1)
      expect(results[0].title).toBe('Quantum computing')
      expect(results[0].url).toContain('wikipedia.org/wiki/Quantum_computing')
      expect(results[0].snippet).not.toContain('<span')
      expect(results[0].snippet).toContain('quantum mechanics')
      globalFetch.mockRestore()
    })
  })

  // --------------------------------------------------------------------------
  // 2. Multi-Source Search Aggregation
  // --------------------------------------------------------------------------
  describe('searchMultiSource', () => {
    it('uses primary WebProvider when available', async () => {
      fakeWeb.setSearchResults({
        query: 'TypeScript 5.8',
        provider: 'duckduckgo',
        servedAt: Date.now(),
        freshness: { detectable: true, note: 'recent' },
        results: [
          { title: 'TypeScript 5.8 Release Notes', url: 'https://devblogs.microsoft.com/typescript/5-8', snippet: 'TypeScript 5.8 introduces new checks.' },
          { title: 'What is new in TS 5.8', url: 'https://example.com/ts58', snippet: 'A deep dive into TypeScript 5.8.' },
        ],
      })

      const results = await engine.searchMultiSource('TypeScript 5.8', { maxResults: 5 })
      expect(results.length).toBe(2)
      expect(results[0].title).toBe('TypeScript 5.8 Release Notes')
    })

    it('falls back to Wikipedia when primary provider returns no results or fails', async () => {
      fakeWeb.setAvailable(false) // Primary unavailable

      const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            search: [
              {
                title: 'Artificial neural network',
                snippet: 'An artificial neural network is a computational model.',
                pageid: 999,
              },
            ],
          },
        }),
      } as any)

      const results = await engine.searchMultiSource('Artificial neural network', { maxResults: 3 })
      expect(results.length).toBe(1)
      expect(results[0].title).toBe('Artificial neural network')
      globalFetch.mockRestore()
    })

    it('deduplicates URLs across multiple search providers', async () => {
      fakeWeb.setSearchResults({
        query: 'AI agents',
        provider: 'duckduckgo',
        servedAt: Date.now(),
        freshness: { detectable: false, note: '' },
        results: [
          { title: 'AI Agents Overview', url: 'https://en.wikipedia.org/wiki/Intelligent_agent', snippet: 'Overview snippet' },
        ],
      })

      const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            search: [
              {
                title: 'Intelligent agent',
                snippet: 'Wikipedia snippet for intelligent agent.',
                pageid: 111,
              },
            ],
          },
        }),
      } as any)

      const results = await engine.searchMultiSource('AI agents', { maxResults: 5 })
      // Even though Wikipedia returned the same wiki URL, it was deduplicated
      expect(results.length).toBe(1)
      globalFetch.mockRestore()
    })
  })

  // --------------------------------------------------------------------------
  // 3. Parallel Document Fetching
  // --------------------------------------------------------------------------
  describe('fetchTopDocuments', () => {
    it('fetches documents across unique domains in parallel with error resilience', async () => {
      const searchItems = [
        { title: 'Doc 1', url: 'https://alpha.com/doc1', snippet: 'S1' },
        { title: 'Doc 2', url: 'https://beta.org/doc2', snippet: 'S2' },
        { title: 'Doc 3', url: 'https://broken.net/fail', snippet: 'S3' },
      ]

      fakeWeb.setDocument('https://alpha.com/doc1', {
        url: 'https://alpha.com/doc1',
        finalUrl: 'https://alpha.com/doc1',
        status: 200,
        title: 'Alpha Document',
        text: 'This is the full text of Alpha document with in-depth technical facts.',
        bytes: 1024,
        truncatedChars: 0,
        fetchedAt: Date.now(),
      })

      fakeWeb.setDocument('https://beta.org/doc2', {
        url: 'https://beta.org/doc2',
        finalUrl: 'https://beta.org/doc2',
        status: 200,
        title: 'Beta Document',
        text: 'Beta document covers architectural details and performance benchmarks.',
        bytes: 2048,
        truncatedChars: 0,
        fetchedAt: Date.now(),
      })

      const docs = await engine.fetchTopDocuments(searchItems, 3)
      expect(docs.size).toBe(2)
      expect(docs.get('https://alpha.com/doc1')?.title).toBe('Alpha Document')
      expect(docs.get('https://beta.org/doc2')?.title).toBe('Beta Document')
      expect(docs.has('https://broken.net/fail')).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // 4. Cross-Checking & Fact Synthesis
  // --------------------------------------------------------------------------
  describe('crossCheck & synthesizeReport', () => {
    it('cross-references facts, detects corroboration, and produces cited report', () => {
      const query = 'autonomous agents'
      const sources: ResearchSource[] = [
        {
          id: 1,
          title: 'Autonomous Agents 2026',
          url: 'https://agents.org/overview',
          domain: 'agents.org',
          snippet: 'Autonomous agents operate in background loops with self-directed DAG subtasks.',
          fetched: true,
          contentExcerpt: 'Autonomous agents operate in background loops with self-directed DAG subtasks and persistent checkpoints.',
        },
        {
          id: 2,
          title: 'Agentic Architectures',
          url: 'https://techreview.com/agents',
          domain: 'techreview.com',
          snippet: 'Modern agents rely on background loops with self-directed DAG subtasks to achieve reliable completion.',
          fetched: true,
          contentExcerpt: 'Modern agents rely on background loops with self-directed DAG subtasks to achieve reliable completion.',
        },
      ]

      const docs = new Map<string, WebDocument>()
      const { findings, discrepancies } = engine.crossCheck(query, sources, docs)

      expect(findings.length).toBeGreaterThan(0)
      const corroborated = findings.find((f) => f.sourceIds.length >= 2)
      expect(corroborated).toBeDefined()
      expect(corroborated?.confidence).toBe('high')

      const report = engine.synthesizeReport(query, sources, findings, discrepancies)
      expect(report.query).toBe(query)
      expect(report.markdown).toContain('# Research Brief: autonomous agents')
      expect(report.markdown).toContain('## Executive Summary')
      expect(report.markdown).toContain('## Key Findings')
      expect(report.markdown).toContain('## Sources & Citations')
      expect(report.markdown).toContain('| [1] | [Autonomous Agents 2026](https://agents.org/overview) |')
      expect(report.markdown).toContain('| [2] | [Agentic Architectures](https://techreview.com/agents) |')
    })

    it('identifies conflicting or controversial claims', () => {
      const query = 'superconductor ambient claims'
      const sources: ResearchSource[] = [
        {
          id: 1,
          title: 'Ambient Superconductor Discovery',
          url: 'https://nature-news.org/paper1',
          domain: 'nature-news.org',
          snippet: 'However, independent replication attempts have disputed the superconductor claims under room temperature.',
          fetched: true,
        },
      ]
      const docs = new Map<string, WebDocument>()
      const { discrepancies } = engine.crossCheck(query, sources, docs)
      expect(discrepancies.length).toBeGreaterThan(0)
      expect(discrepancies[0]).toContain('disputed')
    })
  })

  // --------------------------------------------------------------------------
  // 5. End-to-End Research Pipeline
  // --------------------------------------------------------------------------
  describe('conductResearch', () => {
    it('executes full multi-source search, fetch, cross-check, and report synthesis', async () => {
      fakeWeb.setSearchResults({
        query: 'Rust memory safety',
        provider: 'duckduckgo',
        servedAt: Date.now(),
        freshness: { detectable: true, note: 'valid' },
        results: [
          {
            title: 'Rust Ownership Model',
            url: 'https://rust-lang.org/ownership',
            snippet: 'Rust ensures memory safety without a garbage collector through its borrow checker.',
          },
          {
            title: 'Mozilla Tech Blog: Safe Concurrency',
            url: 'https://blog.mozilla.org/rust-safety',
            snippet: 'The borrow checker prevents data races at compile time and ensures memory safety.',
          },
        ],
      })

      fakeWeb.setDocument('https://rust-lang.org/ownership', {
        url: 'https://rust-lang.org/ownership',
        finalUrl: 'https://rust-lang.org/ownership',
        status: 200,
        title: 'Rust Ownership Model',
        text: 'Rust achieves memory safety at compile time using ownership, references, and borrowing rules.',
        bytes: 5000,
        truncatedChars: 0,
        fetchedAt: Date.now(),
      })

      const report = await engine.conductResearch('Rust memory safety', { depth: 'brief' })
      expect(report.sources.length).toBe(2)
      expect(report.findings.length).toBeGreaterThan(0)
      expect(report.markdown).toContain('# Research Brief: Rust memory safety')
      expect(report.markdown).toContain('[1]')
    })
  })
})

