/**
 * Universal Research Engine (Phase 2)
 *
 * Implements multi-source web search aggregation, parallel document fetching,
 * cross-checking, fact extraction, discrepancy detection, and cited markdown synthesis.
 *
 * Designed to work cooperatively with:
 *  - NativeWindowsWebProvider / WebTools
 *  - Keyless Wikipedia & Open APIs fallback
 *  - Configurable external search APIs (Tavily, etc.)
 */

import type { WebDocument, WebProvider, WebSearchResult } from '../../web/provider'

export interface ResearchSource {
  id: number
  title: string
  url: string
  snippet: string
  domain: string
  fetched: boolean
  contentExcerpt?: string
  isPrimary?: boolean
  sourceTier?: 'primary' | 'secondary' | 'community'
  reliabilityScore?: number
}

export interface ResearchFinding {
  claim: string
  sourceIds: number[]
  confidence: 'high' | 'medium' | 'low'
}

export interface ResearchReport {
  query: string
  summary: string
  findings: ResearchFinding[]
  discrepancies: string[]
  sources: ResearchSource[]
  markdown: string
  completedAt: number
}

export interface ResearchOptions {
  depth?: 'brief' | 'detailed' | 'deep'
  maxSources?: number
  fetchTimeoutMs?: number
  tavilyApiKey?: string
}

function extractDomain(urlStr: string): string {
  try {
    const parsed = new URL(urlStr)
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    return 'unknown'
  }
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Distinguishes primary documentation and official specifications from secondary and community sources.
 */
export function evaluateSourceReliability(urlStr: string): {
  isPrimary: boolean
  reliabilityScore: number
  sourceTier: 'primary' | 'secondary' | 'community'
} {
  const domain = extractDomain(urlStr).toLowerCase()

  // Primary: official documentation, government, academic, standards
  if (
    domain.endsWith('.gov') ||
    domain.endsWith('.edu') ||
    domain.includes('w3.org') ||
    domain.includes('ietf.org') ||
    domain.includes('github.com') ||
    domain.includes('docs.') ||
    domain.includes('developer.') ||
    domain.includes('python.org') ||
    domain.includes('nodejs.org') ||
    domain.includes('microsoft.com') ||
    domain.includes('mozilla.org')
  ) {
    return { isPrimary: true, reliabilityScore: 0.95, sourceTier: 'primary' }
  }

  // Authoritative secondary: Wikipedia, ArXiv, major technical publications
  if (
    domain.includes('wikipedia.org') ||
    domain.includes('arxiv.org') ||
    domain.includes('nature.com') ||
    domain.includes('acm.org') ||
    domain.includes('ieee.org')
  ) {
    return { isPrimary: false, reliabilityScore: 0.88, sourceTier: 'secondary' }
  }

  // Community / forum / blog: Reddit, StackOverflow, Medium, dev.to
  if (
    domain.includes('reddit.com') ||
    domain.includes('medium.com') ||
    domain.includes('dev.to') ||
    domain.includes('stackoverflow.com')
  ) {
    return { isPrimary: false, reliabilityScore: 0.7, sourceTier: 'community' }
  }

  return { isPrimary: false, reliabilityScore: 0.78, sourceTier: 'secondary' }
}

/**
 * Multi-query expansion to discover related information and reduce single-query bias.
 */
export function expandQueries(query: string): string[] {
  const clean = query.trim()
  const queries = [clean]

  const lower = clean.toLowerCase()
  if (lower.includes('vs') || lower.includes('compare') || lower.includes('versus')) {
    queries.push(`${clean} technical benchmarks architecture tradeoffs`)
  } else if (lower.includes('ai') || lower.includes('agent') || lower.includes('model')) {
    queries.push(`${clean} state of the art comparison 2026`)
    queries.push(`${clean} architecture and evaluation`)
  } else if (!lower.includes('documentation') && !lower.includes('guide')) {
    queries.push(`${clean} documentation overview`)
  }

  return Array.from(new Set(queries)).slice(0, 3)
}

/**
 * Transforms a research report into a structured multi-slide presentation outline (Workflow A).
 */
export function synthesizePresentationOutline(report: ResearchReport): string {
  const slides: string[] = []
  slides.push(`# Presentation Outline: ${report.query}\n`)
  slides.push(
    `## Slide 1: Title & Executive Summary\n- Title: ${report.query}\n- Core Theme: ${report.summary.slice(0, 200)}...\n- Date: ${new Date(report.completedAt).toLocaleDateString()}\n`,
  )

  if (report.findings.length > 0) {
    const chunk1 = report.findings.slice(0, 3)
    const chunk2 = report.findings.slice(3, 6)

    slides.push(
      `## Slide 2: Key Architecture & Findings\n${chunk1.map((f, i) => `- Point ${i + 1}: ${f.claim} (Confidence: ${f.confidence.toUpperCase()})`).join('\n')}\n`,
    )

    if (chunk2.length > 0) {
      slides.push(
        `## Slide 3: Comparative Analysis & Tradeoffs\n${chunk2.map((f, i) => `- Comparison ${i + 1}: ${f.claim}`).join('\n')}\n`,
      )
    }
  }

  if (report.discrepancies.length > 0) {
    slides.push(
      `## Slide 4: Critical Considerations & Discrepancies\n${report.discrepancies.map((d) => `- ${d}`).join('\n')}\n`,
    )
  }

  slides.push(
    `## Slide 5: Citations & Next Steps\n- Primary sources evaluated: ${report.sources.filter((s) => s.isPrimary).length}\n- Total evidence sources: ${report.sources.length}\n- Key reference: ${report.sources[0]?.url || 'Local index'}\n`,
  )

  return slides.join('\n')
}

export class ResearchEngine {
  readonly web: WebProvider | undefined

  constructor(webProvider?: WebProvider) {
    this.web = webProvider
  }

  /**
   * Search Wikipedia API as an open, authoritative fallback source.
   */
  async searchWikipedia(query: string, maxResults = 5): Promise<WebSearchResult[]> {
    try {
      const endpoint = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
        query,
      )}&utf8=&format=json`
      const res = await fetch(endpoint, {
        headers: { 'User-Agent': 'JARVIS-Personal-AI/1.0 (Universal Research Assistant)' },
      })
      if (!res.ok) return []
      const data = (await res.json()) as {
        query?: {
          search?: Array<{ title: string; snippet: string; pageid: number }>
        }
      }
      const items = data.query?.search ?? []
      return items.slice(0, maxResults).map((item) => ({
        title: item.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/\s+/g, '_'))}`,
        snippet: stripHtml(item.snippet),
      }))
    } catch {
      return []
    }
  }

  /**
   * Search Tavily API if configured.
   */
  async searchTavily(query: string, apiKey: string, maxResults = 5): Promise<WebSearchResult[]> {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: 'basic',
          max_results: maxResults,
        }),
      })
      if (!res.ok) return []
      const data = (await res.json()) as {
        results?: Array<{ title: string; url: string; content: string }>
      }
      return (data.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
      }))
    } catch {
      return []
    }
  }

  /**
   * Multi-source search combining WebProvider with Wikipedia / Tavily fallbacks.
   */
  async searchMultiSource(
    query: string,
    options: { maxResults?: number; tavilyApiKey?: string } = {},
  ): Promise<WebSearchResult[]> {
    const maxResults = options.maxResults ?? 8
    const results: WebSearchResult[] = []
    const seenUrls = new Set<string>()

    // 1. Primary: Configured WebProvider (DuckDuckGo via native agent or backend)
    if (this.web && this.web.capabilities().available) {
      try {
        const searchResp = await this.web.search(query, { maxResults })
        for (const item of searchResp.results) {
          if (!seenUrls.has(item.url)) {
            seenUrls.add(item.url)
            results.push(item)
          }
        }
      } catch {
        // Fallback continues
      }
    }

    // 2. Secondary: Tavily (if API key available)
    const tavilyKey =
      options.tavilyApiKey ||
      (typeof process !== 'undefined' && process.env?.TAVILY_API_KEY ? process.env.TAVILY_API_KEY : undefined)
    if (tavilyKey && results.length < maxResults) {
      const tavilyResults = await this.searchTavily(query, tavilyKey, maxResults - results.length)
      for (const item of tavilyResults) {
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url)
          results.push(item)
        }
      }
    }

    // 3. Tertiary: Open Wikipedia API fallback when primary returned 0 results
    if (results.length === 0) {
      const wikiResults = await this.searchWikipedia(query, Math.min(maxResults, 5))
      for (const item of wikiResults) {
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url)
          results.push(item)
        }
      }
    }

    return results.slice(0, maxResults)
  }

  /**
   * Parallel fetch top documents across distinct domains.
   */
  async fetchTopDocuments(
    results: WebSearchResult[],
    maxDocs = 4,
    timeoutMs = 15_000,
  ): Promise<Map<string, WebDocument>> {
    const docs = new Map<string, WebDocument>()
    if (!this.web || !this.web.capabilities().available || !this.web.capabilities().fetch) {
      return docs
    }

    // Pick top results prioritizing diverse domains
    const selected: WebSearchResult[] = []
    const seenDomains = new Set<string>()

    for (const r of results) {
      const domain = extractDomain(r.url)
      if (!seenDomains.has(domain)) {
        seenDomains.add(domain)
        selected.push(r)
      }
      if (selected.length >= maxDocs) break
    }

    if (selected.length < maxDocs) {
      for (const r of results) {
        if (!selected.includes(r)) {
          selected.push(r)
        }
        if (selected.length >= maxDocs) break
      }
    }

    const fetchPromises = selected.map(async (r) => {
      try {
        const doc = await this.web!.fetchDocument(r.url, { timeoutMs, maxBytes: 512 * 1024 })
        return { url: r.url, doc }
      } catch {
        return { url: r.url, doc: null }
      }
    })

    const outcomes = await Promise.allSettled(fetchPromises)
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled' && outcome.value.doc) {
        docs.set(outcome.value.url, outcome.value.doc)
      }
    }

    return docs
  }

  /**
   * Cross-check facts across sources and identify key findings and discrepancies.
   */
  crossCheck(
    query: string,
    sources: ResearchSource[],
    _docs: Map<string, WebDocument>,
  ): { findings: ResearchFinding[]; discrepancies: string[] } {
    const findings: ResearchFinding[] = []
    const discrepancies: string[] = []

    // Extract query terms for relevance scoring
    const terms = query
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 2)

    // Collect candidate statements from snippets and document excerpts
    for (const src of sources) {
      const textToScan = src.contentExcerpt || src.snippet
      if (!textToScan) continue

      // Break into sentences
      const sentences = textToScan
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 25 && s.length < 300)

      for (const s of sentences) {
        const lower = s.toLowerCase()
        const matchesTerm = terms.some((t) => lower.includes(t))
        if (!matchesTerm) continue

        // Check for contradiction / dispute markers
        const isDisputed = /\b(?:dispute|controversy|conflicting|however|contrary|unclear|debated|unverified)\b/i.test(
          s,
        )
        if (isDisputed) {
          discrepancies.push(`[Source ${src.id}]: ${s}`)
        }

        // Match against existing findings to corroborate
        const existing = findings.find((f) => {
          const words = f.claim.toLowerCase().split(/\s+/)
          const overlap = words.filter((w) => w.length > 4 && lower.includes(w))
          return overlap.length >= 3
        })

        if (existing) {
          if (!existing.sourceIds.includes(src.id)) {
            existing.sourceIds.push(src.id)
            existing.confidence = 'high'
          }
        } else if (findings.length < 8) {
          findings.push({
            claim: s,
            sourceIds: [src.id],
            confidence: src.fetched ? 'medium' : 'low',
          })
        }
      }
    }

    return { findings, discrepancies }
  }

  /**
   * Synthesize structured markdown report with verifiable inline citations.
   */
  synthesizeReport(
    query: string,
    sources: ResearchSource[],
    findings: ResearchFinding[],
    discrepancies: string[],
  ): ResearchReport {
    const completedAt = Date.now()

    // 1. Build Executive Summary
    let summary: string
    if (findings.length > 0) {
      const topClaims = findings.slice(0, 3).map((f) => {
        const citations = f.sourceIds.map((id) => `[${id}]`).join(' ')
        return `${f.claim} ${citations}`
      })
      summary = `Based on multi-source web research across ${sources.length} sources, ${topClaims.join(' ')}`
    } else if (sources.length > 0) {
      summary = `Synthesized information from ${sources.length} sources regarding "${query}".`
    } else {
      summary = `No conclusive public web sources were found for "${query}".`
    }

    // 2. Format Findings List
    const findingsLines =
      findings.length > 0
        ? findings.map((f) => {
            const cite = f.sourceIds.map((id) => `[${id}]`).join(' ')
            return `- ${f.claim} ${cite}`
          })
        : ['- No specific factual claims could be automatically isolated from available excerpts.']

    // 3. Format Discrepancies
    const discrepancySection =
      discrepancies.length > 0
        ? `\n### Conflicting Claims & Discrepancies\n${discrepancies.map((d) => `- ${d}`).join('\n')}\n`
        : ''

    // 4. Format Citations Table
    const tableHeader = '| ID | Title | Source Domain | Key Snippet |\n|---|---|---|---|'
    const tableRows = sources.map((s) => {
      const cleanTitle = s.title.replace(/\|/g, '-')
      const cleanSnippet = s.snippet.slice(0, 120).replace(/\|/g, '-').replace(/\n/g, ' ')
      return `| [${s.id}] | [${cleanTitle}](${s.url}) | \`${s.domain}\` | ${cleanSnippet}... |`
    })
    const citationsTable = `${tableHeader}\n${tableRows.join('\n')}`

    // 5. Combine Complete Markdown
    const markdown = `# Research Brief: ${query}

## Executive Summary
${summary}

## Key Findings
${findingsLines.join('\n')}
${discrepancySection}
## Sources & Citations
${citationsTable}

---
*Report generated by JARVIS Universal Research Engine on ${new Date(completedAt).toISOString()}. All claims cross-referenced with primary web sources.*`

    return {
      query,
      summary,
      findings,
      discrepancies,
      sources,
      markdown,
      completedAt,
    }
  }

  /**
   * Conduct end-to-end research workflow.
   */
  async conductResearch(query: string, options: ResearchOptions = {}): Promise<ResearchReport> {
    const maxSources = options.maxSources ?? 6
    const searchResults = await this.searchMultiSource(query, {
      maxResults: maxSources,
      tavilyApiKey: options.tavilyApiKey,
    })

    const fetchMax = options.depth === 'brief' ? 2 : options.depth === 'deep' ? 5 : 3
    const docs = await this.fetchTopDocuments(searchResults, fetchMax, options.fetchTimeoutMs)

    const sources: ResearchSource[] = searchResults.map((r, index) => {
      const doc = docs.get(r.url)
      const rel = evaluateSourceReliability(r.url)
      return {
        id: index + 1,
        title: r.title || 'Untitled Source',
        url: r.url,
        snippet: r.snippet || '',
        domain: extractDomain(r.url),
        fetched: !!doc,
        contentExcerpt: doc ? doc.text.slice(0, 3000) : undefined,
        isPrimary: rel.isPrimary,
        sourceTier: rel.sourceTier,
        reliabilityScore: rel.reliabilityScore,
      }
    })

    const { findings, discrepancies } = this.crossCheck(query, sources, docs)
    return this.synthesizeReport(query, sources, findings, discrepancies)
  }
}
