# JARVIS 3.2 — Universal Document & Knowledge Intelligence Specification
## Multi-Format Parsing, Persistent Knowledge Indexing, Provenance, and Grounded Retrieval

**Document Version:** 3.2.0  
**Baseline:** JARVIS 3.1  
**Architecture Layer:** Document & Knowledge Engine (`src/engine/documents/`)  
**Target Platform:** Windows 11 Pro  
**Date:** November 12, 2026  
**Status:** **OPERATIONAL & VERIFIED**

---

## 1. Executive Summary

The JARVIS 3.2 Knowledge Engine provides comprehensive document understanding, indexing, and retrieval across the user's local operating system. It parses standard office, tabular, technical, and structured formats, extracts hierarchical section structures and tables, indexes chunks with cryptographic SHA-256 change detection, and persists indexes to disk so that document context survives system restarts.

Grounded Q&A queries return verified textual evidence accompanied by traceable citations (including document title, section heading, sheet name, or slide number), strictly preventing hallucinated facts.

---

## 2. Supported Document Formats

The parser pipeline (`DocumentParser.ts` and `ZipExtractor.ts`) supports comprehensive format ingestion:

| Format Category | Extensions / MIME | Parsing Mechanism | Extracted Structural Elements |
|---|---|---|---|
| **Office Word** | `.docx` | XML Zip unpack (`word/document.xml`) | Headings (H1-H3), body paragraphs, bullet lists, bold text |
| **Office Excel** | `.xlsx` | XML Zip unpack (`xl/worksheets/`, `xl/sharedStrings.xml`) | Multi-sheet names, tabular cells, row/column matrices, numeric values |
| **Office PowerPoint** | `.pptx` | XML Zip unpack (`ppt/slides/slide*.xml`) | Slide numbers, slide titles, body bullet points, presenter notes |
| **Tabular Data** | `.csv`, `.tsv` | RFC 4180 streaming delimiter parser | Column headers, numeric columns, row records, delimiter inference |
| **Portable Document** | `.pdf` | Structured text stream parser | Page numbers, section headings, body paragraphs, text blocks |
| **Technical Text** | `.md`, `.markdown` | CommonMark AST parser | Heading hierarchy (# to ######), Markdown tables, code blocks |
| **Structured Data** | `.json`, `.yaml`, `.env` | Native recursive parser | Key-value hierarchies, arrays, environment variables |
| **Source Code** | `.py`, `.ts`, `.js`, `.rs`, `.cpp` | Lexical parser | Functions, classes, comments, docstrings, imports |

---

## 3. Persistent Storage & Index Architecture

```
Document Ingestion (ingest)
   │
   ├─► Compute Content SHA-256 Digest
   │     └─ Change Detection: If content hash identical, skip re-index
   │
   ├─► Structured Parsing (DocumentParser)
   │     └─ Hierarchical sections, tables, slide/sheet/page citations
   │
   ├─► Semantic Chunking (DocumentChunker)
   │     └─ Bounded window (500 tokens), overlap (50 tokens), title preservation
   │
   ├─► Memory Index & Inverted Term Map
   │     └─ Title weighting (2.0x), exact phrase bonus (3.0x), term frequency
   │
   └─► Disk Persistence (persistToDisk)
         └─ Atomic JSON storage: server/data/index/documents.json
```

### 3.1 Restart Survival & Integrity
- **Index Location:** `server/data/index/documents.json`.
- **Automatic Load on Startup:** The constructor executes `loadFromDisk()`. If the file exists, documents, chunks, and content hashes are restored into memory without requiring re-parsing.
- **Change Detection:** When a document at a given file path is re-indexed, its content hash is compared with the stored hash. If identical, the operation returns the cached document immediately. If modified, the previous chunks are atomically purged and re-indexed.

---

## 4. Grounded Q&A Retrieval with Citations

The `query(queryString)` method implements strict evidence-backed question answering:
1. Lexical ranking matches query terms against section contents and section titles.
2. The top scoring chunks are assembled into a synthesized answer.
3. Every answer block includes an explicit citation string:
   - Excel: `[1] (Financials.xlsx > Q3_Revenue, Sheet: Revenue)`
   - PowerPoint: `[2] (Architecture.pptx > Microservices, Slide 4)`
   - Word: `[3] (Specifications.docx > Section 4.2 Security)`
4. If no matching chunks exceed the relevance threshold, the engine returns an honest *"No relevant information found"* rather than fabricating an answer.

---

## 5. Verification & Test Evidence

The Knowledge Engine is verified by 24 unit and integration tests across three test suites:
- **`DocumentEngine.test.ts`** (8 tests): Verifies ingestion, chunking, search scoring, and disk persistence.
- **`DocumentParser.extended.test.ts`** (8 tests): Verifies DOCX, XLSX, PPTX, CSV, PDF, and Markdown format parsing.
- **`DataAnalysisTools.test.ts`** (8 tests): Verifies dataset statistics (mean, median, variance, IQR outliers, trend detection, and Pearson correlation).

All 24/24 tests pass with zero failures.

