import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolInput,
  ToolPermission,
  ToolResult,
  ToolVerification,
} from '../tools/Tool'
import type { ToolInputSchema } from '../engine/provider'
import { FileSystemError } from './provider'
import type { FileSystemNode, FileSystemProvider } from './provider'
import { FS_LIMITS } from './limits'
import { normalizeSafePath, parentOf, validateSegmentName } from './paths'

/**
 * Filesystem tools (Phase 1.1) — focused, typed, verified.
 *
 * Eleven narrow tools backed by the FileSystemProvider seam, following the
 * existing Tool/registry conventions:
 *
 *   file.status  read_only         honest capability report (never fake)
 *   file.list    read_only
 *   file.search  read_only         bounded results / depth / time
 *   file.stat    read_only
 *   file.read    read_only         bounded, safe text reads
 *   file.mkdir   low_risk          verifiable
 *   file.write   low_risk          verifiable, explicit overwrite guard
 *   file.copy    low_risk          verifiable, explicit overwrite guard
 *   file.move    low_risk          verifiable (source gone + dest present)
 *   file.rename  low_risk          verifiable (old gone + new present)
 *   file.delete  user_confirmation verifiable + explicit approval every run
 *
 * Every verifier reflects REAL provider state — a claimed effect is never
 * reported as confirmed unless the verifier re-checked it changed.
 */

const DESTRUCTIVE_HINTS =
  /\b(delete|remove|rm\b|trash|erase|discard|wipe|purge)\b/i

function fsFailure(error: unknown): ToolResult {
  if (error instanceof FileSystemError) {
    return { ok: false, message: error.message, data: { kind: error.kind, path: error.path } }
  }
  const message = error instanceof Error ? error.message : 'Unknown filesystem failure.'
  return { ok: false, message }
}

/** Short-circuit when the provider cannot actually run real operations. */
function availabilityBlocker(provider: FileSystemProvider): ToolResult | null {
  const caps = provider.capabilities()
  if (caps.available) return null
  return {
    ok: false,
    message: `Filesystem access is not available right now: ${caps.reason ?? 'the provider is inactive.'}`,
    data: { available: false, reason: caps.reason },
  }
}

function paramStr(input: ToolInput, key: string): string | undefined {
  const value = input.params?.[key]
  return typeof value === 'string' ? value : undefined
}

function paramBool(input: ToolInput, key: string): boolean | undefined {
  const value = input.params?.[key]
  return typeof value === 'boolean' ? value : undefined
}

function paramNum(input: ToolInput, key: string): number | undefined {
  const value = input.params?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** stat(path) → kind, or 'absent' on not_found, or 'unknown' on other errors. */
async function entryKind(provider: FileSystemProvider, path: string): Promise<'file' | 'directory' | 'absent' | 'unknown'> {
  try {
    const node = await provider.stat(path)
    return node.kind
  } catch (error) {
    if (error instanceof FileSystemError && error.kind === 'not_found') return 'absent'
    return 'unknown'
  }
}

/** Shared verifier semantics for "the old path must be gone AND the new one present". */
async function verifyMoved(provider: FileSystemProvider, oldPath: string, newPath: string): Promise<ToolVerification> {
  const oldKind = await entryKind(provider, oldPath)
  const newKind = await entryKind(provider, newPath)
  if (oldKind === 'absent' && (newKind === 'file' || newKind === 'directory')) {
    return { ok: true, message: `Confirmed: "${oldPath}" is gone and "${newPath}" exists.`, checks: [`old absent`, `new present`] }
  }
  return {
    ok: false,
    message: `Verification failed: "${oldPath}" absent=${oldKind === 'absent'}, "${newPath}" present=${newKind === 'file' || newKind === 'directory'}, so the move is not confirmed.`,
  }
}

function excerpt(names: string[], cap = 8): string {
  if (!names.length) return 'nothing found'
  const shown = names.slice(0, cap)
  return shown.join(', ') + (names.length > cap ? ` (+${names.length - cap} more)` : '')
}

abstract class FsTool implements Tool {
  readonly category: ToolCategory = 'system'
  readonly verifiable: boolean = false
  readonly requiresPermission: boolean = false
  protected readonly provider: FileSystemProvider

  constructor(provider: FileSystemProvider) {
    this.provider = provider
  }

  abstract readonly id: string
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly permission: ToolPermission
  abstract readonly inputSchema: ToolInputSchema

  abstract canRun(query: string): boolean
  abstract execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult>
}

/* ---------------------------------------------------------------- status */

export class FileStatusTool extends FsTool {
  readonly id = 'file.status'
  readonly name = 'File system status'
  readonly description =
    'Reports whether real filesystem access is available right now, which operations the current runtime supports, and why (honest capability status). ' +
    'The browser app can only reach a directory the user grants via the File System Access API; with no native shell there is no unrestricted access.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = { type: 'object', properties: {}, required: [] }

  canRun(query: string): boolean {
    return /\b(file.?system|files|folder|folders|directory|directories|disk|drive)\b/i.test(query) &&
      /\b(status|available|access|capabilit|can you)\b/i.test(query)
  }

  async execute(): Promise<ToolResult> {
    const caps = this.provider.capabilities()
    if (caps.available) {
      const ops = Object.entries(caps.ops)
        .filter(([, on]) => on)
        .map(([op]) => op)
      return {
        ok: true,
        message: `Filesystem access is available via ${this.provider.id}. Supported operations: ${ops.join(', ')}.`,
        data: caps,
      }
    }
    return {
      ok: true,
      message: `Filesystem access is not available right now — ${caps.reason ?? 'no provider is active.'}`,
      data: caps,
    }
  }
}

/* ---------------------------------------------------------------- list */

export class FileListTool extends FsTool {
  readonly id = 'file.list'
  readonly name = 'List directory'
  readonly description =
    'Lists the entries of a directory relative to the granted workspace root (use path "" for the root). ' +
    'Returns name, kind, size and modified time for each entry. Bounded to a max number of entries.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to the workspace root (default "" = root).' },
      recursive: { type: 'boolean', description: 'Recurse into subdirectories (default false).' },
      depth: { type: 'number', description: 'Max nesting depth when recursive (bounded).' },
      limit: { type: 'number', description: 'Max entries to return (bounded).' },
    },
    required: [],
  }

  canRun(query: string): boolean {
    return /\b(list|ls|show|what'?s in|what'?s? are)\b/i.test(query) &&
      /\b(file|files|folder|folders|directory|directories|content)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const rawPath = paramStr(input, 'path')
    let path: string
    try {
      path = rawPath === undefined ? '' : normalizeSafePath(rawPath)
    } catch (error) {
      return fsFailure(error)
    }
    try {
      const nodes = await this.provider.list(path, {
        recursive: paramBool(input, 'recursive'),
        depth: paramNum(input, 'depth'),
        limit: paramNum(input, 'limit'),
      })
      const label = path ? `"${path}"` : 'the workspace root'
      if (!nodes.length) return { ok: true, message: `${label} is empty.`, data: { path, entries: [] } }
      const names = nodes.map((n) => n.name)
      return {
        ok: true,
        message: `${label} has ${nodes.length} entr${nodes.length === 1 ? 'y' : 'ies'}: ${excerpt(names)}.`,
        data: { path, entries: nodes },
      }
    } catch (error) {
      return fsFailure(error)
    }
  }
}

/* ---------------------------------------------------------------- search */

export class FileSearchTool extends FsTool {
  readonly id = 'file.search'
  readonly name = 'Search files'
  readonly description =
    'Searches the granted workspace for files and folders by name (case-insensitive substring) and/or extension. ' +
    'Bounded by max results, nesting depth and elapsed time — it never scans the whole computer.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Substring to match against names (optional but recommended).' },
      extension: { type: 'string', description: 'Extension filter, e.g. ".txt" (optional).' },
      path: { type: 'string', description: 'Search rooted here instead of the workspace root (optional).' },
      max_depth: { type: 'number', description: 'Max nesting depth (bounded).' },
      limit: { type: 'number', description: 'Max results (bounded).' },
    },
    required: [],
  }

  canRun(query: string): boolean {
    return /\b(search|find|look for|locate|where is)\b/i.test(query) &&
      /\b(file|files|folder|folder|notes|txt|csv|config)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const query = paramStr(input, 'query')?.trim() ?? ''
    const extension = paramStr(input, 'extension')?.trim() ?? ''
    if (!query && !extension) {
      return { ok: false, message: 'Search needs a query or an extension to match.', data: { kind: 'invalid_input' } }
    }
    try {
      const rawStart = paramStr(input, 'path')
      const startPath = rawStart === undefined ? '' : normalizeSafePath(rawStart)
      const nodes = await this.provider.search(query, {
        extension: extension || undefined,
        startPath: startPath || undefined,
        maxDepth: paramNum(input, 'max_depth'),
        limit: paramNum(input, 'limit'),
      })
      if (!nodes.length) {
        return { ok: true, message: 'No matching files or folders found.', data: { matches: [] } }
      }
      const matches = nodes.map((n) => n.path)
      const capped = nodes.length >= FS_LIMITS.MAX_SEARCH_RESULTS
      return {
        ok: true,
        message: `Found ${nodes.length} match${nodes.length === 1 ? '' : 'es'}${capped ? ' (result cap reached — refine to narrow)' : ''}: ${excerpt(matches, 6)}.`,
        data: { matches: nodes },
      }
    } catch (error) {
      return fsFailure(error)
    }
  }
}

/* ---------------------------------------------------------------- stat */

export class FileStatTool extends FsTool {
  readonly id = 'file.stat'
  readonly name = 'File details'
  readonly description =
    'Returns metadata for one entry relative to the workspace root: kind (file/directory), size in bytes and modified time.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path of the entry relative to the workspace root.' } },
    required: ['path'],
  }

  canRun(query: string): boolean {
    return /\b(stat|metadata|details?|info|size (of|for)|when was)\b/i.test(query) &&
      /\b(file|files|folder|folder|entry|document|note)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const raw = paramStr(input, 'path')
    if (typeof raw !== 'string') return { ok: false, message: 'Stat which path? Provide path.', data: { kind: 'invalid_input' } }
    try {
      const node = await this.provider.stat(normalizeSafePath(raw))
      const bits: string[] = [node.kind]
      if (node.kind === 'file' && typeof node.size === 'number') bits.push(`${node.size} bytes`)
      if (typeof node.modifiedAt === 'number') bits.push(new Date(node.modifiedAt).toISOString())
      return { ok: true, message: `"${node.path}" is a ${bits.join(', ')}.`, data: node as unknown as FileSystemNode }
    } catch (error) {
      return fsFailure(error)
    }
  }
}

/* ---------------------------------------------------------------- read */

export class FileReadTool extends FsTool {
  readonly id = 'file.read'
  readonly name = 'Read file'
  readonly description =
    'Reads a text file inside the granted workspace root, bounded to a safe size limit. ' +
    'Binary, unsupported or oversized files fail with a structured error (they are never partially loaded or misread as text).'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Text file path relative to the workspace root.' },
      max_bytes: { type: 'number', description: 'Override the read byte limit (still bounded).' },
    },
    required: ['path'],
  }

  canRun(query: string): boolean {
    return /\b(read|open|show contents?|print|preview|view|what'?s in the file)\b/i.test(query) &&
      /\b(file|txt|csv|md|config|json|log|note)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const raw = paramStr(input, 'path')
    if (!raw) return { ok: false, message: 'Read which file? Provide path.', data: { kind: 'invalid_input' } }
    try {
      const { content, bytes } = await this.provider.readText(normalizeSafePath(raw), { maxBytes: paramNum(input, 'max_bytes') })
      const preview = content.length > 600 ? `${content.slice(0, 600)}… (${content.length - 600} more characters not shown)`
        : content
      return {
        ok: true,
        message: `Read "${raw.trim()}" (${bytes} bytes): ${preview}`,
        data: { path: raw.trim(), bytes, content },
      }
    } catch (error) {
      return fsFailure(error)
    }
  }
}

/* ---------------------------------------------------------------- mkdir */

export class FileMkdirTool extends FsTool {
  readonly id = 'file.mkdir'
  readonly name = 'Create folder'
  readonly description =
    'Creates a directory inside the granted workspace root (parent directories must exist). Confirmed after creation.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path relative to the workspace root.' } },
    required: ['path'],
  }

  canRun(query: string): boolean {
    return /\b(create|make|add|new)\b/i.test(query) &&
      /\b(folder|folder|directory|subfolder|sub-?folder)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const raw = paramStr(input, 'path')
    if (!raw) return { ok: false, message: 'Create which folder? Provide path.', data: { kind: 'invalid_input' } }
    try {
      const node = await this.provider.mkdir(normalizeSafePath(raw))
      return { ok: true, message: `Created directory "${node.path}".`, data: node }
    } catch (error) {
      return fsFailure(error)
    }
  }

  verify(input: ToolInput): Promise<ToolVerification> | ToolVerification {
    const raw = paramStr(input, 'path')
    const path = raw ? normalizeSafePath(raw) : ''
    return entryKind(this.provider, path).then((kind) =>
      kind === 'directory'
        ? { ok: true, message: `Confirmed directory "${path}" exists.`, checks: ['directory present'] }
        : { ok: false, message: `Directory "${path}" could not be confirmed after creation.` })
  }
}

/* ---------------------------------------------------------------- write */

export class FileWriteTool extends FsTool {
  readonly id = 'file.write'
  readonly name = 'Write file'
  readonly description =
    'Writes text to a file inside the granted workspace root (creating it if needed). ' +
    'Never overwrites silently: replacing an existing file requires overwrite: true. Confirmed after writing.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root.' },
      content: { type: 'string', description: 'Text content to write.' },
      overwrite: { type: 'boolean', description: 'Explicitly allow replacing an existing file (never implied).' },
    },
    required: ['path', 'content'],
  }

  canRun(query: string): boolean {
    return /\b(write|save|create|put|add)\b/i.test(query) &&
      /\b(file|text file|to|content|document)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const raw = paramStr(input, 'path')
    const content = paramStr(input, 'content')
    if (!raw) return { ok: false, message: 'Write to which file? Provide path.', data: { kind: 'invalid_input' } }
    if (content === undefined) return { ok: false, message: 'Write what content? Provide content.', data: { kind: 'invalid_input' } }
    if (content.length > FS_LIMITS.MAX_WRITE_CHARS) {
      return {
        ok: false,
        message: `Content is ${content.length} characters — larger than the ${FS_LIMITS.MAX_WRITE_CHARS}-character write limit.`,
        data: { kind: 'too_large' },
      }
    }
    try {
      const { bytes } = await this.provider.writeText(normalizeSafePath(raw), content, { overwrite: paramBool(input, 'overwrite') })
      return { ok: true, message: `Wrote "${raw.trim()}" (${bytes} characters).`, data: { path: raw.trim(), bytes } }
    } catch (error) {
      return fsFailure(error)
    }
  }

  verify(input: ToolInput): Promise<ToolVerification> | ToolVerification {
    const raw = paramStr(input, 'path')
    const path = raw ? normalizeSafePath(raw) : ''
    return entryKind(this.provider, path).then((kind) =>
      kind === 'file'
        ? { ok: true, message: `Confirmed file "${path}" exists.`, checks: ['file present'] }
        : { ok: false, message: `File "${path}" could not be confirmed after writing.` })
  }
}

/* ---------------------------------------------------------------- copy */

export class FileCopyTool extends FsTool {
  readonly id = 'file.copy'
  readonly name = 'Copy file'
  readonly description =
    'Copies a file within the granted workspace root (files only, size-bounded). ' +
    'Never overwrites silently: replacing an existing destination requires overwrite: true. Confirmed after copying.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Source file path relative to the workspace root.' },
      destination: { type: 'string', description: 'Destination file path relative to the workspace root.' },
      overwrite: { type: 'boolean', description: 'Explicitly allow replacing an existing destination (never implied).' },
    },
    required: ['source', 'destination'],
  }

  canRun(query: string): boolean {
    return /\b(copy|duplicate|clone)\b/i.test(query) &&
      /\b(file|folder|to|into)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const source = paramStr(input, 'source')
    const destination = paramStr(input, 'destination')
    if (!source || !destination) {
      return { ok: false, message: 'Copy needs both source and destination paths.', data: { kind: 'invalid_input' } }
    }
    try {
      await this.provider.copy(normalizeSafePath(source), normalizeSafePath(destination), { overwrite: paramBool(input, 'overwrite') })
      return { ok: true, message: `Copied "${source.trim()}" to "${destination.trim()}".`, data: { source: source.trim(), destination: destination.trim() } }
    } catch (error) {
      return fsFailure(error)
    }
  }

  verify(input: ToolInput): Promise<ToolVerification> | ToolVerification {
    const destination = paramStr(input, 'destination')
    const path = destination ? normalizeSafePath(destination) : ''
    return entryKind(this.provider, path).then((kind) =>
      kind === 'file'
        ? { ok: true, message: `Confirmed copy exists at "${path}".`, checks: ['destination present'] }
        : { ok: false, message: `Copy at "${path}" could not be confirmed.` })
  }
}

/* ---------------------------------------------------------------- move */

export class FileMoveTool extends FsTool {
  readonly id = 'file.move'
  readonly name = 'Move file'
  readonly description =
    'Moves a file within the granted workspace root (files only, size-bounded). ' +
    'Never overwrites silently: replacing an existing destination requires overwrite: true. ' +
    'Confirmed only when the source is gone AND the destination exists.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Current file path relative to the workspace root.' },
      destination: { type: 'string', description: 'New file path relative to the workspace root.' },
      overwrite: { type: 'boolean', description: 'Explicitly allow replacing an existing destination (never implied).' },
    },
    required: ['source', 'destination'],
  }

  canRun(query: string): boolean {
    return /\b(move|relocate|transfer)\b/i.test(query) &&
      /\b(file|folder|to|into)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const source = paramStr(input, 'source')
    const destination = paramStr(input, 'destination')
    if (!source || !destination) {
      return { ok: false, message: 'Move needs both source and destination paths.', data: { kind: 'invalid_input' } }
    }
    try {
      await this.provider.move(normalizeSafePath(source), normalizeSafePath(destination), { overwrite: paramBool(input, 'overwrite') })
      return { ok: true, message: `Moved "${source.trim()}" to "${destination.trim()}".`, data: { source: source.trim(), destination: destination.trim() } }
    } catch (error) {
      return fsFailure(error)
    }
  }

  verify(input: ToolInput): Promise<ToolVerification> {
    const source = paramStr(input, 'source')
    const destination = paramStr(input, 'destination')
    const oldPath = source ? normalizeSafePath(source) : ''
    const newPath = destination ? normalizeSafePath(destination) : ''
    return verifyMoved(this.provider, oldPath, newPath)
  }
}

/* ---------------------------------------------------------------- rename */

export class FileRenameTool extends FsTool {
  readonly id = 'file.rename'
  readonly name = 'Rename file'
  readonly description =
    'Renames a file or folder inside the granted workspace root. ' +
    'Confirmed only when the old name is gone AND the new name exists.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Current path relative to the workspace root.' },
      new_name: { type: 'string', description: 'New leaf name for the entry.' },
    },
    required: ['path', 'new_name'],
  }

  canRun(query: string): boolean {
    return /\b(rename|re-?name)\b/i.test(query) &&
      /\b(file|folder|directory|entry|to)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const raw = paramStr(input, 'path')
    const newName = paramStr(input, 'new_name')
    if (!raw) return { ok: false, message: 'Rename which entry? Provide path.', data: { kind: 'invalid_input' } }
    if (!newName) return { ok: false, message: 'Rename it to what? Provide new_name.', data: { kind: 'invalid_input' } }
    try {
      const safe = normalizeSafePath(raw)
      if (!safe) return { ok: false, message: 'The workspace root cannot be renamed.', data: { kind: 'invalid_path' } }
      validateSegmentName(newName)
      await this.provider.rename(safe, newName)
      return { ok: true, message: `Renamed "${raw.trim()}" to "${newName.trim()}".`, data: { from: raw.trim(), to: newName.trim() } }
    } catch (error) {
      return fsFailure(error)
    }
  }

  verify(input: ToolInput): Promise<ToolVerification> {
    const raw = paramStr(input, 'path')
    const newName = paramStr(input, 'new_name')
    const oldPath = raw ? normalizeSafePath(raw) : ''
    const newPath = newName ? `${oldPath ? `${parentOf(oldPath)}${parentOf(oldPath) ? '/' : ''}` : ''}${validateSegmentName(newName)}` : ''
    return verifyMoved(this.provider, oldPath, newPath)
  }
}

/* ---------------------------------------------------------------- delete */

export class FileDeleteTool extends FsTool {
  readonly id = 'file.delete'
  readonly name = 'Delete file or folder'
  readonly description =
    'Permanently deletes a file or folder inside the granted workspace root. ' +
    'High-risk: requires explicit user confirmation on every execution, never runs autonomously. ' +
    'Confirmed only when the target is gone. Non-empty folders need recursive: true.'
  readonly permission: ToolPermission = 'user_confirmation'
  readonly requiresPermission = true
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path of the entry to delete, relative to the workspace root.' },
      recursive: { type: 'boolean', description: 'Delete a non-empty folder and everything inside it (default false).' },
    },
    required: ['path'],
  }

  canRun(query: string): boolean {
    return DESTRUCTIVE_HINTS.test(query) &&
      /\b(file|files|folder|folders|directory|directories|entry|note|document)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const raw = paramStr(input, 'path')
    if (!raw) return { ok: false, message: 'Delete which path? Provide path.', data: { kind: 'invalid_input' } }
    try {
      await this.provider.remove(normalizeSafePath(raw), { recursive: paramBool(input, 'recursive') })
      return { ok: true, message: `Deleted "${raw.trim()}".`, data: { path: raw.trim() } }
    } catch (error) {
      return fsFailure(error)
    }
  }

  verify(input: ToolInput): Promise<ToolVerification> {
    const raw = paramStr(input, 'path')
    const path = raw ? normalizeSafePath(raw) : ''
    return entryKind(this.provider, path).then((kind) =>
      kind === 'absent'
        ? { ok: true, message: `Confirmed "${path}" is gone.`, checks: ['target absent'] }
        : { ok: false, message: kind === 'unknown' ? `Removal of "${path}" could not be confirmed.` : `"${path}" still resolves (${kind}).` })
  }
}

/** All filesystem tools bound to one provider, ready for the registry. */
export function createFileSystemTools(provider: FileSystemProvider): Tool[] {
  return [
    new FileStatusTool(provider),
    new FileListTool(provider),
    new FileSearchTool(provider),
    new FileStatTool(provider),
    new FileReadTool(provider),
    new FileMkdirTool(provider),
    new FileWriteTool(provider),
    new FileCopyTool(provider),
    new FileMoveTool(provider),
    new FileRenameTool(provider),
    new FileDeleteTool(provider),
  ]
}