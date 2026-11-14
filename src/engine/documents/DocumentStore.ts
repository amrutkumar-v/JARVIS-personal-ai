/**
 * Document Store & Grounded Q&A Retrieval Engine (Phase 2 & Phase 3)
 *
 * Grounded indexing, persistent disk index, change detection, and citation-backed search.
 * Combines term overlap and lexical ranking to provide verified snippets and grounded citations.
 */

import { DocumentParser, type ParsedDocument } from './DocumentParser'
import { DocumentChunker, type DocumentChunk } from './DocumentChunker'

function getNodeModule(name: string): any {
  if (typeof window !== 'undefined') return null
  if (typeof process !== 'undefined') {
    if (typeof (process as any).getBuiltinModule === 'function') {
      return (process as any).getBuiltinModule(name)
    }
    try {
      const g = globalThis as any
      if (typeof g.require === 'function') return g.require(name)
    } catch {}
  }
  return null
}

function getNodeFs(): any {
  return getNodeModule('node:fs')
}

function getNodePath(): any {
  return getNodeModule('node:path')
}

function getNodeCrypto(): any {
  return getNodeModule('node:crypto')
}

export interface DocumentSearchResult {
  chunk: DocumentChunk
  score: number
  matchedTerms: string[]
  citation?: string
}

export interface DocumentAnswer {
  query: string
  answer: string
  sources: Array<{
    documentTitle: string
    sectionTitle: string
    snippet: string
    citation?: string
  }>
}

export interface DocumentStoreOptions {
  indexPath?: string
  autoPersist?: boolean
}

interface StoredIndexFormat {
  version: number
  updatedAt: string
  documents: Array<{
    doc: ParsedDocument
    contentHash: string
    indexedAt: string
  }>
}

const DEFAULT_INDEX_FILE = 'server/data/index/documents.json'

function computeContentHash(content: string | Uint8Array | Buffer): string {
  const cryptoMod = getNodeCrypto()
  if (cryptoMod) {
    const hash = cryptoMod.createHash('sha256')
    if (typeof content === 'string') {
      hash.update(content, 'utf8')
    } else {
      hash.update(content)
    }
    return hash.digest('hex')
  }

  // Fast deterministic FNV-1a fallback for browser/environments without node:crypto
  let h1 = 0x811c9dc5
  const str = typeof content === 'string' ? content : content.toString()
  for (let i = 0; i < str.length; i++) {
    h1 ^= str.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193)
  }
  return (h1 >>> 0).toString(16).padStart(8, '0')
}

export class DocumentStore {
  private documents = new Map<string, ParsedDocument>()
  private documentHashes = new Map<string, string>() // docId -> hash
  private chunks: DocumentChunk[] = []
  private readonly parser = new DocumentParser()
  private readonly chunker = new DocumentChunker()
  private readonly indexPath: string
  private readonly autoPersist: boolean

  constructor(options: DocumentStoreOptions = {}) {
    this.indexPath = options.indexPath ?? DEFAULT_INDEX_FILE
    this.autoPersist = options.autoPersist ?? true
    this.loadFromDisk()
  }

  /**
   * Ingest a document from raw text or structured file with change detection.
   */
  ingest(
    content: string | Uint8Array | Buffer,
    options: { filePath?: string; fileName?: string } = {},
  ): ParsedDocument {
    const hash = computeContentHash(content)

    // Change detection: If an identical file exists at filePath with same hash, reuse it
    if (options.filePath) {
      const existing = this.findDocumentByPath(options.filePath)
      if (existing) {
        const existingHash = this.documentHashes.get(existing.id)
        if (existingHash === hash) {
          return existing
        }
        // If content changed, remove existing version before adding new
        this.removeDocument(existing.id)
      }
    }

    const doc = this.parser.parse(content, options)
    this.addDocument(doc, hash)
    return doc
  }

  addDocument(doc: ParsedDocument, contentHash?: string): void {
    this.documents.set(doc.id, doc)
    const hash = contentHash ?? computeContentHash(doc.rawText)
    this.documentHashes.set(doc.id, hash)

    const newChunks = this.chunker.chunk(doc)
    this.chunks.push(...newChunks)

    if (this.autoPersist) {
      this.persistToDisk()
    }
  }

  removeDocument(id: string): boolean {
    const existed = this.documents.delete(id)
    if (existed) {
      this.documentHashes.delete(id)
      this.chunks = this.chunks.filter((c) => c.documentId !== id)
      if (this.autoPersist) {
        this.persistToDisk()
      }
    }
    return existed
  }

  getDocument(id: string): ParsedDocument | undefined {
    return this.documents.get(id)
  }

  findDocumentByPath(filePath: string): ParsedDocument | undefined {
    const norm = filePath.replace(/\\/g, '/').toLowerCase()
    for (const doc of this.documents.values()) {
      if (doc.filePath && doc.filePath.replace(/\\/g, '/').toLowerCase() === norm) {
        return doc
      }
    }
    return undefined
  }

  listDocuments(): ParsedDocument[] {
    return Array.from(this.documents.values())
  }

  clear(): void {
    this.documents.clear()
    this.documentHashes.clear()
    this.chunks = []
    if (this.autoPersist) {
      this.persistToDisk()
    }
  }

  /**
   * Search chunks using grounded lexical scoring and citations.
   */
  search(
    query: string,
    options: { documentId?: string; limit?: number } = {},
  ): DocumentSearchResult[] {
    const limit = options.limit ?? 5
    const terms = query
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 2)

    if (terms.length === 0) return []

    const candidates = options.documentId
      ? this.chunks.filter((c) => c.documentId === options.documentId)
      : this.chunks

    const scored: DocumentSearchResult[] = []

    for (const chunk of candidates) {
      const lower = chunk.content.toLowerCase()
      const titleLower = chunk.sectionTitle.toLowerCase()
      let score = 0
      const matchedTerms: string[] = []

      for (const t of terms) {
        if (lower.includes(t)) {
          score += 1.0
          matchedTerms.push(t)
        }
        if (titleLower.includes(t)) {
          score += 2.0 // Title matches weighted higher
        }
      }

      // Exact phrase bonus
      if (lower.includes(query.toLowerCase())) {
        score += 3.0
      }

      if (score > 0) {
        scored.push({
          chunk,
          score,
          matchedTerms,
          citation: chunk.citation,
        })
      }
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  /**
   * Grounded Question-Answering across documents with verified citations.
   */
  query(query: string, options: { documentId?: string } = {}): DocumentAnswer {
    const matches = this.search(query, { documentId: options.documentId, limit: 3 })
    if (matches.length === 0) {
      return {
        query,
        answer: 'No relevant information found in the ingested documents for this query.',
        sources: [],
      }
    }

    const sources = matches.map((m) => ({
      documentTitle: m.chunk.documentTitle,
      sectionTitle: m.chunk.sectionTitle,
      snippet: m.chunk.content.slice(0, 300),
      citation: m.chunk.citation,
    }))

    const answerLines = matches.map((m, i) => {
      const citeStr = m.chunk.citation ? ` ${m.chunk.citation}` : ''
      return `[${i + 1}] (${m.chunk.documentTitle} > ${m.chunk.sectionTitle}${citeStr}):\n${m.chunk.content.slice(0, 400)}${m.chunk.content.length > 400 ? '...' : ''}`
    })

    return {
      query,
      answer: `Found ${matches.length} matching section(s):\n\n${answerLines.join('\n\n')}`,
      sources,
    }
  }

  /* ------------------------------------------------------------- Disk Persistence */

  persistToDisk(): boolean {
    const fsMod = getNodeFs()
    const pathMod = getNodePath()
    if (!fsMod || !pathMod) return false

    try {
      const dir = pathMod.dirname(this.indexPath)
      if (!fsMod.existsSync(dir)) {
        fsMod.mkdirSync(dir, { recursive: true })
      }

      const payload: StoredIndexFormat = {
        version: 1,
        updatedAt: new Date().toISOString(),
        documents: Array.from(this.documents.values()).map((doc) => ({
          doc,
          contentHash: this.documentHashes.get(doc.id) || '',
          indexedAt: new Date().toISOString(),
        })),
      }

      fsMod.writeFileSync(this.indexPath, JSON.stringify(payload, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  }

  loadFromDisk(): boolean {
    const fsMod = getNodeFs()
    if (!fsMod) return false

    try {
      if (!fsMod.existsSync(this.indexPath)) return false
      const raw = fsMod.readFileSync(this.indexPath, 'utf8')
      const data = JSON.parse(raw) as StoredIndexFormat

      if (!data || !Array.isArray(data.documents)) return false

      this.documents.clear()
      this.documentHashes.clear()
      this.chunks = []

      for (const entry of data.documents) {
        if (entry.doc && entry.doc.id) {
          this.documents.set(entry.doc.id, entry.doc)
          if (entry.contentHash) {
            this.documentHashes.set(entry.doc.id, entry.contentHash)
          }
          const docChunks = this.chunker.chunk(entry.doc)
          this.chunks.push(...docChunks)
        }
      }

      return true
    } catch {
      return false
    }
  }
}
