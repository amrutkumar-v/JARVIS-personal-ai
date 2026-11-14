/**
 * Document Tools (Phase 3)
 *
 * Implements registered tools for document analysis, summarization, and local knowledge Q&A:
 *   - doc.parse: Parse a file or text content into sections, schema, and statistics.
 *   - doc.summarize: Return an executive summary of sections and tabular columns.
 *   - doc.query: Search indexed documents and return cited excerpts.
 */

import type { Tool, ToolCategory, ToolContextId, ToolInput, ToolPermission, ToolResult } from '../../tools/Tool'
import type { ToolInputSchema } from '../provider'
import type { FileSystemProvider } from '../../filesystem/provider'
import { DocumentStore } from './DocumentStore'

function paramStr(input: ToolInput, key: string): string | undefined {
  const value = input.params?.[key]
  return typeof value === 'string' ? value : undefined
}

export class DocParseTool implements Tool {
  readonly id = 'doc.parse'
  readonly name = 'Parse document'
  readonly description = 'Parse a file path or text content into structured sections, tabular statistics, and schema.'
  readonly category: ToolCategory = 'info'
  readonly permission: ToolPermission = 'read_only'
  readonly verifiable: boolean = false
  readonly requiresPermission: boolean = false
  readonly contexts: ToolContextId[] = ['generic']
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the local file to parse.' },
      content: { type: 'string', description: 'Optional raw content string to parse directly.' },
      fileName: { type: 'string', description: 'Optional file name (for format detection).' },
    },
  }

  private readonly store: DocumentStore
  private readonly fs?: FileSystemProvider

  constructor(store: DocumentStore, fs?: FileSystemProvider) {
    this.store = store
    this.fs = fs
  }

  canRun(query: string): boolean {
    return /\b(parse|inspect|read|analyze)\s+(?:the\s+)?(?:document|doc|pdf|csv|json|spreadsheet|file)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const path = paramStr(input, 'path')
    let content = paramStr(input, 'content')
    const fileName = paramStr(input, 'fileName') || (path ? path.split(/[/\\]/).pop() : 'untitled.txt')

    if (!content && path && this.fs) {
      try {
        const stats = await this.fs.readText(path)
        content = stats.content
      } catch (err) {
        return { ok: false, message: `Could not read file at "${path}": ${err instanceof Error ? err.message : String(err)}` }
      }
    }

    if (!content) {
      return { ok: false, message: 'Either a valid file path or direct content is required.' }
    }

    const doc = this.store.ingest(content, { filePath: path, fileName })
    const summary = doc.tabular
      ? `Parsed ${doc.fileType.toUpperCase()} file "${doc.fileName}": ${doc.tabular.rowCount} rows, ${doc.tabular.headers.length} columns.`
      : `Parsed ${doc.fileType.toUpperCase()} document "${doc.title}": ${doc.sections.length} section(s), ${doc.totalLines} lines.`

    return {
      ok: true,
      message: `${summary}\n\nDocument ID: \`${doc.id}\` is now indexed in local document store.`,
      data: doc,
    }
  }
}

export class DocSummarizeTool implements Tool {
  readonly id = 'doc.summarize'
  readonly name = 'Summarize document'
  readonly description = 'Generate a structured summary of an ingested document or file path.'
  readonly category: ToolCategory = 'info'
  readonly permission: ToolPermission = 'read_only'
  readonly verifiable: boolean = false
  readonly requiresPermission: boolean = false
  readonly contexts: ToolContextId[] = ['generic']
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      documentId: { type: 'string', description: 'ID of the indexed document.' },
      path: { type: 'string', description: 'Optional path of the document to inspect.' },
    },
  }

  private readonly store: DocumentStore

  constructor(store: DocumentStore) {
    this.store = store
  }

  canRun(query: string): boolean {
    return /\b(summarize|overview|summary)\s+(?:of\s+)?(?:the\s+)?(?:document|doc|csv|file)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const docId = paramStr(input, 'documentId')
    const path = paramStr(input, 'path')

    let doc = docId ? this.store.getDocument(docId) : undefined
    if (!doc && path) {
      doc = this.store.findDocumentByPath(path)
    }

    if (!doc) {
      const all = this.store.listDocuments()
      if (all.length > 0) doc = all[all.length - 1]
    }

    if (!doc) {
      return { ok: false, message: 'No ingested document found to summarize. Please parse a document first.' }
    }

    let summaryText = `# Summary: ${doc.title}\n\n**Format:** ${doc.fileType.toUpperCase()}\n**Lines:** ${doc.totalLines}\n**Characters:** ${doc.totalChars}\n`

    if (doc.tabular) {
      summaryText += `\n## Tabular Overview\n- **Rows:** ${doc.tabular.rowCount}\n- **Columns:** ${doc.tabular.headers.join(', ')}\n\n### Column Details:\n`
      for (const col of doc.tabular.columnStats) {
        if (col.type === 'numeric') {
          summaryText += `- **${col.name}**: min = ${col.min}, max = ${col.max}, average = ${col.avg}\n`
        } else {
          summaryText += `- **${col.name}**: ${col.uniqueCount} unique values\n`
        }
      }
    } else {
      summaryText += `\n## Sections (${doc.sections.length}):\n`
      for (const sec of doc.sections) {
        summaryText += `- **${sec.title}** (${sec.content.length} chars)\n`
      }
    }

    return {
      ok: true,
      message: summaryText,
      data: { documentId: doc.id, summary: summaryText },
    }
  }
}

export class DocQueryTool implements Tool {
  readonly id = 'doc.query'
  readonly name = 'Query document'
  readonly description = 'Ask questions and retrieve relevant cited excerpts from ingested documents.'
  readonly category: ToolCategory = 'info'
  readonly permission: ToolPermission = 'read_only'
  readonly verifiable: boolean = false
  readonly requiresPermission: boolean = false
  readonly contexts: ToolContextId[] = ['generic']
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The question or search query.' },
      documentId: { type: 'string', description: 'Optional specific document ID to limit search.' },
    },
    required: ['query'],
  }

  private readonly store: DocumentStore

  constructor(store: DocumentStore) {
    this.store = store
  }

  canRun(query: string): boolean {
    return /\b(what|where|who|when|how|find|search)\b/i.test(query) && /\b(document|doc|pdf|csv|table|file)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const query = paramStr(input, 'query')
    if (!query) return { ok: false, message: 'A query is required.' }

    const docId = paramStr(input, 'documentId')
    const answer = this.store.query(query, { documentId: docId })

    return {
      ok: true,
      message: answer.answer,
      data: answer,
    }
  }
}

import { DataAnalyzeTool, DataChartTool } from './DataAnalysisTools'

export function createDocumentTools(store: DocumentStore, fs?: FileSystemProvider): Tool[] {
  return [
    new DocParseTool(store, fs),
    new DocSummarizeTool(store),
    new DocQueryTool(store),
    new DataAnalyzeTool(store),
    new DataChartTool(store),
  ]
}
