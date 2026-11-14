/**
 * Document Chunker (Phase 3)
 *
 * Breaks parsed documents into semantic retrieval units bounded by token/character limits,
 * preserving section headings and hierarchical context for precise Q&A retrieval.
 */

import type { ParsedDocument } from './DocumentParser'

export interface DocumentChunk {
  id: string
  documentId: string
  documentTitle: string
  filePath?: string
  sectionTitle: string
  chunkIndex: number
  content: string
  charCount: number
  wordCount: number
  pageNumber?: number
  slideNumber?: number
  sheetName?: string
  cellRange?: string
  lineStart?: number
  lineEnd?: number
  citation?: string
}

export interface ChunkerOptions {
  maxChunkChars?: number
  overlapChars?: number
}

const DEFAULT_MAX_CHARS = 1200
const DEFAULT_OVERLAP_CHARS = 200

export class DocumentChunker {
  chunk(doc: ParsedDocument, options: ChunkerOptions = {}): DocumentChunk[] {
    const maxChars = options.maxChunkChars ?? DEFAULT_MAX_CHARS
    const overlap = options.overlapChars ?? DEFAULT_OVERLAP_CHARS
    const chunks: DocumentChunk[] = []
    let chunkSeq = 0

    for (const section of doc.sections) {
      const text = section.content.trim()
      if (!text) continue

      if (text.length <= maxChars) {
        chunks.push({
          id: `${doc.id}_s${chunkSeq++}`,
          documentId: doc.id,
          documentTitle: doc.title,
          filePath: doc.filePath,
          sectionTitle: section.title,
          chunkIndex: chunkSeq,
          content: text,
          charCount: text.length,
          wordCount: text.split(/\s+/).filter(Boolean).length,
          pageNumber: section.pageNumber,
          slideNumber: section.slideNumber,
          sheetName: section.sheetName,
          cellRange: section.cellRange,
          lineStart: section.lineStart,
          lineEnd: section.lineEnd,
          citation: section.citation,
        })
      } else {
        // Sliding window split on paragraph or sentence boundaries
        let start = 0
        while (start < text.length) {
          let end = Math.min(start + maxChars, text.length)
          if (end < text.length) {
            // Try to snap to sentence or line break
            const lastBreak = text.lastIndexOf('\n', end)
            const lastPeriod = text.lastIndexOf('. ', end)
            const snap = Math.max(lastBreak, lastPeriod)
            if (snap > start + Math.floor(maxChars / 2)) {
              end = snap + 1
            }
          }

          const slice = text.slice(start, end).trim()
          if (slice) {
            chunks.push({
              id: `${doc.id}_s${chunkSeq++}`,
              documentId: doc.id,
              documentTitle: doc.title,
              filePath: doc.filePath,
              sectionTitle: section.title,
              chunkIndex: chunkSeq,
              content: slice,
              charCount: slice.length,
              wordCount: slice.split(/\s+/).filter(Boolean).length,
              pageNumber: section.pageNumber,
              slideNumber: section.slideNumber,
              sheetName: section.sheetName,
              cellRange: section.cellRange,
              lineStart: section.lineStart,
              lineEnd: section.lineEnd,
              citation: section.citation,
            })
          }

          if (end >= text.length) break
          start = Math.max(start + 1, end - overlap)
        }
      }
    }

    return chunks
  }
}

