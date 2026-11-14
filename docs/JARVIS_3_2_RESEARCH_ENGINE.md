# JARVIS 3.2 — Unified Research Intelligence Specification
## Multi-Source Web Aggregation, Cross-Verification, Claim Analysis, and Traceable Synthesis

**Document Version:** 3.2.0  
**Baseline:** JARVIS 3.1  
**Architecture Layer:** Unified Research Intelligence (`src/engine/research/ResearchEngine.ts`)  
**Target Platform:** Windows 11 Pro  
**Date:** November 12, 2026  
**Status:** **OPERATIONAL & VERIFIED**

---

## 1. Executive Summary

The JARVIS 3.2 Unified Research Engine evolves the system from a shallow search query runner into a comprehensive, multi-source research assistant. Rather than generating unverified conversational summaries or inventing citations, the Research Engine enforces a strict evidence-first pipeline:
1. Multi-query expansion to eliminate search bias.
2. Multi-source search across primary and secondary web sources (Wikipedia API, DuckDuckGo WebProvider, Tavily).
3. Diverse domain filtering and parallel document fetching.
4. Source reliability scoring (Primary Documentation, Authoritative Secondary, Community/Forum).
5. Cross-checking across sources with automated claim corroboration and discrepancy detection.
6. Traceable synthesis into structured Markdown research briefs and slide presentation outlines (Workflow A).

---

## 2. Architecture & Processing Pipeline

```
User Query (e.g., "Research AI Agents vs Autonomous Systems")
   │
   ▼
1. Query Expansion (expandQueries)
   ├─ Primary Query
   ├─ Technical Synonyms / Benchmarks Query
   └─ Architecture / Evaluation Query
   │
   ▼
2. Multi-Source Search (searchMultiSource)
   ├─ Native Agent / DuckDuckGo Provider
   ├─ Wikipedia REST API (Keyless Authoritative Fallback)
   └─ Tavily API (Configured Search Key)
   │
   ▼
3. Deduplication & Domain Diversity Filter
   └─ Deduplicate URLs, prioritize distinct root domains
   │
   ▼
4. Parallel Document Fetching (fetchTopDocuments)
   └─ Fetch up to 512KB per document with strict timeout rails
   │
   ▼
5. Source Reliability Evaluation (evaluateSourceReliability)
   ├─ Tier 1: Primary (Official docs, .gov, .edu, W3C, RFCs, GitHub) - Score 0.95
   ├─ Tier 2: Secondary (Wikipedia, arXiv, IEEE, ACM) - Score 0.88
   └─ Tier 3: Community (Forums, Reddit, Medium, Dev.to) - Score 0.70
   │
   ▼
6. Cross-Verification & Discrepancy Detection (crossCheck)
   ├─ Extract factual sentences matching query terms
   ├─ Detect contradiction markers ("dispute", "conflicting", "however")
   └─ Elevate confidence to 'high' when >= 2 distinct sources corroborate
   │
   ▼
7. Deliverable Synthesis (synthesizeReport & synthesizePresentationOutline)
   ├─ Executive Summary with inline [N] citations
   ├─ Key Corroborated Findings
   ├─ Conflicting Claims & Discrepancies
   ├─ Verifiable Sources & Citations Table
   └─ Multi-Slide Presentation Outline (Workflow A)
```

---

## 3. Core Capabilities & Implementation Details

### 3.1 Multi-Query Expansion
To avoid narrow perspective bias, `expandQueries` analyzes the linguistic intent:
- Comparison queries (e.g. `X vs Y`) automatically trigger technical benchmark and tradeoff queries.
- Architecture/AI queries append state-of-the-art and evaluation variants.
- General technical queries append official documentation variants.

### 3.2 Source Tiering and Reliability Grading
Every source is evaluated using `evaluateSourceReliability(url)`:
```typescript
export function evaluateSourceReliability(urlStr: string): {
  isPrimary: boolean
  reliabilityScore: number
  sourceTier: 'primary' | 'secondary' | 'community'
}
```
Primary sources (official repositories, language specifications, standards bodies) receive priority ranking during document extraction.

### 3.3 Strict Citation Traceability
In compliance with Rule 1.3:
- **No Invented Citations:** Citations are strictly restricted to URLs actually returned by the search provider or Wikipedia API.
- **Table Provenance:** Every synthesized report includes an explicit Markdown table mapping source ID `[N]` to verified URL, domain, and excerpt snippet.

### 3.4 Multi-Slide Presentation Synthesis (Workflow A)
For Workflow A ("Research ... compare major approaches, prepare a report and create a presentation outline"), `synthesizePresentationOutline(report)` transforms the corroborated findings into:
- Slide 1: Title & Executive Summary
- Slide 2: Key Architecture & Findings (with confidence levels)
- Slide 3: Comparative Analysis & Tradeoffs
- Slide 4: Critical Considerations & Discrepancies
- Slide 5: Citations, Primary Source Ratio & Next Steps

---

## 4. Verification & Test Evidence

The Research Engine is empirically validated in `test/unit/researchEngine.test.ts`:
- **Test 1:** Multi-query expansion verified (generates >= 2 distinct query variants).
- **Test 2:** Source reliability scoring accurately distinguishes `docs.python.org` (primary, 0.95) from `wikipedia.org` (secondary, 0.88) and `reddit.com` (community, 0.70).
- **Test 3:** Cross-checking corroborates claims across distinct sources and elevates confidence to `high`.
- **Test 4:** Markdown synthesis formats executive summary and citations table.
- **Test 5:** Presentation outline generation accurately extracts multi-slide structure.

All 5/5 tests pass with 100% assertions satisfied.

