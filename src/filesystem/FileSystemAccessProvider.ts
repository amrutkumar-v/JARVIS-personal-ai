import {
  FileSystemError,
  fsError,
} from './provider'
import type {
  FileSystemCapabilities,
  FileSystemNode,
  FileSystemProvider,
  FsListOptions,
  FsSearchOptions,
  FsTextStats,
  FsWriteOptions,
} from './provider'
import { FS_LIMITS, boundedDepth, boundedLimit } from './limits'
import { baseNameOf, isRootPath, normalizeSafePath, parentOf, validateSegmentName } from './paths'

/**
 * Browser File System Access API provider (Phase 1.1).
 *
 * The only REAL filesystem surface a browser SPA can reach: a directory the
 * user explicitly grants via `showDirectoryPicker`, sandboxed to that
 * directory subtree. When the API is absent or no directory has been granted,
 * every operation fails with an honest, structured `unavailable` error and
 * `capabilities().available` is false — nothing is ever faked.
 *
 * The browser vendor types for this API are not guaranteed in the TS DOM lib,
 * so the small surface JARVIS relies on is declared locally.
 */
interface FsFileHandle {
  readonly kind: 'file'
  readonly name: string
  getFile(): Promise<File>
  createWritable(): Promise<FsWritableStream>
}

interface FsDirectoryHandle {
  readonly kind: 'directory'
  readonly name: string
  entries(): AsyncIterable<[string, FsHandle]>
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FsDirectoryHandle>
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>
}

type FsHandle = FsFileHandle | FsDirectoryHandle

interface FsWritableStream {
  write(data: string | Blob): Promise<void>
  close(): Promise<void>
}

type WindowWithPicker = Window & {
  showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FsDirectoryHandle>
}

function pickerWindow(): WindowWithPicker | null {
  return typeof window !== 'undefined' ? (window as WindowWithPicker) : null
}

function hasFsApi(): boolean {
  const w = pickerWindow()
  return !!w && typeof w.showDirectoryPicker === 'function'
}

function mapHandleError(error: unknown, path: string, op: string): never {
  if (error instanceof FileSystemError) throw error
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name) : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    throw fsError('permission_denied', `Not allowed to ${op} "${path}".`, path)
  }
  if (name === 'NotFoundError') {
    throw fsError('not_found', `No such file or directory: "${path}".`, path)
  }
  if (name === 'TypeMismatchError') {
    throw fsError('invalid_path', `"${path}" is not the expected kind of entry.`, path)
  }
  throw fsError('io', `Could not ${op} "${path}".`, path)
}

export class FileSystemAccessProvider implements FileSystemProvider {
  readonly id = 'filesystem-access'
  private root: FsDirectoryHandle | null = null
  private rootName = ''

  capabilities(): FileSystemCapabilities {
    const hasApi = hasFsApi()
    const available = hasApi && this.root !== null
    const ops = Object.fromEntries(
      (['status', 'list', 'search', 'stat', 'read', 'mkdir', 'write', 'copy', 'move', 'rename', 'delete'] as const).map(
        (op) => [op, available],
      ),
    ) as FileSystemCapabilities['ops']

    let reason: string | undefined
    if (!hasApi) {
      reason =
        'This browser does not expose the File System Access API, so JARVIS cannot reach the local filesystem from the web app. A desktop/native JARVIS shell is required.'
    } else if (!this.root) {
      reason = 'The filesystem API is available, but no directory has been granted yet. Ask JARVIS to open a folder.'
    }

    return {
      available,
      reason,
      hasApi,
      rootGranted: this.root !== null,
      ops,
    }
  }

  /** Ask the user to grant a directory (must be called from a user gesture). */
  async requestAccess(): Promise<FileSystemCapabilities> {
    const w = pickerWindow()
    if (!w || typeof w.showDirectoryPicker !== 'function') {
      throw fsError('unavailable', 'The File System Access API is not available in this browser.')
    }
    try {
      const granted = await w.showDirectoryPicker({ mode: 'readwrite' })
      this.root = granted
      this.rootName = granted.name
      return this.capabilities()
    } catch (error) {
      mapHandleError(error, '', 'grant a directory for')
      throw error
    }
  }

  async list(path: string, options: FsListOptions = {}): Promise<FileSystemNode[]> {
    this.requireAvailable()
    const safe = normalizeSafePath(path)
    const limit = boundedLimit(options.limit, FS_LIMITS.MAX_LIST_RESULTS)
    const depth = boundedDepth(options.depth, options.recursive ? 1 : 0, FS_LIMITS.MAX_SEARCH_DEPTH)
    const dir = await this.resolveDirectory(safe)
    const out: FileSystemNode[] = []
    await this.walk(dir, safe, 0, depth, limit, out)
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  async search(query: string, options: FsSearchOptions = {}): Promise<FileSystemNode[]> {
    this.requireAvailable()
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
    if (needle.length > FS_LIMITS.MAX_SEARCH_QUERY_LENGTH) {
      throw fsError('invalid_path', `Search query is too long (max ${FS_LIMITS.MAX_SEARCH_QUERY_LENGTH} characters).`)
    }
    const start = options.startPath ? normalizeSafePath(options.startPath) : ''
    const limit = boundedLimit(options.limit, FS_LIMITS.MAX_SEARCH_RESULTS)
    const depth = boundedDepth(options.maxDepth, FS_LIMITS.MAX_SEARCH_DEPTH, FS_LIMITS.MAX_SEARCH_DEPTH)
    const extension = options.extension ? String(options.extension).trim().toLowerCase() : ''
    const normalizeExt = (ext: string) => (ext.startsWith('.') ? ext : `.${ext}`)

    const dir = await this.resolveDirectory(start)
    const out: FileSystemNode[] = []
    const deadline = Date.now() + FS_LIMITS.MAX_SEARCH_TIME_MS
    await this.searchTree(dir, start, 0, depth, limit, deadline, needle, normalizeExt(extension), out)
    return out
  }

  async stat(path: string): Promise<FileSystemNode> {
    this.requireAvailable()
    const safe = normalizeSafePath(path)
    if (isRootPath(safe)) return { name: this.rootName || 'workspace', path: '', kind: 'directory' }
    const parent = parentOf(safe)
    const name = baseNameOf(safe)
    const dir = await this.resolveDirectory(parent)
    let handle: FsHandle
    try {
      handle = await dir.getFileHandle(name)
    } catch (error) {
      mapHandleError(error, safe, 'inspect')
      return this.nodeFromHandle(await dir.getDirectoryHandle(name), safe)
    }
    return this.nodeFromHandle(handle, safe)
  }

  async readText(path: string, options: { maxBytes?: number } = {}): Promise<FsTextStats> {
    this.requireAvailable()
    const safe = normalizeSafePath(path)
    const maxBytes = boundedLimit(options.maxBytes, FS_LIMITS.MAX_READ_BYTES)
    const file = await this.resolveFile(safe)
    const blob = await file.getFile()
    if (blob.size > maxBytes) {
      throw fsError(
        'too_large',
        `"${safe}" is ${blob.size} bytes — larger than the ${maxBytes}-byte read limit. This read will not be attempted.`,
        safe,
      )
    }
    const content = await blob.text()
    return { content, bytes: blob.size }
  }

  async writeText(path: string, content: string, options: FsWriteOptions = {}): Promise<{ bytes: number }> {
    this.requireAvailable()
    const safe = normalizeSafePath(path)
    if (isRootPath(safe)) {
      throw fsError('invalid_path', 'Cannot write to the workspace root itself.', safe)
    }
    if (typeof content !== 'string') {
      throw fsError('invalid_path', 'Content must be text.')
    }
    if (content.length > FS_LIMITS.MAX_WRITE_CHARS) {
      throw fsError('too_large', `Content is ${content.length} characters — larger than the ${FS_LIMITS.MAX_WRITE_CHARS}-character write limit.`, safe)
    }
    const parent = parentOf(safe)
    const name = baseNameOf(safe)
    const dir = await this.resolveDirectory(parent)
    if (!options.overwrite) {
      const existing = await this.findInDir(dir, name)
      if (existing) {
        throw fsError('exists', `"${safe}" already exists. Use overwrite: true to replace it.`, safe)
      }
    }
    try {
      const target = await dir.getFileHandle(name, { create: true })
      const writable = await target.createWritable()
      await writable.write(content)
      await writable.close()
      return { bytes: content.length }
    } catch (error) {
      mapHandleError(error, safe, 'write')
      throw error
    }
  }

  async mkdir(path: string): Promise<FileSystemNode> {
    this.requireAvailable()
    const safe = normalizeSafePath(path)
    if (isRootPath(safe)) {
      throw fsError('invalid_path', 'The workspace root already exists.', safe)
    }
    const parent = parentOf(safe)
    const name = baseNameOf(safe)
    const dir = await this.resolveDirectory(parent)
    try {
      const created = await dir.getDirectoryHandle(name, { create: true })
      return this.nodeFromHandle(created, safe)
    } catch (error) {
      mapHandleError(error, safe, 'create directory')
      throw error
    }
  }

  async copy(source: string, destination: string, options: FsWriteOptions = {}): Promise<void> {
    this.requireAvailable()
    const src = normalizeSafePath(source)
    const dest = normalizeSafePath(destination)
    this.assertNotSame(src, dest)
    this.assertRootTarget(dest)
    const parent = parentOf(dest)
    const name = baseNameOf(dest)
    const destDir = await this.resolveDirectory(parent)
    if (!options.overwrite) {
      const existing = await this.findInDir(destDir, name)
      if (existing) {
        throw fsError('exists', `"${dest}" already exists. Use overwrite: true to replace it.`, dest)
      }
    }
    const file = await this.resolveFile(src)
    const blob = await file.getFile()
    if (blob.size > FS_LIMITS.MAX_COPY_BYTES) {
      throw fsError('too_large', `"${src}" is ${blob.size} bytes — larger than the ${FS_LIMITS.MAX_COPY_BYTES}-byte copy limit.`, src)
    }
    const content = await blob.text()
    try {
      const target = await destDir.getFileHandle(name, { create: true })
      const writable = await target.createWritable()
      await writable.write(content)
      await writable.close()
    } catch (error) {
      mapHandleError(error, destination, 'copy to')
      throw error
    }
  }

  async move(source: string, destination: string, options: FsWriteOptions = {}): Promise<void> {
    this.requireAvailable()
    const src = normalizeSafePath(source)
    const dest = normalizeSafePath(destination)
    this.assertNotSame(src, dest)
    this.assertRootTarget(dest)
    await this.copy(src, dest, options)
    try {
      await this.remove(src)
    } catch (error) {
      throw fsError('io', `Copied to "${dest}" but removing "${src}" failed (${error instanceof Error ? error.message : 'unknown error'}).`, src)
    }
  }

  async rename(path: string, newName: string): Promise<void> {
    this.requireAvailable()
    const safe = normalizeSafePath(path)
    this.assertRootTarget(safe)
    const name = validateSegmentName(newName)
    if (baseNameOf(safe) === name) {
      throw fsError('invalid_path', `"${safe}" is already named "${name}".`, safe)
    }
    await this.move(safe, `${parentOf(safe) ? `${parentOf(safe)}/` : ''}${name}`)
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    this.requireAvailable()
    const safe = normalizeSafePath(path)
    if (isRootPath(safe)) {
      throw fsError('invalid_path', 'Cannot delete the workspace root.', safe)
    }
    const parent = parentOf(safe)
    const name = baseNameOf(safe)
    const dir = await this.resolveDirectory(parent)
    try {
      await dir.removeEntry(name, { recursive: options.recursive === true })
    } catch (error) {
      mapHandleError(error, safe, 'delete')
      throw error
    }
  }

  /* ------------------------------------------------ internals */

  private requireAvailable(): void {
    const caps = this.capabilities()
    if (!caps.available) {
      throw fsError('unavailable', caps.reason ?? 'The filesystem provider is not available in this runtime.', '')
    }
  }

  private assertRootTarget(path: string): void {
    if (isRootPath(path)) {
      throw fsError('invalid_path', 'The workspace root cannot be the target of this operation.', path)
    }
  }

  private assertNotSame(a: string, b: string): void {
    if (a === b) {
      throw fsError('invalid_path', 'Source and destination are the same path.', a)
    }
  }

  private async resolveDirectory(path: string): Promise<FsDirectoryHandle> {
    let current: FsDirectoryHandle | null = this.root
    if (!current) {
      throw fsError('unavailable', 'No directory has been granted yet. Ask the user to open a folder.')
    }
    if (path.length === 0) return current
    for (const segment of path.split('/')) {
      try {
        current = await current.getDirectoryHandle(segment)
      } catch (error) {
        mapHandleError(error, path, 'open directory')
      }
    }
    return current
  }

  private async resolveFile(path: string): Promise<FsFileHandle> {
    const parent = parentOf(path)
    const name = baseNameOf(path)
    const dir = await this.resolveDirectory(parent)
    try {
      return await dir.getFileHandle(name)
    } catch (error) {
      mapHandleError(error, path, 'open file')
      this.assertUnreachable()
    }
  }

  private assertUnreachable(): never {
    throw fsError('io', 'Unreachable.', '')
  }

  private async findInDir(dir: FsDirectoryHandle, name: string): Promise<FsHandle | null> {
    try {
      return await dir.getFileHandle(name)
    } catch {
      /* not present */
    }
    try {
      return await dir.getDirectoryHandle(name)
    } catch {
      return null
    }
  }

  private async nodeFromHandle(handle: FsHandle, path: string): Promise<FileSystemNode> {
    const node: FileSystemNode = { name: handle.name, path, kind: handle.kind }
    if (handle.kind === 'file') {
      try {
        const file = await handle.getFile()
        node.size = file.size
        node.modifiedAt = file.lastModified
      } catch {
        /* size metadata is best-effort */
      }
    }
    return node
  }

  private async walk(
    dir: FsDirectoryHandle,
    path: string,
    level: number,
    maxDepth: number,
    limit: number,
    out: FileSystemNode[],
  ): Promise<void> {
    if (out.length >= limit) return
    for await (const [name, handle] of dir.entries()) {
      if (out.length >= limit) break
      const childPath = path ? `${path}/${name}` : name
      if (handle.kind === 'directory') {
        if (level < maxDepth) {
          await this.walk(handle as FsDirectoryHandle, childPath, level + 1, maxDepth, limit, out)
        } else {
          out.push({ name, path: childPath, kind: 'directory' })
        }
      } else {
        out.push(await this.nodeFromHandle(handle, childPath))
      }
    }
  }

  private async searchTree(
    dir: FsDirectoryHandle,
    path: string,
    level: number,
    maxDepth: number,
    limit: number,
    deadline: number,
    needle: string,
    extension: string,
    out: FileSystemNode[],
  ): Promise<void> {
    if (out.length >= limit || Date.now() > deadline) return
    for await (const [name, handle] of dir.entries()) {
      if (out.length >= limit || Date.now() > deadline) break
      const childPath = path ? `${path}/${name}` : name
      const matches = (needle.length === 0 || name.toLowerCase().includes(needle)) &&
        (extension.length === 0 || name.toLowerCase().endsWith(extension))
      if (handle.kind === 'directory') {
        if (matches) out.push({ name, path: childPath, kind: 'directory' })
        if (level < maxDepth) {
          await this.searchTree(handle as FsDirectoryHandle, childPath, level + 1, maxDepth, limit, deadline, needle, extension, out)
        }
      } else if (matches) {
        out.push(await this.nodeFromHandle(handle, childPath))
      }
    }
  }
}

/** Default production provider: the real browser File System Access API seam. */
export function createFileSystemProvider(): FileSystemProvider {
  return new FileSystemAccessProvider()
}