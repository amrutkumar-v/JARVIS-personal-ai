import { describe, it, expect, beforeEach } from 'vitest'
import { DocumentParser } from './DocumentParser'
import { DocumentChunker } from './DocumentChunker'
import { DocumentStore } from './DocumentStore'
import { DocParseTool, DocSummarizeTool, DocQueryTool } from './DocumentTools'

describe('Document Analysis & Local Knowledge Ingestion (Phase 3)', () => {
  let parser: DocumentParser
  let chunker: DocumentChunker
  let store: DocumentStore

  beforeEach(() => {
    parser = new DocumentParser()
    chunker = new DocumentChunker()
    store = new DocumentStore()
  })

  // --------------------------------------------------------------------------
  // 1. CSV / Tabular Parsing & Statistics
  // --------------------------------------------------------------------------
  describe('DocumentParser — Tabular CSV', () => {
    it('parses CSV, computes row count, headers, and numeric column statistics', () => {
      const csv = `product,price,rating,in_stock
Laptop,1200,4.5,true
Mouse,25,4.8,true
Keyboard,75,4.2,false
Monitor,300,4.7,true`

      const doc = parser.parse(csv, { fileName: 'inventory.csv' })
      expect(doc.fileType).toBe('csv')
      expect(doc.tabular).toBeDefined()
      expect(doc.tabular?.rowCount).toBe(4)
      expect(doc.tabular?.headers).toEqual(['product', 'price', 'rating', 'in_stock'])

      const priceStat = doc.tabular?.columnStats.find((s) => s.name === 'price')
      expect(priceStat?.type).toBe('numeric')
      expect(priceStat?.min).toBe(25)
      expect(priceStat?.max).toBe(1200)
      expect(priceStat?.avg).toBe(400) // (1200+25+75+300)/4 = 400
    })
  })

  // --------------------------------------------------------------------------
  // 2. Markdown Parsing & Sectioning
  // --------------------------------------------------------------------------
  describe('DocumentParser — Markdown', () => {
    it('extracts heading tree and section contents', () => {
      const md = `# Project Specification

This is the system overview.

## Architecture

The system uses a persistent DAG execution loop with deterministic checkpoints.

## Safety & Security

Default-deny permissions protect sensitive operations.`

      const doc = parser.parse(md, { fileName: 'spec.md' })
      expect(doc.fileType).toBe('markdown')
      expect(doc.sections.length).toBe(3)
      expect(doc.sections[0].title).toBe('Project Specification')
      expect(doc.sections[1].title).toBe('Architecture')
      expect(doc.sections[2].title).toBe('Safety & Security')
      expect(doc.sections[1].content).toContain('DAG execution loop')
    })
  })

  // --------------------------------------------------------------------------
  // 3. Document Chunking
  // --------------------------------------------------------------------------
  describe('DocumentChunker', () => {
    it('chunks documents with section context and token bounds', () => {
      const longText = 'Sentence one with facts. '.repeat(100)
      const doc = parser.parse(`# Big Section\n\n${longText}`, { fileName: 'large.md' })

      const chunks = chunker.chunk(doc, { maxChunkChars: 500, overlapChars: 50 })
      expect(chunks.length).toBeGreaterThan(1)
      for (const chunk of chunks) {
        expect(chunk.sectionTitle).toBe('Big Section')
        expect(chunk.charCount).toBeLessThanOrEqual(550)
      }
    })
  })

  // --------------------------------------------------------------------------
  // 4. DocumentStore & Lexical Search
  // --------------------------------------------------------------------------
  describe('DocumentStore Q&A', () => {
    it('indexes documents and answers queries with cited snippets', () => {
      store.ingest(
        `# Architecture Overview

JARVIS uses an autonomous background loop with 7 DevEngine operations.

# Checkpointing

Verified checkpoints are persisted to disk using SQLite and SHA-256 hashes.`,
        { fileName: 'architecture.md' },
      )

      const result = store.query('How are checkpoints persisted?')
      expect(result.sources.length).toBeGreaterThan(0)
      expect(result.answer).toContain('Checkpointing')
      expect(result.answer).toContain('SHA-256')
    })
  })

  // --------------------------------------------------------------------------
  // 5. Document Tools Execution
  // --------------------------------------------------------------------------
  describe('Document Tools', () => {
    it('executes doc.parse, doc.summarize, and doc.query tools cleanly', async () => {
      const parseTool = new DocParseTool(store)
      const summarizeTool = new DocSummarizeTool(store)
      const queryTool = new DocQueryTool(store)

      const parseRes = await parseTool.execute({
        query: 'parse',
        params: {
          content: 'name,age,score\nAlice,30,95\nBob,25,88\nCharlie,35,92',
          fileName: 'users.csv',
        },
      })
      expect(parseRes.ok).toBe(true)
      expect(parseRes.message).toContain('Parsed CSV')

      const sumRes = await summarizeTool.execute({ query: 'summarize', params: {} })
      expect(sumRes.ok).toBe(true)
      expect(sumRes.message).toContain('Tabular Overview')
      expect(sumRes.message).toContain('**Rows:** 3')

      const qRes = await queryTool.execute({ query: 'query', params: { query: 'score statistics' } })
      expect(qRes.ok).toBe(true)
      expect(qRes.message).toContain('score')
    })
  })
})
