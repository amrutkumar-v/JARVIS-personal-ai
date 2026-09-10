import { FS_LIMITS, boundedDepth, boundedLimit } from './limits'
import { fsError } from './provider'
import type {
  FileSystemCapabilities,
  FileSystemNode,
  FileSystemProvider,
  FsListOptions,
  FsOp,
  FsSearchOptions,
  FsTextStats,
  FsWriteOptions,
} from './provider'
import { baseNameOf, isRootPath, normalizeSafePath, parentOf, validateSegmentName } from './paths'

/**
 * Deterministic in-memory provider for TESTS ONLY.
 *
 * Never imported or constructed by production code: the engine defaults to the
 * real browser File System Access provider, and a dedicated test proves the
 * production path never uses this fake. It exists so filesystem tools can be
 * exercised quickly and deterministically; the moment a tool reports a fake
 * operation as a real one is the moment a test here fails.
 *
 * Seed format: `{ 'notes.txt': 'hello', 'docs/': { directory: true }, 'docs/b.txt': 'x' }`.
 */
interface FakeNode {
  kind: 'file' | 'directory'
  content?: string
  children?: Map<string, FakeNode>
  modifiedAt: number
}

export type FailurePolicy = 'io' | 'unavailable' | 'not_found'

export class FakeFileSystemProvider implements FileSystemProvider {
  readonly id = 'fake'
  /** Positive marker so tests can assert production never swaps this in. */
  readonly testsOnly = true

  private root = new Map<string, FakeNode>()
  private clock = 1000
  private available = true
  private faults = new Set<FsOp>()
  private failures = new Map<FsOp, FailurePolicy>()

  constructor(seed?: Record<string, string | { directory?: boolean }>) {
    if (seed) {
      for (const rawPath of Object.keys(seed)) {
        const spec = seed[rawPath]
        const path = normalizeSafePath(rawPath)
        if (spec && typeof spec === 'object' && spec.directory) {
          this.mkdir(path)
        } else if (typeof spec === 'string') {
          this.putText(path, spec)
        }
      }
    }
  }

  setAvailable(on: boolean): void {
    this.available = on
  }

  /** Inject a persistent failure for one op until clearFaults(). */
  fault(op: FsOp, policy: FailurePolicy = 'io'): void {
    this.faults.add(op)
    this.failures.set(op, policy)
  }

  clearFaults(): void {
    this.faults.clear()
    this.failures.clear()
  }

  /** All non-root entries as sorted posix paths; directories end with '/'. */
  treeStrings(): string[] {
    const out: string[] = []
    const visit = (dir: Map<string, FakeNode>, prefix: string): void => {
      const names = [...dir.keys()].sort()
      for (const name of names) {
        const entry = dir.get(name) as FakeNode
        const path = prefix ? `${prefix}/${name}` : name
        if (entry.kind === 'directory') {
          out.push(`${path}/`)
          visit(entry.children as Map<string, FakeNode>, path)
        } else {
          out.push(path)
        }
      }
    }
    visit(this.root, '')
    return out.sort()
  }

  overrideSeed(seed: Record<string, string | { directory?: boolean }>): void {
    this.root = new Map()
    this.clock = 1000
    this.clearFaults()
    this.available = true
    for (const rawPath of Object.keys(seed)) {
      const spec = seed[rawPath]
      const path = normalizeSafePath(rawPath)
      if (spec && typeof spec === 'object' && spec.directory) this.mkdir(path)
      else if (typeof spec === 'string') this.putText(path, spec)
    }
  }

  capabilities(): FileSystemCapabilities {
    const ops = Object.fromEntries(
      (['status', 'list', 'search', 'stat', 'read', 'mkdir', 'write', 'copy', 'move', 'rename', 'delete'] as const).map(
        (op) => [op, this.available],
      ),
    ) as FileSystemCapabilities['ops']
    return {
      available: this.available,
      reason: this.available ? undefined : 'The (test) provider is intentionally marked unavailable.',
      hasApi: true,
      rootGranted: this.available,
      ops,
    }
  }

  async list(path: string, options: FsListOptions = {}): Promise<FileSystemNode[]> {
    this.guard('list')
    const safe = normalizeSafePath(path)
    const limit = boundedLimit(options.limit, FS_LIMITS.MAX_LIST_RESULTS)
    const depth = boundedDepth(options.depth, options.recursive ? 1 : 0, FS_LIMITS.MAX_SEARCH_DEPTH)
    const dir = this.resolveDirectory(safe)
    const out: FileSystemNode[] = []
    const walk = (map: Map<string, FakeNode>, prefix: string, level: number): void => {
      if (out.length >= limit) return
      const names = [...map.keys()].sort()
      for (const name of names) {
        if (out.length >= limit) break
        const entry = map.get(name) as FakeNode
        const entryPath = prefix ? `${prefix}/${name}` : name
        if (entry.kind === 'directory') {
          if (level < depth && depth > 0) walk(entry.children as Map<string, FakeNode>, entryPath, level + 1)
          else out.push({ name, path: entryPath, kind: 'directory', modifiedAt: entry.modifiedAt })
        } else {
          out.push({ name, path: entryPath, kind: 'file', size: entry.content?.length ?? 0, modifiedAt: entry.modifiedAt })
        }
      }
    }
    walk(dir, safe, 0)
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  async search(query: string, options: FsSearchOptions = {}): Promise<FileSystemNode[]> {
    this.guard('search')
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
    const startPath = options.startPath ? normalizeSafePath(options.startPath) : ''
    const limit = boundedLimit(options.limit, FS_LIMITS.MAX_SEARCH_RESULTS)
    const depth = boundedDepth(options.maxDepth, FS_LIMITS.MAX_SEARCH_DEPTH, FS_LIMITS.MAX_SEARCH_DEPTH)
    const rawExt = options.extension ? String(options.extension).trim().toLowerCase() : ''
    const extension = rawExt ? (rawExt.startsWith('.') ? rawExt : `.${rawExt}`) : ''
    const startDir = this.resolveDirectory(startPath)
    const out: FileSystemNode[] = []
    const visit = (map: Map<string, FakeNode>, prefix: string, level: number): void => {
      if (out.length >= limit) return
      const names = [...map.keys()].sort()
      for (const name of names) {
        if (out.length >= limit) break
        const entry = map.get(name) as FakeNode
        const entryPath = prefix ? `${prefix}/${name}` : name
        const matches =
          (needle.length === 0 || name.toLowerCase().includes(needle)) &&
          (extension.length === 0 || name.toLowerCase().endsWith(extension))
        if (entry.kind === 'directory') {
          if (matches) out.push({ name, path: entryPath, kind: 'directory', modifiedAt: entry.modifiedAt })
          if (level < depth) visit(entry.children as Map<string, FakeNode>, entryPath, level + 1)
        } else if (matches) {
          out.push({ name, path: entryPath, kind: 'file', size: entry.content?.length ?? 0, modifiedAt: entry.modifiedAt })
        }
      }
    }
    visit(startDir, startPath, 0)
    return out
  }

  async stat(path: string): Promise<FileSystemNode> {
    this.guard('stat')
    const safe = normalizeSafePath(path)
    if (isRootPath(safe)) return { name: 'workspace', path: '', kind: 'directory', modifiedAt: this.clock }
    const entry = this.findEntry(safe)
    if (!entry) throw fsError('not_found', `No such file or directory: "${safe}".`, safe)
    return this.toNode(entry, safe)
  }

  async readText(path: string, options: { maxBytes?: number } = {}): Promise<FsTextStats> {
    this.guard('read')
    const safe = normalizeSafePath(path)
    const entry = this.findEntry(safe)
    if (!entry) throw fsError('not_found', `No such file or directory: "${safe}".`, safe)
    if (entry.kind === 'directory') {
      throw fsError('unsupported', `"${safe}" is a directory. Read which file?`, safe)
    }
    const content = entry.content ?? ''
    const maxBytes = boundedLimit(options.maxBytes, FS_LIMITS.MAX_READ_BYTES)
    if (content.length > maxBytes) {
      throw fsError('too_large', `"${safe}" is larger than the ${maxBytes}-byte read limit.`, safe)
    }
    // Simulate binary/unsupported payloads for tests.
    if (content.includes('\u0000')) {
      throw fsError('unsupported', `"${safe}" does not look like plain text.`, safe)
    }
    return { content, bytes: content.length }
  }

  async writeText(path: string, content: string, options: FsWriteOptions = {}): Promise<{ bytes: number }> {
    this.guard('write')
    const safe = normalizeSafePath(path)
    if (isRootPath(safe)) throw fsError('invalid_path', 'Cannot write to the workspace root itself.', safe)
    if (typeof content !== 'string') throw fsError('invalid_path', 'Content must be text.')
    if (content.length > FS_LIMITS.MAX_WRITE_CHARS) {
      throw fsError('too_large', `Content is larger than the ${FS_LIMITS.MAX_WRITE_CHARS}-character write limit.`, safe)
    }
    const parent = this.resolveDirectory(parentOf(safe))
    const name = baseNameOf(safe)
    const existing = parent.get(name)
    if (existing && existing.kind !== 'directory' && !options.overwrite) {
      throw fsError('exists', `"${safe}" already exists. Use overwrite: true to replace it.`, safe)
    }
    if (existing && existing.kind === 'directory') {
      throw fsError('invalid_path', `"${safe}" is a directory, not a file.`, safe)
    }
    parent.set(name, { kind: 'file', content, modifiedAt: ++this.clock })
    return { bytes: content.length }
  }

  async mkdir(path: string): Promise<FileSystemNode> {
    this.guard('mkdir')
    const safe = normalizeSafePath(path)
    if (isRootPath(safe)) throw fsError('invalid_path', 'The workspace root already exists.', safe)
    const parent = this.resolveDirectory(parentOf(safe))
    const name = baseNameOf(safe)
    const existing = parent.get(name)
    if (existing) throw fsError('exists', `"${safe}" already exists.`, safe)
    const created: FakeNode = { kind: 'directory', children: new Map(), modifiedAt: ++this.clock }
    parent.set(name, created)
    return this.toNode(created, safe)
  }

  async copy(source: string, destination: string, options: FsWriteOptions = {}): Promise<void> {
    this.guard('copy')
    const src = normalizeSafePath(source)
    const dest = normalizeSafePath(destination)
    if (src === dest) throw fsError('invalid_path', 'Source and destination are the same path.', src)
    const entry = this.findEntry(src)
    if (!entry) throw fsError('not_found', `No such file or directory: "${src}".`, src)
    if (entry.kind === 'directory') {
      throw fsError('unsupported', 'Copying directories is not supported; copy the files inside them instead.', src)
    }
    if (entry.content!.length > FS_LIMITS.MAX_COPY_BYTES) {
      throw fsError('too_large', `"${src}" is larger than the ${FS_LIMITS.MAX_COPY_BYTES}-byte copy limit.`, src)
    }
    this.putText(dest, entry.content ?? '', options.overwrite === true)
  }

  async move(source: string, destination: string, options: FsWriteOptions = {}): Promise<void> {
    this.guard('move')
    const src = normalizeSafePath(source)
    const dest = normalizeSafePath(destination)
    if (src === dest) throw fsError('invalid_path', 'Source and destination are the same path.', src)
    if (!this.findEntry(src)) throw fsError('not_found', `No such file or directory: "${src}".`, src)
    await this.copy(src, dest, options)
    this.deleteEntry(src)
  }

  async rename(path: string, newName: string): Promise<void> {
    this.guard('rename')
    const safe = normalizeSafePath(path)
    if (isRootPath(safe)) throw fsError('invalid_path', 'The workspace root cannot be renamed.', safe)
    const name = validateSegmentName(newName)
    if (baseNameOf(safe) === name) throw fsError('invalid_path', `"${safe}" is already named "${name}".`, safe)
    const parent = parentOf(safe)
    const dest = parent ? `${parent}/${name}` : name
    await this.copy(safe, dest)
    this.deleteEntry(safe)
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    this.guard('delete')
    const safe = normalizeSafePath(path)
    if (isRootPath(safe)) throw fsError('invalid_path', 'Cannot delete the workspace root.', safe)
    this.deleteEntry(safe, { checkNonEmpty: true, recursive: options.recursive === true })
  }

  /* ------------------------------------------------ internals */

  private guard(op: FsOp): void {
    if (!this.available) {
      throw fsError('unavailable', 'The filesystem provider is not available right now.')
    }
    if (this.faults.has(op)) {
      const policy = this.failures.get(op) ?? 'io'
      if (policy === 'unavailable') {
        throw fsError('unavailable', `Op "${op}" is unavailable (injected fault).`)
      }
      if (policy === 'not_found') {
        throw fsError('not_found', `Op "${op}" reported not found (injected fault).`)
      }
      throw fsError('io', `Op "${op}" failed (injected fault).`)
    }
  }

  private toNode(entry: FakeNode, path: string): FileSystemNode {
    return {
      name: baseNameOf(path),
      path,
      kind: entry.kind,
      modifiedAt: entry.modifiedAt,
      ...(entry.kind === 'file' ? { size: entry.content?.length ?? 0 } : {}),
    }
  }

  private findEntry(path: string): FakeNode | undefined {
    if (!path) return { kind: 'directory', children: this.root, modifiedAt: 0 }
    const parts = path.split('/')
    let current = this.root
    for (let i = 0; i < parts.length - 1; i += 1) {
      const next = current.get(parts[i])
      if (!next || next.kind !== 'directory') return undefined
      current = next.children as Map<string, FakeNode>
    }
    return current.get(parts[parts.length - 1])
  }

  private resolveDirectory(path: string): Map<string, FakeNode> {
    if (!path) return this.root
    const entry = this.findEntry(path)
    if (!entry) throw fsError('not_found', `No such directory: "${path}".`, path)
    if (entry.kind !== 'directory') throw fsError('invalid_path', `"${path}" is not a directory.`, path)
    return entry.children as Map<string, FakeNode>
  }

  private putText(path: string, content: string, overwrite = false): void {
    const parent = this.resolveDirectory(parentOf(path))
    const name = baseNameOf(path)
    const existing = parent.get(name)
    if (existing && existing.kind === 'directory') {
      throw fsError('invalid_path', `"${path}" is a directory, not a file.`, path)
    }
    if (existing && existing.kind === 'file' && !overwrite) {
      throw fsError('exists', `"${path}" already exists. Use overwrite: true to replace it.`, path)
    }
    parent.set(name, { kind: 'file', content, modifiedAt: ++this.clock })
  }

  private deleteEntry(path: string, opts: { checkNonEmpty?: boolean; recursive?: boolean } = {}): void {
    const parts = path.split('/')
    const leaf = parts[parts.length - 1]
    const parentPath = parts.slice(0, -1).join('/')
    const parent = this.resolveDirectory(parentPath)
    const entry = parent.get(leaf)
    if (!entry) throw fsError('not_found', `No such file or directory: "${path}".`, path)
    if (entry.kind === 'directory' && opts.checkNonEmpty && !opts.recursive) {
      const children = entry.children as Map<string, FakeNode>
      if (children.size > 0) {
        throw fsError('io', `"${path}" is not empty. Use recursive: true to delete its contents.`, path)
      }
    }
    parent.delete(leaf)
  }
}