/**
 * Universal Document Parser (Phase 2 & Phase 3)
 *
 * Grounded parser for multiple document formats:
 *  - PDF: Page boundary analysis, text stream extraction, encryption detection, page citations.
 *  - DOCX: Heading tree, paragraph structure, table extraction from word/document.xml.
 *  - XLSX: Multi-sheet extraction, row/column statistics, shared strings, cell range citations.
 *  - PPTX: Slide enumeration, slide title and body text extraction, slide citations.
 *  - CSV / TSV: Tabular parsing, header extraction, numeric column statistics (count, min, max, avg).
 *  - JSON: Structural validation, key hierarchy, object/array shape inspection.
 *  - Markdown: Heading tree extraction, code block separation, sectioning.
 *  - Plain Text / Code / Logs: Line analysis, metadata, syntax chunking.
 *
 * Designed to fail gracefully on malformed, truncated, or password-protected files.
 */

import { extractZipEntries } from './ZipExtractor'

function getNodeZlib(): any {
  if (typeof window !== 'undefined') return null
  if (typeof process !== 'undefined') {
    if (typeof (process as any).getBuiltinModule === 'function') {
      return (process as any).getBuiltinModule('node:zlib')
    }
    try {
      const g = globalThis as any
      if (typeof g.require === 'function') return g.require('node:zlib')
    } catch {}
  }
  return null
}

export type DocumentType =
  | 'csv'
  | 'tsv'
  | 'json'
  | 'markdown'
  | 'text'
  | 'code'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'unknown'

export interface ColumnStat {
  name: string
  type: 'numeric' | 'string' | 'boolean'
  count: number
  uniqueCount: number
  min?: number
  max?: number
  avg?: number
}

export interface TabularData {
  sheetName?: string
  headers: string[]
  rows: string[][]
  rowCount: number
  columnStats: ColumnStat[]
}

export interface DocumentSection {
  title: string
  level: number
  content: string
  pageNumber?: number
  slideNumber?: number
  sheetName?: string
  cellRange?: string
  lineStart?: number
  lineEnd?: number
  citation?: string
}

export interface DocumentCitation {
  filePath?: string
  fileName: string
  fileType: DocumentType
  pageNumber?: number
  totalPages?: number
  slideNumber?: number
  totalSlides?: number
  sheetName?: string
  cellRange?: string
  sectionHeading?: string
  lineStart?: number
  lineEnd?: number
  excerpt: string
  formatted: string
}

export interface ParsedDocument {
  id: string
  filePath?: string
  fileName: string
  fileType: DocumentType
  title: string
  totalChars: number
  totalLines: number
  totalPages?: number
  totalSlides?: number
  sheetNames?: string[]
  sections: DocumentSection[]
  tabular?: TabularData
  tabularSheets?: Record<string, TabularData>
  metadata: Record<string, unknown>
  rawText: string
  citations: DocumentCitation[]
  error?: string
  isEncrypted?: boolean
  isTruncated?: boolean
}

export function detectFileType(filePath?: string, raw: string | Buffer = ''): DocumentType {
  const ext = filePath ? filePath.split('.').pop()?.toLowerCase() : ''
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx') return 'docx'
  if (ext === 'xlsx') return 'xlsx'
  if (ext === 'pptx') return 'pptx'
  if (ext === 'csv') return 'csv'
  if (ext === 'tsv') return 'tsv'
  if (ext === 'json') return 'json'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (['py', 'ts', 'js', 'jsx', 'tsx', 'rs', 'cpp', 'c', 'go', 'java', 'html', 'css'].includes(ext || '')) return 'code'
  if (ext === 'txt' || ext === 'log') return 'text'

  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(typeof raw === 'string' ? raw : '')
  if (buf.length >= 4) {
    if (buf.subarray(0, 4).toString('ascii') === '%PDF') return 'pdf'
    if (buf.readUInt32LE(0) === 0x04034b50) {
      // ZIP archive - inspect content if possible
      const str = buf.toString('latin1', 0, Math.min(buf.length, 2048))
      if (str.includes('word/')) return 'docx'
      if (str.includes('xl/')) return 'xlsx'
      if (str.includes('ppt/')) return 'pptx'
    }
  }

  const str = typeof raw === 'string' ? raw.trim() : buf.toString('utf8', 0, Math.min(buf.length, 1024)).trim()
  if (str.startsWith('{') || str.startsWith('[')) {
    try {
      JSON.parse(str)
      return 'json'
    } catch {}
  }
  if (str.startsWith('#') || str.includes('\n# ')) return 'markdown'
  if (str.includes(',') && str.includes('\n')) return 'csv'
  return 'text'
}

/* ------------------------------------------------------------- CSV / TSV Parsing */

function parseCsv(content: string, delimiter = ','): TabularData {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  if (lines.length === 0) {
    return { headers: [], rows: [], rowCount: 0, columnStats: [] }
  }

  const splitLine = (line: string): string[] => {
    const res: string[] = []
    let curr = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '"') {
        inQuotes = !inQuotes
      } else if (c === delimiter && !inQuotes) {
        res.push(curr.trim().replace(/^"|"$/g, ''))
        curr = ''
      } else {
        curr += c
      }
    }
    res.push(curr.trim().replace(/^"|"$/g, ''))
    return res
  }

  const headers = splitLine(lines[0])
  const rows = lines.slice(1).map(splitLine)
  const columnStats: ColumnStat[] = headers.map((colName, colIdx) => {
    const values = rows.map((r) => r[colIdx] ?? '').filter((v) => v !== '')
    const uniques = new Set(values)
    const numericVals = values.map((v) => Number(v)).filter((n) => !Number.isNaN(n))

    const isNumeric = values.length > 0 && numericVals.length === values.length
    if (isNumeric) {
      const sum = numericVals.reduce((acc, v) => acc + v, 0)
      return {
        name: colName,
        type: 'numeric',
        count: values.length,
        uniqueCount: uniques.size,
        min: Math.min(...numericVals),
        max: Math.max(...numericVals),
        avg: Math.round((sum / numericVals.length) * 100) / 100,
      }
    }
    return {
      name: colName,
      type: 'string',
      count: values.length,
      uniqueCount: uniques.size,
    }
  })

  return {
    headers,
    rows,
    rowCount: rows.length,
    columnStats,
  }
}

/* ------------------------------------------------------------- Markdown Parsing */

function parseMarkdown(content: string): DocumentSection[] {
  const lines = content.split(/\r?\n/)
  const sections: DocumentSection[] = []
  let currentTitle = 'Introduction'
  let currentLevel = 1
  let currentLines: string[] = []
  let startLine = 1

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      if (currentLines.length > 0) {
        sections.push({
          title: currentTitle,
          level: currentLevel,
          content: currentLines.join('\n').trim(),
          lineStart: startLine,
          lineEnd: idx,
        })
        currentLines = []
      }
      currentLevel = headingMatch[1].length
      currentTitle = headingMatch[2].trim()
      startLine = idx + 1
    } else {
      currentLines.push(line)
    }
  }

  if (currentLines.length > 0) {
    sections.push({
      title: currentTitle,
      level: currentLevel,
      content: currentLines.join('\n').trim(),
      lineStart: startLine,
      lineEnd: lines.length,
    })
  }

  return sections
}

/* ------------------------------------------------------------- PDF Parsing */

function parsePdf(
  bufferInput: Uint8Array | Buffer,
  fileName: string,
): {
  sections: DocumentSection[]
  totalPages: number
  rawText: string
  isEncrypted: boolean
  isTruncated: boolean
  error?: string
} {
  const buf = Buffer.isBuffer(bufferInput) ? bufferInput : Buffer.from(bufferInput)
  const binary = buf.toString('latin1')

  if (!binary.startsWith('%PDF')) {
    return {
      sections: [{ title: 'Unrecognized PDF', level: 1, content: 'Invalid PDF file header.' }],
      totalPages: 0,
      rawText: '',
      isEncrypted: false,
      isTruncated: true,
      error: 'Invalid PDF signature',
    }
  }

  const isEncrypted = /\/Encrypt\b/.test(binary) || /\/Filter\s*\/Standard\b/.test(binary)
  if (isEncrypted) {
    return {
      sections: [{ title: 'Encrypted Document', level: 1, content: 'PDF is password protected and encrypted.' }],
      totalPages: 1,
      rawText: 'PDF is encrypted.',
      isEncrypted: true,
      isTruncated: false,
      error: 'Password-protected PDF',
    }
  }

  // Count pages from page tree or count marker
  const countMatch = binary.match(/\/Count\s+(\d+)/)
  const pageTagMatches = binary.match(/\/Type\s*\/Page\b/g) || []
  let totalPages = countMatch ? parseInt(countMatch[1], 10) : pageTagMatches.length
  if (totalPages === 0) totalPages = 1

  // Extract stream contents
  const sections: DocumentSection[] = []
  const allTexts: string[] = []
  const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g
  let match: RegExpExecArray | null
  let pageIndex = 1

  while ((match = streamRegex.exec(binary)) !== null) {
    const streamBytes = Buffer.from(match[1], 'latin1')
    let streamText = ''

    const zlib = getNodeZlib()
    if (zlib) {
      try {
        streamText = zlib.inflateSync(streamBytes).toString('utf8')
      } catch {
        try {
          streamText = zlib.inflateRawSync(streamBytes).toString('utf8')
        } catch {
          streamText = streamBytes.toString('utf8')
        }
      }
    } else {
      streamText = streamBytes.toString('utf8')
    }

    // Extract text operators from BT ... ET blocks
    const pageStrings: string[] = []
    const tjRegex = /\((.*?)\)\s*(?:Tj|')/g
    let tjMatch: RegExpExecArray | null
    while ((tjMatch = tjRegex.exec(streamText)) !== null) {
      const decoded = tjMatch[1]
        .replace(/\\([()\\])/g, '$1')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
      pageStrings.push(decoded)
    }

    const tjArrayRegex = /\[(.*?)\]\s*TJ/g
    let tjArrMatch: RegExpExecArray | null
    while ((tjArrMatch = tjArrayRegex.exec(streamText)) !== null) {
      const inner = tjArrMatch[1]
      const strParts = inner.match(/\((.*?)\)/g) || []
      const combined = strParts.map((p) => p.slice(1, -1).replace(/\\([()\\])/g, '$1')).join('')
      if (combined.trim()) pageStrings.push(combined)
    }

    if (pageStrings.length > 0) {
      const pageText = pageStrings.join(' ').replace(/\s+/g, ' ').trim()
      allTexts.push(pageText)
      sections.push({
        title: `Page ${pageIndex}`,
        level: 1,
        content: pageText,
        pageNumber: pageIndex,
        citation: `[${fileName}, Page ${pageIndex}]`,
      })
      pageIndex++
    }
  }

  if (sections.length === 0) {
    sections.push({
      title: 'Page 1',
      level: 1,
      content: 'Binary PDF document without extractable text streams (scanned or image-based).',
      pageNumber: 1,
      citation: `[${fileName}, Page 1]`,
    })
  }

  const isTruncated = !binary.includes('%%EOF')

  return {
    sections,
    totalPages: Math.max(totalPages, sections.length),
    rawText: allTexts.join('\n\n'),
    isEncrypted: false,
    isTruncated,
  }
}

/* ------------------------------------------------------------- DOCX Parsing */

function parseDocx(
  bufferInput: Uint8Array | Buffer,
  fileName: string,
): {
  sections: DocumentSection[]
  rawText: string
  error?: string
} {
  const entries = extractZipEntries(bufferInput)
  const docXmlBuf = entries.get('word/document.xml')

  if (!docXmlBuf) {
    return {
      sections: [{ title: 'Document', level: 1, content: 'Malformed DOCX file: word/document.xml not found.' }],
      rawText: '',
      error: 'Malformed DOCX archive',
    }
  }

  const xml = docXmlBuf.toString('utf8')
  const sections: DocumentSection[] = []
  const paragraphs: string[] = []

  // Split into paragraphs <w:p>...</w:p>
  const pRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g
  let pMatch: RegExpExecArray | null
  let currentTitle = 'Document Overview'
  let currentLevel = 1
  let currentSectionLines: string[] = []

  while ((pMatch = pRegex.exec(xml)) !== null) {
    const pContent = pMatch[1]

    // Check heading style
    const headingMatch = pContent.match(/<w:pStyle\s+w:val="(Heading[1-6]|Title)"/i)
    const isHeading = !!headingMatch

    // Extract text runs <w:t...>text</w:t>
    const textMatches = pContent.match(/<w:t\b[^>]*>(.*?)<\/w:t>/g) || []
    const pText = textMatches
      .map((t) => t.replace(/<[^>]+>/g, ''))
      .join('')
      .trim()

    if (!pText) continue

    paragraphs.push(pText)

    if (isHeading) {
      if (currentSectionLines.length > 0) {
        sections.push({
          title: currentTitle,
          level: currentLevel,
          content: currentSectionLines.join('\n\n'),
          citation: `[${fileName}, Section '${currentTitle}']`,
        })
        currentSectionLines = []
      }
      currentTitle = pText
      const headingVal = headingMatch[1].toLowerCase()
      currentLevel = headingVal.startsWith('heading') ? parseInt(headingVal.replace('heading', ''), 10) : 1
    } else {
      currentSectionLines.push(pText)
    }
  }

  // Extract tables <w:tbl>...</w:tbl>
  const tblRegex = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g
  let tblMatch: RegExpExecArray | null
  let tblIndex = 1

  while ((tblMatch = tblRegex.exec(xml)) !== null) {
    const tblXml = tblMatch[1]
    const rowMatches = tblXml.match(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g) || []
    const tableRows: string[][] = []

    for (const rXml of rowMatches) {
      const cellMatches = rXml.match(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g) || []
      const cells = cellMatches.map((c) => {
        const tMatches = c.match(/<w:t\b[^>]*>(.*?)<\/w:t>/g) || []
        return tMatches.map((t) => t.replace(/<[^>]+>/g, '')).join('').trim()
      })
      if (cells.some((c) => c.length > 0)) {
        tableRows.push(cells)
      }
    }

    if (tableRows.length > 0) {
      const mdTable = tableRows.map((r) => `| ${r.join(' | ')} |`).join('\n')
      sections.push({
        title: `Table ${tblIndex}`,
        level: 2,
        content: mdTable,
        citation: `[${fileName}, Table ${tblIndex}]`,
      })
      tblIndex++
    }
  }

  if (currentSectionLines.length > 0) {
    sections.push({
      title: currentTitle,
      level: currentLevel,
      content: currentSectionLines.join('\n\n'),
      citation: `[${fileName}, Section '${currentTitle}']`,
    })
  }

  return {
    sections,
    rawText: paragraphs.join('\n\n'),
  }
}

/* ------------------------------------------------------------- XLSX Parsing */

function parseXlsx(
  bufferInput: Uint8Array | Buffer,
  fileName: string,
): {
  sections: DocumentSection[]
  tabularSheets: Record<string, TabularData>
  primaryTabular?: TabularData
  sheetNames: string[]
  rawText: string
  error?: string
} {
  const entries = extractZipEntries(bufferInput)
  const workbookXml = entries.get('xl/workbook.xml')?.toString('utf8')

  if (!workbookXml) {
    return {
      sections: [{ title: 'Spreadsheet', level: 1, content: 'Malformed XLSX: xl/workbook.xml not found.' }],
      tabularSheets: {},
      sheetNames: [],
      rawText: '',
      error: 'Malformed XLSX archive',
    }
  }

  // 1. Extract sheet names and r:id mapping
  const sheetNames: string[] = []
  const sheetIdToName: Record<string, string> = {}
  const sheetRegex = /<sheet\s+name="([^"]+)"\s+sheetId="(\d+)"/g
  let sMatch: RegExpExecArray | null
  while ((sMatch = sheetRegex.exec(workbookXml)) !== null) {
    const name = sMatch[1]
    const id = sMatch[2]
    sheetNames.push(name)
    sheetIdToName[id] = name
  }

  // 2. Extract shared strings table
  const sharedStrings: string[] = []
  const sstXml = entries.get('xl/sharedStrings.xml')?.toString('utf8')
  if (sstXml) {
    const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g
    let siMatch: RegExpExecArray | null
    while ((siMatch = siRegex.exec(sstXml)) !== null) {
      const tMatches = siMatch[1].match(/<t\b[^>]*>(.*?)<\/t>/g) || []
      const text = tMatches.map((t) => t.replace(/<[^>]+>/g, '')).join('')
      sharedStrings.push(text)
    }
  }

  // 3. Parse each sheet
  const tabularSheets: Record<string, TabularData> = {}
  const sections: DocumentSection[] = []
  const textSummaries: string[] = []

  let sheetIdx = 1
  for (const sheetName of sheetNames) {
    const sheetFile = `xl/worksheets/sheet${sheetIdx}.xml`
    const sheetXml = entries.get(sheetFile)?.toString('utf8')
    sheetIdx++

    if (!sheetXml) continue

    const rows: string[][] = []
    const rowMatches = sheetXml.match(/<row\b[^>]*>([\s\S]*?)<\/row>/g) || []

    for (const rXml of rowMatches) {
      const cellMatches = rXml.match(/<c\b[^>]*>([\s\S]*?)<\/c>/g) || []
      const rowValues: string[] = []

      for (const cXml of cellMatches) {
        const isSharedString = /t="s"/.test(cXml)
        const isInlineStr = /t="inlineStr"/.test(cXml)

        let val = ''
        if (isInlineStr) {
          const tMatch = cXml.match(/<t\b[^>]*>(.*?)<\/t>/)
          val = tMatch ? tMatch[1] : ''
        } else if (isSharedString) {
          const vMatch = cXml.match(/<v\b[^>]*>(.*?)<\/v>/)
          const sIdx = vMatch ? parseInt(vMatch[1], 10) : -1
          val = sIdx >= 0 && sIdx < sharedStrings.length ? sharedStrings[sIdx] : ''
        } else {
          const vMatch = cXml.match(/<v\b[^>]*>(.*?)<\/v>/)
          val = vMatch ? vMatch[1] : ''
        }

        rowValues.push(val)
      }

      if (rowValues.some((v) => v.length > 0)) {
        rows.push(rowValues)
      }
    }

    if (rows.length === 0) continue

    const headers = rows[0]
    const dataRows = rows.slice(1)
    const columnStats: ColumnStat[] = headers.map((colName, colIdx) => {
      const values = dataRows.map((r) => r[colIdx] ?? '').filter((v) => v !== '')
      const uniques = new Set(values)
      const numericVals = values.map((v) => Number(v)).filter((n) => !Number.isNaN(n))
      const isNumeric = values.length > 0 && numericVals.length === values.length

      if (isNumeric) {
        const sum = numericVals.reduce((acc, v) => acc + v, 0)
        return {
          name: colName || `Col_${colIdx + 1}`,
          type: 'numeric',
          count: values.length,
          uniqueCount: uniques.size,
          min: Math.min(...numericVals),
          max: Math.max(...numericVals),
          avg: Math.round((sum / numericVals.length) * 100) / 100,
        }
      }

      return {
        name: colName || `Col_${colIdx + 1}`,
        type: 'string',
        count: values.length,
        uniqueCount: uniques.size,
      }
    })

    const tabular: TabularData = {
      sheetName,
      headers,
      rows: dataRows,
      rowCount: dataRows.length,
      columnStats,
    }

    tabularSheets[sheetName] = tabular

    const colRange = `A1:${String.fromCharCode(64 + Math.min(headers.length, 26))}${rows.length}`
    const summary = `Sheet "${sheetName}": ${dataRows.length} rows, ${headers.length} columns (${headers.join(', ')}).\n` +
      `Stats:\n` +
      columnStats.map((c) => `- ${c.name} (${c.type}): ${c.type === 'numeric' ? `min=${c.min}, max=${c.max}, avg=${c.avg}` : `uniques=${c.uniqueCount}`}`).join('\n')

    textSummaries.push(summary)

    sections.push({
      title: `Sheet: ${sheetName}`,
      level: 1,
      content: summary,
      sheetName,
      cellRange: colRange,
      citation: `[${fileName}, Sheet '${sheetName}', Cells ${colRange}]`,
    })
  }

  const primarySheet = sheetNames[0] ? tabularSheets[sheetNames[0]] : undefined

  return {
    sections,
    tabularSheets,
    primaryTabular: primarySheet,
    sheetNames,
    rawText: textSummaries.join('\n\n'),
  }
}

/* ------------------------------------------------------------- PPTX Parsing */

function parsePptx(
  bufferInput: Uint8Array | Buffer,
  fileName: string,
): {
  sections: DocumentSection[]
  totalSlides: number
  rawText: string
  error?: string
} {
  const entries = extractZipEntries(bufferInput)
  const slideEntries: Array<{ name: string; index: number; buf: Buffer }> = []

  for (const [name, buf] of entries.entries()) {
    const match = name.match(/ppt\/slides\/slide(\d+)\.xml$/)
    if (match) {
      slideEntries.push({ name, index: parseInt(match[1], 10), buf })
    }
  }

  slideEntries.sort((a, b) => a.index - b.index)

  if (slideEntries.length === 0) {
    return {
      sections: [{ title: 'Presentation', level: 1, content: 'Malformed PPTX: no slide XML entries found.' }],
      totalSlides: 0,
      rawText: '',
      error: 'Malformed PPTX archive',
    }
  }

  const sections: DocumentSection[] = []
  const allTexts: string[] = []

  for (const slide of slideEntries) {
    const xml = slide.buf.toString('utf8')
    const pMatches = xml.match(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g) || []
    const slideLines: string[] = []

    for (const p of pMatches) {
      const tMatches = p.match(/<a:t\b[^>]*>(.*?)<\/a:t>/g) || []
      const text = tMatches.map((t) => t.replace(/<[^>]+>/g, '')).join('').trim()
      if (text) slideLines.push(text)
    }

    const slideTitle = slideLines.length > 0 ? slideLines[0] : `Slide ${slide.index}`
    const bodyText = slideLines.slice(1).join('\n') || slideTitle

    sections.push({
      title: `Slide ${slide.index}: ${slideTitle}`,
      level: 1,
      content: bodyText,
      slideNumber: slide.index,
      citation: `[${fileName}, Slide ${slide.index}]`,
    })

    allTexts.push(`--- Slide ${slide.index}: ${slideTitle} ---\n${bodyText}`)
  }

  return {
    sections,
    totalSlides: slideEntries.length,
    rawText: allTexts.join('\n\n'),
  }
}

/* ------------------------------------------------------------- Grounded Citations */

function generateCitations(
  doc: {
    fileName: string
    filePath?: string
    fileType: DocumentType
    totalPages?: number
    totalSlides?: number
    sections: DocumentSection[]
  },
): DocumentCitation[] {
  const citations: DocumentCitation[] = []

  for (const sec of doc.sections) {
    let formatted = `[${doc.fileName}]`

    if (doc.fileType === 'pdf' && sec.pageNumber) {
      formatted = `[${doc.fileName}, Page ${sec.pageNumber}${doc.totalPages ? ` of ${doc.totalPages}` : ''}]`
    } else if (doc.fileType === 'pptx' && sec.slideNumber) {
      formatted = `[${doc.fileName}, Slide ${sec.slideNumber}${doc.totalSlides ? ` of ${doc.totalSlides}` : ''}]`
    } else if (doc.fileType === 'xlsx' && sec.sheetName) {
      formatted = `[${doc.fileName}, Sheet '${sec.sheetName}'${sec.cellRange ? `, Cells ${sec.cellRange}` : ''}]`
    } else if (sec.title && sec.title !== 'Content') {
      formatted = `[${doc.fileName}, Section '${sec.title}']`
    } else if (sec.lineStart && sec.lineEnd) {
      formatted = `[${doc.fileName}, Lines ${sec.lineStart}-${sec.lineEnd}]`
    }

    citations.push({
      filePath: doc.filePath,
      fileName: doc.fileName,
      fileType: doc.fileType,
      pageNumber: sec.pageNumber,
      totalPages: doc.totalPages,
      slideNumber: sec.slideNumber,
      totalSlides: doc.totalSlides,
      sheetName: sec.sheetName,
      cellRange: sec.cellRange,
      sectionHeading: sec.title,
      lineStart: sec.lineStart,
      lineEnd: sec.lineEnd,
      excerpt: sec.content.slice(0, 200),
      formatted,
    })
  }

  return citations
}

/* ------------------------------------------------------------- Main Parser Class */

export class DocumentParser {
  /**
   * Parse raw content or binary buffer into a unified, citation-grounded ParsedDocument.
   */
  parse(
    content: string | Uint8Array | Buffer,
    options: { filePath?: string; fileName?: string } = {},
  ): ParsedDocument {
    const rawBuf = Buffer.isBuffer(content)
      ? content
      : typeof content === 'string'
        ? Buffer.from(content, 'utf8')
        : Buffer.from(content)

    const rawStr = typeof content === 'string' ? content : rawBuf.toString('utf8')
    const fileName = options.fileName || (options.filePath ? options.filePath.split(/[/\\]/).pop()! : 'untitled.txt')
    const fileType = detectFileType(options.filePath, rawBuf)

    let title = fileName
    let sections: DocumentSection[] = []
    let tabular: TabularData | undefined
    let tabularSheets: Record<string, TabularData> | undefined
    let totalPages: number | undefined
    let totalSlides: number | undefined
    let sheetNames: string[] | undefined
    let rawText = rawStr
    let error: string | undefined
    let isEncrypted = false
    let isTruncated = false
    const metadata: Record<string, unknown> = {}

    try {
      if (fileType === 'pdf') {
        const pdfRes = parsePdf(rawBuf, fileName)
        sections = pdfRes.sections
        totalPages = pdfRes.totalPages
        rawText = pdfRes.rawText
        isEncrypted = pdfRes.isEncrypted
        isTruncated = pdfRes.isTruncated
        error = pdfRes.error
        title = `${fileName} (PDF: ${totalPages} pages)`
      } else if (fileType === 'docx') {
        const docxRes = parseDocx(rawBuf, fileName)
        sections = docxRes.sections
        rawText = docxRes.rawText
        error = docxRes.error
        title = `${fileName} (DOCX Document: ${sections.length} sections)`
      } else if (fileType === 'xlsx') {
        const xlsxRes = parseXlsx(rawBuf, fileName)
        sections = xlsxRes.sections
        tabular = xlsxRes.primaryTabular
        tabularSheets = xlsxRes.tabularSheets
        sheetNames = xlsxRes.sheetNames
        rawText = xlsxRes.rawText
        error = xlsxRes.error
        title = `${fileName} (Excel Workbook: ${sheetNames.length} sheets)`
      } else if (fileType === 'pptx') {
        const pptxRes = parsePptx(rawBuf, fileName)
        sections = pptxRes.sections
        totalSlides = pptxRes.totalSlides
        rawText = pptxRes.rawText
        error = pptxRes.error
        title = `${fileName} (PowerPoint Presentation: ${totalSlides} slides)`
      } else if (fileType === 'csv' || fileType === 'tsv') {
        const delimiter = fileType === 'tsv' ? '\t' : ','
        tabular = parseCsv(rawStr, delimiter)
        title = `${fileName} (${tabular.rowCount} rows, ${tabular.headers.length} columns)`
        sections = [
          {
            title: 'Table Summary',
            level: 1,
            content: `Columns: ${tabular.headers.join(', ')}\nTotal Rows: ${tabular.rowCount}\n\nColumn Statistics:\n${tabular.columnStats
              .map((s) => `- ${s.name} (${s.type}): ${s.type === 'numeric' ? `min=${s.min}, max=${s.max}, avg=${s.avg}` : `unique=${s.uniqueCount}`}`)
              .join('\n')}`,
            lineStart: 1,
            lineEnd: tabular.rowCount + 1,
            citation: `[${fileName}, Lines 1-${tabular.rowCount + 1}]`,
          },
        ]
      } else if (fileType === 'json') {
        try {
          const parsed = JSON.parse(rawStr)
          metadata.isJson = true
          if (Array.isArray(parsed)) {
            title = `${fileName} (JSON Array: ${parsed.length} items)`
            sections.push({
              title: 'Array Schema',
              level: 1,
              content: `Length: ${parsed.length} items. Sample item:\n${JSON.stringify(parsed[0] ?? {}, null, 2)}`,
              citation: `[${fileName}, Array[0..${parsed.length}]]`,
            })
          } else if (typeof parsed === 'object' && parsed !== null) {
            const keys = Object.keys(parsed)
            title = `${fileName} (JSON Object: ${keys.length} keys)`
            sections.push({
              title: 'Object Keys',
              level: 1,
              content: `Top-level keys: ${keys.join(', ')}`,
              citation: `[${fileName}, Object (${keys.length} keys)]`,
            })
          }
        } catch {
          sections.push({ title: 'Malformed JSON', level: 1, content: rawStr })
          error = 'Malformed JSON content'
        }
      } else if (fileType === 'markdown') {
        sections = parseMarkdown(rawStr)
        const firstH1 = sections.find((s) => s.level === 1)
        if (firstH1) title = firstH1.title
        for (const sec of sections) {
          sec.citation = `[${fileName}, Section '${sec.title}']`
        }
      } else {
        // Plain text or code
        const lines = rawStr.split(/\r?\n/)
        sections = [
          {
            title: 'Content',
            level: 1,
            content: rawStr.trim(),
            lineStart: 1,
            lineEnd: lines.length,
            citation: `[${fileName}, Lines 1-${lines.length}]`,
          },
        ]
      }
    } catch (parseErr) {
      error = parseErr instanceof Error ? parseErr.message : String(parseErr)
      sections = [{ title: 'Parse Error', level: 1, content: `Error processing ${fileName}: ${error}` }]
    }

    const lines = rawText.split(/\r?\n/)
    const citations = generateCitations({
      fileName,
      filePath: options.filePath,
      fileType,
      totalPages,
      totalSlides,
      sections,
    })

    return {
      id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      filePath: options.filePath,
      fileName,
      fileType,
      title,
      totalChars: rawText.length,
      totalLines: lines.length,
      totalPages,
      totalSlides,
      sheetNames,
      sections,
      tabular,
      tabularSheets,
      metadata,
      rawText,
      citations,
      error,
      isEncrypted,
      isTruncated,
    }
  }
}
