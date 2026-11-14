import { describe, expect, it } from 'vitest'
import * as zlib from 'node:zlib'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DocumentParser, detectFileType } from './DocumentParser'
import { DocumentStore } from './DocumentStore'

/* ------------------------------------------------------------- Synthetic Document Builders */

function buildSyntheticZip(files: Record<string, string>): Buffer {
  const localHeaders: Buffer[] = []
  const cdHeaders: Buffer[] = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const contentBuf = Buffer.from(content, 'utf8')
    const compressed = zlib.deflateRawSync(contentBuf)

    // Local Header (30 bytes + name)
    const lh = Buffer.alloc(30 + nameBuf.length)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0, 6)
    lh.writeUInt16LE(8, 8) // method 8 (deflate)
    lh.writeUInt32LE(0, 10)
    lh.writeUInt32LE(0, 14)
    lh.writeUInt32LE(compressed.length, 18)
    lh.writeUInt32LE(contentBuf.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    nameBuf.copy(lh, 30)

    const localChunk = Buffer.concat([lh, compressed])
    localHeaders.push(localChunk)

    // Central Directory Header (46 bytes + name)
    const cd = Buffer.alloc(46 + nameBuf.length)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt32LE(0, 12)
    cd.writeUInt32LE(0, 16)
    cd.writeUInt32LE(compressed.length, 20)
    cd.writeUInt32LE(contentBuf.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    nameBuf.copy(cd, 46)

    cdHeaders.push(cd)
    offset += localChunk.length
  }

  const cdBuf = Buffer.concat(cdHeaders)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localHeaders, cdBuf, eocd])
}

function buildSyntheticPdf(pages: string[], isEncrypted = false, isTruncated = false): Buffer {
  let out = '%PDF-1.4\n'
  const offsets: number[] = []

  // Catalog
  offsets.push(out.length)
  out += '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'

  // Pages
  offsets.push(out.length)
  out += `2 0 obj\n<< /Type /Pages /Count ${pages.length} >>\nendobj\n`

  for (let i = 0; i < pages.length; i++) {
    const text = pages[i]
    const streamContent = `BT /F1 12 Tf 72 712 Td (${text}) Tj ET`
    const deflated = zlib.deflateSync(Buffer.from(streamContent))

    const streamId = offsets.length + 1
    offsets.push(out.length)
    out += `${streamId} 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n${deflated.toString('latin1')}\nendstream\nendobj\n`

    const pageId = offsets.length + 1
    offsets.push(out.length)
    out += `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${streamId} 0 R >>\nendobj\n`
  }

  if (isEncrypted) {
    const encId = offsets.length + 1
    offsets.push(out.length)
    out += `${encId} 0 obj\n<< /Filter /Standard /V 2 /R 3 /O (hash) /U (hash) >>\nendobj\n`
  }

  if (isTruncated) {
    return Buffer.from(out, 'latin1')
  }

  const xrefOffset = out.length
  out += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    out += off.toString().padStart(10, '0') + ' 00000 n \n'
  }
  const encryptStr = isEncrypted ? ' /Encrypt 5 0 R' : ''
  out += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R${encryptStr} >>\nstartxref\n${xrefOffset}\n%%EOF`
  return Buffer.from(out, 'latin1')
}

/* ------------------------------------------------------------- Test Suites */

describe('Phase 2 — Complete Document and File Intelligence', () => {
  const parser = new DocumentParser()

  describe('File Type Detection', () => {
    it('detects extensions accurately', () => {
      expect(detectFileType('test.pdf')).toBe('pdf')
      expect(detectFileType('report.docx')).toBe('docx')
      expect(detectFileType('data.xlsx')).toBe('xlsx')
      expect(detectFileType('presentation.pptx')).toBe('pptx')
      expect(detectFileType('table.csv')).toBe('csv')
      expect(detectFileType('notes.md')).toBe('markdown')
    })
  })

  describe('PDF Parsing & Grounded Citations', () => {
    it('extracts multi-page text and assigns page numbers and citations', () => {
      const pdfBuf = buildSyntheticPdf([
        'Section 1: Executive Overview of Q4 Performance',
        'Section 2: Operating Margin Analysis and Forecasts',
      ])

      const doc = parser.parse(pdfBuf, { filePath: 'financials.pdf' })
      expect(doc.fileType).toBe('pdf')
      expect(doc.totalPages).toBe(2)
      expect(doc.sections.length).toBe(2)
      expect(doc.sections[0].pageNumber).toBe(1)
      expect(doc.sections[0].citation).toBe('[financials.pdf, Page 1]')
      expect(doc.sections[0].content).toContain('Executive Overview')

      expect(doc.sections[1].pageNumber).toBe(2)
      expect(doc.sections[1].citation).toBe('[financials.pdf, Page 2]')
      expect(doc.sections[1].content).toContain('Operating Margin Analysis')

      expect(doc.citations.length).toBe(2)
      expect(doc.citations[0].formatted).toBe('[financials.pdf, Page 1 of 2]')
    })

    it('detects encrypted / password-protected PDF gracefully without crashing', () => {
      const encryptedPdf = buildSyntheticPdf(['Secret Text'], true)
      const doc = parser.parse(encryptedPdf, { filePath: 'secret.pdf' })

      expect(doc.fileType).toBe('pdf')
      expect(doc.isEncrypted).toBe(true)
      expect(doc.error).toBe('Password-protected PDF')
      expect(doc.sections[0].title).toBe('Encrypted Document')
    })

    it('handles truncated PDF without throwing', () => {
      const truncatedPdf = buildSyntheticPdf(['Truncated Text'], false, true)
      const doc = parser.parse(truncatedPdf, { filePath: 'truncated.pdf' })

      expect(doc.fileType).toBe('pdf')
      expect(doc.isTruncated).toBe(true)
      expect(doc.sections.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('DOCX Parsing & Grounded Citations', () => {
    it('extracts headings, paragraphs, and tables from word/document.xml', () => {
      const docXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Project Architecture</w:t></w:r></w:p>
    <w:p><w:r><w:t>JARVIS adopts a decoupled cognitive architecture.</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Core Components</w:t></w:r></w:p>
    <w:p><w:r><w:t>AssistantEngine acts as single central cognitive authority.</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Component</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Role</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>AssistantEngine</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Orchestration</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>`

      const zipBuf = buildSyntheticZip({ 'word/document.xml': docXml })
      const doc = parser.parse(zipBuf, { filePath: 'architecture.docx' })

      expect(doc.fileType).toBe('docx')
      expect(doc.sections.length).toBeGreaterThanOrEqual(2)
      expect(doc.sections.some((s) => s.title === 'Project Architecture')).toBe(true)
      expect(doc.sections.some((s) => s.title === 'Core Components')).toBe(true)
      expect(doc.sections.some((s) => s.title === 'Table 1')).toBe(true)
      expect(doc.rawText).toContain('JARVIS adopts a decoupled cognitive architecture')
      expect(doc.citations.some((c) => c.formatted === "[architecture.docx, Section 'Project Architecture']")).toBe(true)
    })

    it('handles malformed DOCX archive gracefully without crashing', () => {
      const corruptZip = Buffer.from('PK\x03\x04corrupted zip data')
      const doc = parser.parse(corruptZip, { filePath: 'corrupt.docx' })

      expect(doc.fileType).toBe('docx')
      expect(doc.error).toBeDefined()
    })
  })

  describe('XLSX Parsing & Grounded Citations', () => {
    it('extracts multi-sheet tables, shared strings, and numeric statistics', () => {
      const workbookXml = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets>
    <sheet name="Sales" sheetId="1" id="rId1"/>
  </sheets>
</workbook>`

      const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>Region</t></si>
  <si><t>Revenue</t></si>
  <si><t>North</t></si>
  <si><t>South</t></si>
</sst>`

      const sheet1Xml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>2</v></c>
      <c r="B2"><v>1000</v></c>
    </row>
    <row r="3">
      <c r="A3" t="s"><v>3</v></c>
      <c r="B3"><v>2000</v></c>
    </row>
  </sheetData>
</worksheet>`

      const zipBuf = buildSyntheticZip({
        'xl/workbook.xml': workbookXml,
        'xl/sharedStrings.xml': sharedStringsXml,
        'xl/worksheets/sheet1.xml': sheet1Xml,
      })

      const doc = parser.parse(zipBuf, { filePath: 'financials.xlsx' })
      expect(doc.fileType).toBe('xlsx')
      expect(doc.sheetNames).toEqual(['Sales'])
      expect(doc.tabular).toBeDefined()
      expect(doc.tabular?.headers).toEqual(['Region', 'Revenue'])
      expect(doc.tabular?.rowCount).toBe(2)

      const revStat = doc.tabular?.columnStats.find((s) => s.name === 'Revenue')
      expect(revStat?.type).toBe('numeric')
      expect(revStat?.min).toBe(1000)
      expect(revStat?.max).toBe(2000)
      expect(revStat?.avg).toBe(1500)

      expect(doc.sections[0].sheetName).toBe('Sales')
      expect(doc.sections[0].citation).toContain("Sheet 'Sales'")
    })
  })

  describe('PPTX Parsing & Grounded Citations', () => {
    it('extracts slide order, titles, and body bullets', () => {
      const slide1Xml = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp><p:txBody><a:p><a:r><a:t>JARVIS 3.0 Operating System</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:txBody><a:p><a:r><a:t>Universal Personal AI Platform</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`

      const slide2Xml = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp><p:txBody><a:p><a:r><a:t>Architecture Pillars</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:txBody><a:p><a:r><a:t>Honest verification and single authority</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`

      const zipBuf = buildSyntheticZip({
        'ppt/slides/slide1.xml': slide1Xml,
        'ppt/slides/slide2.xml': slide2Xml,
      })

      const doc = parser.parse(zipBuf, { filePath: 'overview.pptx' })
      expect(doc.fileType).toBe('pptx')
      expect(doc.totalSlides).toBe(2)
      expect(doc.sections.length).toBe(2)
      expect(doc.sections[0].slideNumber).toBe(1)
      expect(doc.sections[0].title).toContain('JARVIS 3.0 Operating System')
      expect(doc.sections[1].slideNumber).toBe(2)
      expect(doc.sections[1].title).toContain('Architecture Pillars')
      expect(doc.citations[0].formatted).toBe('[overview.pptx, Slide 1 of 2]')
    })
  })

  describe('DocumentStore Disk Index & Change Detection', () => {
    const testIndexPath = path.join(process.cwd(), 'temp-test-index', 'documents.json')

    it('persists and reloads index from disk with change detection', () => {
      // Clean up previous test run if any
      if (fs.existsSync(testIndexPath)) {
        fs.unlinkSync(testIndexPath)
      }

      const store = new DocumentStore({ indexPath: testIndexPath, autoPersist: true })
      expect(store.listDocuments().length).toBe(0)

      // Ingest document
      const doc1 = store.ingest('# Project Overview\n\nJARVIS is a universal personal AI operating system.', {
        filePath: 'D:/docs/readme.md',
      })

      expect(store.listDocuments().length).toBe(1)
      expect(fs.existsSync(testIndexPath)).toBe(true)

      // Change detection: same file and same content returns cached doc
      const doc1Reingested = store.ingest('# Project Overview\n\nJARVIS is a universal personal AI operating system.', {
        filePath: 'D:/docs/readme.md',
      })
      expect(doc1Reingested.id).toBe(doc1.id)

      // Query with grounded citation
      const qRes = store.query('universal personal AI')
      expect(qRes.sources.length).toBeGreaterThan(0)
      expect(qRes.sources[0].citation).toContain("Section 'Project Overview'")

      // Reload into a fresh store instance from disk
      const freshStore = new DocumentStore({ indexPath: testIndexPath, autoPersist: false })
      expect(freshStore.listDocuments().length).toBe(1)
      const found = freshStore.findDocumentByPath('D:/docs/readme.md')
      expect(found).toBeDefined()
      expect(found?.title).toBe('Project Overview')

      // Clean up test file
      if (fs.existsSync(testIndexPath)) {
        fs.unlinkSync(testIndexPath)
        const dir = path.dirname(testIndexPath)
        if (fs.existsSync(dir)) fs.rmdirSync(dir)
      }
    })
  })
})

