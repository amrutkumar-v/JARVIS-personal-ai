import { nativeError } from './errors.js'
import { NATIVE_LIMITS, boundedDepth, boundedLimit } from './limits.js'
import { validateNativeSegment } from './paths.js'
import type {
  BackendDeleteOptions,
  BackendListOptions,
  BackendReadOptions,
  BackendSearchOptions,
  BackendTransferOptions,
  BackendWriteOptions,
  FsBackend,
  NativeNode,
} from './backend.js'

/**
 * Deterministic in-memory filesystem backend for TESTS ONLY (Phase 1.2).
 *
 * Never constructed by production code: the agent defaults to `RealFsBackend`,
 * which talks to the REAL Windows filesystem. This exists so protocol and
 * bridge tests are fast and deterministic and never touch the developer's own
 * disks. A dedicated test proves the production path never wires this in.
 *
 * The `root` argument is treated as an opaque label (the broker already
 * selected an allowed root); entries are stored as posix paths relative to it.
 *
 * Seed format: `{ 'notes.txt': 'hello', 'docs/': { directory: true }, 'docs/b.txt': 'x' }`.
 */
interface MemoryNode {
  kind: 'file' | 'directory'
  content?: string
  children?: Map<string, MemoryNode>
  size: number
  modifiedAt: number
}

export class MemoryFsBackend implements FsBackend {
  readonly id = 'memory-native-fs'
  readonly testsOnly = true

  private root = new Map<string, MemoryNode>()
  private clock = 1000

  constructor(seed?: Record<string, string | { directory?: boolean }>) {
    if (seed) {
      for (const rawPath of Object.keys(seed)) {
        const spec = seed[rawPath]
        const path = rawPath.trim().replace(/^[/\\]+/, '')
        if (spec && typeof spec === 'object' && spec.directory) {
          this.ensure(path, 'directory')
        } else if (typeof spec === 'string') {
          this.ensure(path, 'file')
          this.writeFileAt(path, spec)
        }
      }
    }
  }

  /** Snapshot of all non-root entries as sorted posix paths (dirs end '/'). */
  treeStrings(): string[] {
    const out: string[] = []
    const visit = (dir: Map<string, MemoryNode>, prefix: string): void => {
      const names = [...dir.keys()].sort()
      for (const name of names) {
        const entry = dir.get(name) as MemoryNode
        const p = prefix ? `${prefix}/${name}` : name
        if (entry.kind === 'directory') {
          out.push(`${p}/`)
          visit(entry.children as Map<string, MemoryNode>, p)
        } else {
          out.push(p)
        }
      }
    }
    visit(this.root, '')
    return out.sort()
  }

  overrideSeed(seed: Record<string, string | { directory?: boolean }>): void {
    this.root = new Map()
    this.clock = 1000
    for (const rawPath of Object.keys(seed)) {
      const spec = seed[rawPath]
      const path = rawPath.trim().replace(/^[/\\]+/, '')
      if (spec && typeof spec === 'object' && spec.directory) {
        this.ensure(path, 'directory')
      } else if (typeof spec === 'string') {
        this.ensure(path, 'file')
        this.writeFileAt(path, spec)
      }
    }
  }

  private ensure(path: string, kind: 'file' | 'directory'): void {
    const segments = path.split('/').filter(Boolean)
    let dir = this.root
    const parents: Map<string, MemoryNode>[] = []
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i]
      parents.push(dir)
      let next = dir.get(seg)
      if (!next) {
        next = { kind: 'directory', children: new Map(), size: 0, modifiedAt: ++this.clock }
        dir.set(seg, next)
      } else if (next.kind !== 'directory') {
        throw nativeError('invalid_path', `"${segments.slice(0, i + 1).join('/')}" is not a directory.`)
      }
      dir = next.children as Map<string, MemoryNode>
    }
    const leaf = segments[segments.length - 1]
    if (!leaf) return
    const existing = dir.get(leaf)
    if (existing && existing.kind === 'directory' && kind === 'directory') return
    if (existing) {
      throw nativeError('already_exists', `"${path}" already exists.`)
    }
    dir.set(leaf, {
      kind,
      ...(kind === 'directory' ? { children: new Map() } : {}),
      size: 0,
      modifiedAt: ++this.clock,
    })
  }

  private walkTo(path: string): { dir: Map<string, MemoryNode>; name: string } {
    const segments = path.split('/').filter(Boolean)
    let dir = this.root
    for (let i = 0; i < segments.length - 1; i += 1) {
      const next = dir.get(segments[i])
      if (!next || next.kind !== 'directory') {
        throw nativeError('not_found', `No such file or directory: "${path}".`)
      }
      dir = next.children as Map<string, MemoryNode>
    }
    return { dir, name: segments.length > 0 ? segments[segments.length - 1] : '' }
  }

  private nodeAt(path: string): MemoryNode | null {
    if (!path) {
      return { kind: 'directory', children: this.root, size: 0, modifiedAt: 0 }
    }
    const { dir, name } = this.walkTo(path)
    return dir.get(name) ?? null
  }

  private writeFileAt(path: string, content: string): void {
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) return
    const name = parts[parts.length - 1]
    const parentPath = parts.slice(0, -1).join('/')
    let dir: Map<string, MemoryNode> = this.root
    if (parentPath) {
      const parentNode = this.nodeAt(parentPath)
      if (parentNode && parentNode.kind === 'directory') {
        dir = (parentNode as { children: Map<string, MemoryNode> }).children as Map<string, MemoryNode>
      }
    }
    dir.set(name, { kind: 'file', content, size: content.length, modifiedAt: ++this.clock })
  }

  private toNode(path: string, node: MemoryNode): NativeNode {
    const out: NativeNode = { name: path.split('/').pop() || 'workspace', path, kind: node.kind, modifiedAt: node.modifiedAt }
    if (node.kind === 'file') out.size = node.size
    return out
  }

  async list(_root: string, relPath: string, options: BackendListOptions): Promise<NativeNode[]> {
    const path = relPath.trim().replace(/^[/\\]+/, '')
    const target = this.nodeAt(path)
    if (!target) throw nativeError('not_found', `No such file or directory: "${relPath}".`)
    if (target.kind !== 'directory') {
      throw nativeError('invalid_path', `"${relPath}" is not a directory.`, relPath)
    }
    const depth = boundedDepth(options.depth, 1, NATIVE_LIMITS.MAX_SEARCH_DEPTH)
    const limit = boundedLimit(options.limit, NATIVE_LIMITS.MAX_LIST_RESULTS)
    const out: NativeNode[] = []
    const visit = (dir: Map<string, MemoryNode>, prefix: string, level: number): void => {
      const names = [...dir.keys()].sort()
      for (const name of names) {
        if (out.length >= limit) break
        const entry = dir.get(name) as MemoryNode
        const p = prefix ? `${prefix}/${name}` : name
        if (entry.kind === 'directory') {
          if (level < depth) visit(entry.children as Map<string, MemoryNode>, p, level + 1)
          else out.push({ name, path: p, kind: 'directory' })
        } else {
          out.push(this.toNode(p, entry))
        }
      }
    }
    visit(target.children as Map<string, MemoryNode>, path, 0)
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  async search(_root: string, options: BackendSearchOptions): Promise<NativeNode[]> {
    const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''
    if (query.length > NATIVE_LIMITS.MAX_SEARCH_QUERY_LENGTH) {
      throw nativeError('invalid_path', `Search query is too long (max ${NATIVE_LIMITS.MAX_SEARCH_QUERY_LENGTH} characters).`)
    }
    const ext = options.extension ? String(options.extension).trim().toLowerCase() : ''
    const normalizeExt = (e: string) => (e.startsWith('.') ? e : `.${e}`)
    const start = options.startPath.trim().replace(/^[/\\]+/, '')
    const target = this.nodeAt(start)
    if (!target || target.kind !== 'directory') {
      throw nativeError('not_found', `No such folder: "${options.startPath}".`)
    }
    const maxDepth = boundedDepth(options.maxDepth, NATIVE_LIMITS.MAX_SEARCH_DEPTH, NATIVE_LIMITS.MAX_SEARCH_DEPTH)
    const limit = boundedLimit(options.limit, NATIVE_LIMITS.MAX_SEARCH_RESULTS)
    const out: NativeNode[] = []
    const visit = (dir: Map<string, MemoryNode>, prefix: string, level: number): void => {
      if (out.length >= limit) return
      const names = [...dir.keys()].sort()
      for (const name of names) {
        if (out.length >= limit) break
        const entry = dir.get(name) as MemoryNode
        const p = prefix ? `${prefix}/${name}` : name
        const matches =
          (query.length === 0 || name.toLowerCase().includes(query)) &&
          (ext.length === 0 || name.toLowerCase().endsWith(normalizeExt(ext)))
        if (entry.kind === 'directory') {
          if (matches) out.push({ name, path: p, kind: 'directory' })
          if (level < maxDepth) visit(entry.children as Map<string, MemoryNode>, p, level + 1)
        } else if (matches) {
          out.push(this.toNode(p, entry))
        }
      }
    }
    visit(target.children as Map<string, MemoryNode>, start, 0)
    return out
  }

  async stat(_root: string, relPath: string): Promise<NativeNode> {
    const path = relPath.trim().replace(/^[/\\]+/, '')
    const target = this.nodeAt(path)
    if (!target) throw nativeError('not_found', `No such file or directory: "${relPath}".`)
    return this.toNode(path, target)
  }

  async read(_root: string, relPath: string, options: BackendReadOptions): Promise<{ content: string; bytes: number }> {
    const path = relPath.trim().replace(/^[/\\]+/, '')
    const target = this.nodeAt(path)
    if (!target) throw nativeError('not_found', `No such file or directory: "${relPath}".`)
    if (target.kind !== 'file') throw nativeError('invalid_path', `"${relPath}" is a folder, not a file.`, relPath)
    const maxBytes = boundedLimit(options.maxBytes, NATIVE_LIMITS.MAX_READ_BYTES)
    if (target.size > maxBytes) {
      throw nativeError('too_large', `"${relPath}" is ${target.size} bytes — larger than the ${maxBytes}-byte read limit.`, relPath)
    }
    return { content: target.content ?? '', bytes: target.size }
  }

  async write(_root: string, relPath: string, content: string, options: BackendWriteOptions): Promise<{ bytes: number }> {
    const path = relPath.trim().replace(/^[/\\]+/, '')
    if (!path) throw nativeError('invalid_path', 'Cannot write to the workspace root itself.', relPath)
    const maxChars = boundsOf(options.maxChars, NATIVE_LIMITS.MAX_WRITE_CHARS)
    if (content.length > maxChars) {
      throw nativeError('too_large', `Content is ${content.length} characters — larger than the ${maxChars}-character write limit.`, relPath)
    }
    const existing = this.nodeAt(path)
    if (existing && existing.kind === 'directory') {
      throw nativeError('invalid_path', `"${relPath}" is a folder, not a file.`, relPath)
    }
    if (existing && options.overwrite !== true) {
      throw nativeError('already_exists', `"${relPath}" already exists. Use overwrite: true to replace it.`, relPath)
    }
    this.writeFileAt(path, content)
    return { bytes: content.length }
  }

  async mkdir(_root: string, relPath: string): Promise<NativeNode> {
    const path = relPath.trim().replace(/^[/\\]+/, '')
    if (!path) throw nativeError('invalid_path', 'The workspace root already exists.', relPath)
    const existing = this.nodeAt(path)
    if (existing && existing.kind === 'directory') {
      return this.toNode(path, existing)
    }
    if (existing) throw nativeError('already_exists', `"${relPath}" exists and is not a directory.`, relPath)
    this.ensure(path, 'directory')
    return this.toNode(path, this.nodeAt(path) as MemoryNode)
  }

  async copy(_root: string, source: string, destination: string, options: BackendTransferOptions): Promise<void> {
    const src = source.trim().replace(/^[/\\]+/, '')
    const dst = destination.trim().replace(/^[/\\]+/, '')
    if (src === dst) throw nativeError('invalid_path', 'Source and destination are the same path.', destination)
    if (!dst) throw nativeError('invalid_path', 'The workspace root cannot be the copy target.', destination)
    const srcNode = this.nodeAt(src)
    if (!srcNode) throw nativeError('not_found', `No such file or directory: "${source}".`)
    const maxBytes = boundsOf(options.maxBytes, NATIVE_LIMITS.MAX_COPY_BYTES)
    if (srcNode.kind === 'file' && srcNode.size > maxBytes) {
      throw nativeError('too_large', `"${source}" is ${srcNode.size} bytes — larger than the ${maxBytes}-byte copy limit.`, source)
    }
    const dstNode = this.nodeAt(dst)
    if (dstNode && options.overwrite !== true) {
      throw nativeError('already_exists', `"${destination}" already exists. Use overwrite: true to replace it.`, destination)
    }
    if (srcNode.kind === 'directory') {
      const copyTree = (from: Map<string, MemoryNode>, to: string): void => {
        for (const [name, entry] of from) {
          const child = to ? `${to}/${name}` : name
          if (entry.kind === 'directory') {
            this.ensure(child, 'directory')
            copyTree(entry.children as Map<string, MemoryNode>, child)
          } else {
            this.writeFileAt(child, entry.content ?? '')
          }
        }
      }
      this.ensure(dst, 'directory')
      copyTree(srcNode.children as Map<string, MemoryNode>, dst)
    } else {
      this.writeFileAt(dst, srcNode.content ?? '')
    }
  }

  async move(_root: string, source: string, destination: string, options: BackendTransferOptions): Promise<void> {
    await this.copy(_root, source, destination, options)
    const src = source.trim().replace(/^[/\\]+/, '')
    const srcNode = this.nodeAt(src)
    if (!srcNode) throw nativeError('not_found', `No such file or directory: "${source}".`)
    const { dir, name } = this.walkTo(src)
    dir.delete(name)
  }

  async rename(_root: string, relPath: string, newName: string): Promise<NativeNode> {
    const path = relPath.trim().replace(/^[/\\]+/, '')
    if (!path) throw nativeError('invalid_path', 'The workspace root cannot be renamed.', relPath)
    const name = validateNativeSegment(newName)
    const parts = path.split('/')
    const currentName = parts[parts.length - 1]
    if (currentName === name) throw nativeError('invalid_path', `"${relPath}" is already named "${name}".`, relPath)
    const parentParts = parts.slice(0, -1)
    const parentPath = parentParts.join('/')
    const existing = this.nodeAt(path)
    if (!existing) throw nativeError('not_found', `No such file or directory: "${relPath}".`)
    const dst = parentPath ? `${parentPath}/${name}` : name
    if (this.nodeAt(dst)) throw nativeError('already_exists', `"${name}" already exists in this folder.`)
    const { dir } = this.walkTo(path)
    dir.set(name, existing)
    dir.delete(currentName)
    return this.toNode(dst, existing)
  }

  async delete(_root: string, relPath: string, options: BackendDeleteOptions): Promise<void> {
    const path = relPath.trim().replace(/^[/\\]+/, '')
    if (!path) throw nativeError('invalid_path', 'Deleting the workspace root itself is not allowed.', relPath)
    const target = this.nodeAt(path)
    if (!target) throw nativeError('not_found', `No such file or directory: "${relPath}".`)
    if (target.kind === 'directory' && options.recursive !== true && (target.children as Map<string, MemoryNode>).size > 0) {
      throw nativeError('io_error', `Folder "${relPath}" is not empty. Use recursive delete to remove it.`, relPath)
    }
    const { dir, name } = this.walkTo(path)
    dir.delete(name)
  }
}

function boundsOf(requested: unknown, cap: number): number {
  const n = Number(requested)
  if (Number.isFinite(n) && n >= 1) return Math.min(Math.floor(n), cap)
  return cap
}