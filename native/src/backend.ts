import { promises as fsp } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { nativeError } from './errors.js'
import type { NativeError } from './errors.js'
import { NATIVE_LIMITS, boundedDepth, boundedLimit } from './limits.js'
import { assertInsideRootRealpath, resolveWithinRoot, validateNativeSegment } from './paths.js'

/**
 * Native Windows Agent — filesystem backend (Phase 1.2).
 *
 * `RealFsBackend` is the production backend: it performs REAL operations on
 * the REAL Windows filesystem via `fs.promises`. Every operation is bounded,
 * held inside a configured allowed root, and re-validated for symlink/junction
 * escapes. Tests never use this against the developer's own folders — they
 * either use an isolated temporary directory or the deterministic in-memory
 * backend (testingBackend.ts).
 */
export interface NativeNode {
  /** Entry name within its parent directory. */
  name: string
  /** Posix-style path relative to the selected root (`''` = root). */
  path: string
  kind: 'file' | 'directory'
  size?: number
  modifiedAt?: number
}

export interface BackendListOptions {
  depth: number
  limit: number
}

export interface BackendSearchOptions {
  query: string
  extension: string
  startPath: string
  maxDepth: number
  limit: number
}

export interface BackendReadOptions {
  maxBytes?: number
}

export interface BackendWriteOptions {
  overwrite: boolean
  maxChars?: number
}

export interface BackendTransferOptions {
  overwrite: boolean
  maxBytes?: number
}

export interface BackendDeleteOptions {
  recursive: boolean
}

/**
 * The one seam the agent talks to. Production wires `RealFsBackend`; tests
 * inject the deterministic in-memory backend. All paths are root-relative
 * posix strings; allowed-root enforcement and bounds are the backend's own
 * responsibility (defense in depth — broker and backend both enforce).
 */
export interface FsBackend {
  readonly id: string
  /** Positive test marker; the production backend is never marked. */
  readonly testsOnly?: boolean

  list(root: string, relPath: string, options: BackendListOptions): Promise<NativeNode[]>
  search(root: string, options: BackendSearchOptions): Promise<NativeNode[]>
  stat(root: string, relPath: string): Promise<NativeNode>
  read(root: string, relPath: string, options: BackendReadOptions): Promise<{ content: string; bytes: number }>
  write(root: string, relPath: string, content: string, options: BackendWriteOptions): Promise<{ bytes: number }>
  mkdir(root: string, relPath: string): Promise<NativeNode>
  copy(root: string, source: string, destination: string, options: BackendTransferOptions): Promise<void>
  move(root: string, source: string, destination: string, options: BackendTransferOptions): Promise<void>
  rename(root: string, relPath: string, newName: string): Promise<NativeNode>
  delete(root: string, relPath: string, options: BackendDeleteOptions): Promise<void>
}

/** Map a raw Node fs error to a structured NativeError (never leak raw text). */
export function mapFsError(error: unknown, operation: string): NativeError {
  if (error instanceof Error && error.name === 'NativeError') return error as NativeError
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return nativeError('not_found', `No such file or directory while trying to ${operation}.`)
  }
  if (code === 'EEXIST') {
    return nativeError('already_exists', `Already exists while trying to ${operation}.`)
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR') {
    return nativeError('permission_denied', `Not allowed to ${operation}.`)
  }
  if (code === 'ELOOP') {
    return nativeError('invalid_path', `Path loop while trying to ${operation}.`)
  }
  return nativeError('io_error', `Could not ${operation}.`)
}

function entryNode(rel: string, name: string, stats: Stats): NativeNode {
  const node: NativeNode = {
    name,
    path: rel,
    kind: stats.isDirectory() ? 'directory' : 'file',
    modifiedAt: stats.mtimeMs,
  }
  if (stats.isFile()) node.size = stats.size
  return node
}

/** Realpath contained check + real stat wrapper used before every op. */
async function containedStat(root: string, abs: string, operation: string): Promise<Stats> {
  await assertInsideRootRealpath(root, abs)
  try {
    return await fsp.stat(abs)
  } catch (error) {
    throw mapFsError(error, operation)
  }
}

/** Resolve an entry's real target for traversal; null when it escapes the root. */
async function resolveContainedTarget(root: string, abs: string): Promise<string | null> {
  try {
    const real = await fsp.realpath(abs)
    if (!isWithinRootForReal(root, real)) return null
    return real
  } catch {
    return null
  }
}

function isWithinRootForReal(root: string, abs: string): boolean {
  const r = root.toLowerCase()
  const a = abs.toLowerCase()
  return a === r || a.startsWith(`${r}\\`) || a.startsWith(`${r}/`)
}

export class RealFsBackend implements FsBackend {
  readonly id = 'real-native-fs'

  async list(root: string, relPath: string, options: BackendListOptions): Promise<NativeNode[]> {
    const { abs, rel } = resolveWithinRoot(root, relPath)
    const depth = boundedDepth(options.depth, 1, NATIVE_LIMITS.MAX_SEARCH_DEPTH)
    const limit = boundedLimit(options.limit, NATIVE_LIMITS.MAX_LIST_RESULTS)
    const self = await containedStat(root, abs, 'open folder')
    if (!self.isDirectory()) {
      throw nativeError('invalid_path', `"${relPath}" is not a directory.`, relPath)
    }
    const out: NativeNode[] = []
    await this.walkList(root, abs, rel, 0, depth, limit, out)
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  private async walkList(
    root: string,
    abs: string,
    rel: string,
    level: number,
    maxDepth: number,
    limit: number,
    out: NativeNode[],
  ): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true })
    } catch (error) {
      throw mapFsError(error, 'list folder')
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (out.length >= limit) break
      const childAbs = join(abs, entry.name)
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const isDir = entry.isDirectory()
      const isLink = entry.isSymbolicLink()
      if (isLink) {
        // Do not follow links blindly: only surface them when they stay inside
        // the root, never descend through an escaping link.
        const target = await resolveContainedTarget(root, childAbs)
        if (target === null) continue
        let stats: Stats
        try {
          stats = await fsp.stat(target)
        } catch {
          continue
        }
        if (stats.isDirectory()) {
          if (level < maxDepth) {
            await this.walkList(root, target, childRel, level + 1, maxDepth, limit, out)
          } else {
            out.push({ name: entry.name, path: childRel, kind: 'directory' })
          }
        } else {
          out.push({ name: entry.name, path: childRel, kind: 'file', size: stats.size, modifiedAt: stats.mtimeMs })
        }
        continue
      }
      if (isDir) {
        if (level < maxDepth) {
          await this.walkList(root, childAbs, childRel, level + 1, maxDepth, limit, out)
        } else {
          out.push({ name: entry.name, path: childRel, kind: 'directory' })
        }
      } else {
        let stats: Stats
        try {
          stats = await fsp.stat(childAbs)
        } catch (error) {
          throw mapFsError(error, 'list entry')
        }
        out.push({ name: entry.name, path: childRel, kind: 'file', size: stats.size, modifiedAt: stats.mtimeMs })
      }
    }
  }

  async search(root: string, options: BackendSearchOptions): Promise<NativeNode[]> {
    const start = resolveWithinRoot(root, options.startPath)
    const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''
    if (query.length > NATIVE_LIMITS.MAX_SEARCH_QUERY_LENGTH) {
      throw nativeError('invalid_path', `Search query is too long (max ${NATIVE_LIMITS.MAX_SEARCH_QUERY_LENGTH} characters).`)
    }
    const ext = options.extension ? String(options.extension).trim().toLowerCase() : ''
    const normalizeExt = (e: string) => (e.startsWith('.') ? e : `.${e}`)
    const limit = boundedLimit(options.limit, NATIVE_LIMITS.MAX_SEARCH_RESULTS)
    const maxDepth = boundedDepth(options.maxDepth, NATIVE_LIMITS.MAX_SEARCH_DEPTH, NATIVE_LIMITS.MAX_SEARCH_DEPTH)
    const self = await containedStat(root, start.abs, 'open folder')
    if (!self.isDirectory()) {
      throw nativeError('invalid_path', `"${options.startPath || '.'}" is not a directory.`, options.startPath)
    }
    const out: NativeNode[] = []
    const deadline = Date.now() + NATIVE_LIMITS.MAX_SEARCH_TIME_MS
    await this.searchTree(root, start.abs, start.rel, 0, maxDepth, limit, deadline, query, normalizeExt(ext), out)
    return out
  }

  private async searchTree(
    root: string,
    abs: string,
    rel: string,
    level: number,
    maxDepth: number,
    limit: number,
    deadline: number,
    query: string,
    extension: string,
    out: NativeNode[],
  ): Promise<void> {
    if (out.length >= limit || Date.now() > deadline) return
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true })
    } catch (error) {
      throw mapFsError(error, 'search folder')
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (out.length >= limit || Date.now() > deadline) break
      const childAbs = join(abs, entry.name)
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const matches =
        (query.length === 0 || entry.name.toLowerCase().includes(query)) &&
        (extension.length === 0 || entry.name.toLowerCase().endsWith(extension))
      const isLink = entry.isSymbolicLink()
      if (isLink) {
        const target = await resolveContainedTarget(root, childAbs)
        if (target === null) continue
        let stats: Stats
        try {
          stats = await fsp.stat(target)
        } catch {
          continue
        }
        if (stats.isDirectory()) {
          if (matches) out.push({ name: entry.name, path: childRel, kind: 'directory' })
          if (level < maxDepth) {
            await this.searchTree(root, target, childRel, level + 1, maxDepth, limit, deadline, query, extension, out)
          }
        } else if (matches) {
          out.push({ name: entry.name, path: childRel, kind: 'file', size: stats.size, modifiedAt: stats.mtimeMs })
        }
        continue
      }
      if (entry.isDirectory()) {
        if (matches) out.push({ name: entry.name, path: childRel, kind: 'directory' })
        if (level < maxDepth) {
          await this.searchTree(root, childAbs, childRel, level + 1, maxDepth, limit, deadline, query, extension, out)
        }
      } else if (matches) {
        let stats: Stats
        try {
          stats = await fsp.stat(childAbs)
        } catch (error) {
          throw mapFsError(error, 'search entry')
        }
        out.push({ name: entry.name, path: childRel, kind: 'file', size: stats.size, modifiedAt: stats.mtimeMs })
      }
    }
  }

  async stat(root: string, relPath: string): Promise<NativeNode> {
    const { abs, rel } = resolveWithinRoot(root, relPath)
    const stats = await containedStat(root, abs, 'inspect')
    const name = rel === '' ? basename(root) || root : basename(abs)
    return entryNode(rel, name, stats)
  }

  async read(root: string, relPath: string, options: BackendReadOptions): Promise<{ content: string; bytes: number }> {
    const { abs } = resolveWithinRoot(root, relPath)
    const stats = await containedStat(root, abs, 'read')
    if (stats.isDirectory()) {
      throw nativeError('invalid_path', `"${relPath}" is a folder, not a file.`, relPath)
    }
    const maxBytes = boundedLimit(options.maxBytes, NATIVE_LIMITS.MAX_READ_BYTES)
    if (stats.size > maxBytes) {
      throw nativeError(
        'too_large',
        `"${relPath}" is ${stats.size} bytes — larger than the ${maxBytes}-byte read limit. This read will not be attempted.`,
        relPath,
      )
    }
    let buffer: Buffer
    try {
      buffer = await fsp.readFile(abs)
    } catch (error) {
      throw mapFsError(error, 'read')
    }
    if (buffer.byteLength > maxBytes) {
      throw nativeError('too_large', `"${relPath}" grew past the ${maxBytes}-byte read limit while being read.`, relPath)
    }
    return { content: buffer.toString('utf8'), bytes: buffer.byteLength }
  }

  async write(root: string, relPath: string, content: string, options: BackendWriteOptions): Promise<{ bytes: number }> {
    const { abs, rel } = resolveWithinRoot(root, relPath)
    if (rel === '') {
      throw nativeError('invalid_path', 'Cannot write to the workspace root itself.', relPath)
    }
    if (typeof content !== 'string') {
      throw nativeError('invalid_path', 'Content must be text.')
    }
    if (content.length > boundsOf(options.maxChars, NATIVE_LIMITS.MAX_WRITE_CHARS)) {
      throw nativeError(
        'too_large',
        `Content is ${content.length} characters — larger than the ${NATIVE_LIMITS.MAX_WRITE_CHARS}-character write limit.`,
        relPath,
      )
    }
    await assertInsideRootRealpath(root, abs)
    let previous: Stats | null = null
    try {
      previous = await fsp.lstat(abs)
    } catch {
      previous = null
    }
    if (previous !== null && previous.isDirectory()) {
      throw nativeError('invalid_path', `"${relPath}" is a folder, not a file.`, relPath)
    }
    if (previous !== null && options.overwrite !== true) {
      throw nativeError('already_exists', `"${relPath}" already exists. Use overwrite: true to replace it.`, relPath)
    }
    try {
      await fsp.writeFile(abs, content, 'utf8')
    } catch (error) {
      throw mapFsError(error, 'write')
    }
    return { bytes: Buffer.byteLength(content, 'utf8') }
  }

  async mkdir(root: string, relPath: string): Promise<NativeNode> {
    const { abs, rel } = resolveWithinRoot(root, relPath)
    if (rel === '') {
      throw nativeError('invalid_path', 'The workspace root already exists.', relPath)
    }
    await assertInsideRootRealpath(root, abs)
    let existing: Stats | null = null
    try {
      existing = await fsp.lstat(abs)
    } catch {
      existing = null
    }
    if (existing !== null && existing.isDirectory()) {
      // Idempotent: creating an existing folder is a success (matches the
      // browser provider). A FILE at that path is not a folder though.
    } else if (existing !== null) {
      throw nativeError('already_exists', `"${relPath}" exists and is not a directory.`, relPath)
    } else {
      try {
        await fsp.mkdir(abs)
      } catch (error) {
        throw mapFsError(error, 'create folder')
      }
    }
    const stats = await containedStat(root, abs, 'inspect')
    return { name: basename(abs), path: rel, kind: 'directory', modifiedAt: stats.mtimeMs }
  }

  async copy(root: string, source: string, destination: string, options: BackendTransferOptions): Promise<void> {
    const src = resolveWithinRoot(root, source)
    const dst = resolveWithinRoot(root, destination)
    if (src.abs === dst.abs) {
      throw nativeError('invalid_path', 'Source and destination are the same path.', destination)
    }
    if (dst.rel === '') {
      throw nativeError('invalid_path', 'The workspace root cannot be the copy target.', destination)
    }
    const srcStats = await containedStat(root, src.abs, 'copy source')
    await assertInsideRootRealpath(root, dst.abs)
    let dstExists = false
    try {
      await fsp.lstat(dst.abs)
      dstExists = true
    } catch {
      dstExists = false
    }
    if (dstExists && options.overwrite !== true) {
      throw nativeError('already_exists', `"${destination}" already exists. Use overwrite: true to replace it.`, destination)
    }
    const maxBytes = boundsOf(options.maxBytes, NATIVE_LIMITS.MAX_COPY_BYTES)
    if (srcStats.isDirectory()) {
      const budget = { remaining: maxBytes }
      await this.copyDir(root, src.abs, dst.abs, budget)
    } else {
      if (srcStats.size > maxBytes) {
        throw nativeError(
          'too_large',
          `"${source}" is ${srcStats.size} bytes — larger than the ${maxBytes}-byte copy limit.`,
          source,
        )
      }
      try {
        await fsp.copyFile(src.abs, dst.abs, dstExists ? 0 : fsp.constants.COPYFILE_EXCL)
      } catch (error) {
        throw mapFsError(error, 'copy to')
      }
    }
  }

  private async copyDir(root: string, srcAbs: string, dstAbs: string, budget: { remaining: number }): Promise<void> {
    try {
      await fsp.mkdir(dstAbs)
    } catch (error) {
      const existing = await fsp.lstat(dstAbs).catch(() => null)
      if (existing === null) throw mapFsError(error, 'create copy folder')
    }
    const entries = await fsp.readdir(srcAbs, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const childSrc = join(srcAbs, entry.name)
      const childDst = join(dstAbs, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await resolveContainedTarget(root, childSrc)
        if (target === null) continue
      }
      if (entry.isDirectory()) {
        await this.copyDir(root, childSrc, childDst, budget)
      } else {
        let stats: Stats
        try {
          stats = await fsp.stat(childSrc)
        } catch (error) {
          throw mapFsError(error, 'copy entry')
        }
        if (stats.size > budget.remaining) {
          throw nativeError(
            'too_large',
            `Recursive copy exceeds the ${NATIVE_LIMITS.MAX_COPY_BYTES}-byte copy limit.`,
            entry.name,
          )
        }
        budget.remaining -= stats.size
        try {
          await fsp.copyFile(childSrc, childDst)
        } catch (error) {
          throw mapFsError(error, 'copy entry to')
        }
      }
    }
  }

  async move(root: string, source: string, destination: string, options: BackendTransferOptions): Promise<void> {
    const src = resolveWithinRoot(root, source)
    const dst = resolveWithinRoot(root, destination)
    if (src.abs === dst.abs) {
      throw nativeError('invalid_path', 'Source and destination are the same path.', destination)
    }
    if (dst.rel === '') {
      throw nativeError('invalid_path', 'The workspace root cannot be the move target.', destination)
    }
    // Copy first (with the same bounds), then remove the source — this keeps
    // move atomic from the caller's perspective and works across drives.
    await this.copy(root, source, destination, options)
    try {
      const before = await containedStat(root, src.abs, 'move source')
      await fsp.rm(src.abs, { recursive: before.isDirectory(), force: false })
    } catch {
      throw nativeError(
        'io_error',
        `Copied to "${destination}" but removing "${source}" failed.`,
        source,
      )
    }
  }

  async rename(root: string, relPath: string, newName: string): Promise<NativeNode> {
    const { abs, rel } = resolveWithinRoot(root, relPath)
    if (rel === '') {
      throw nativeError('invalid_path', 'The workspace root cannot be renamed.', relPath)
    }
    const name = validateNativeSegment(newName)
    const parent = dirname(abs)
    const dst = join(parent, name)
    const nameOfSource = basename(abs)
    if (nameOfSource === name) {
      throw nativeError('invalid_path', `"${relPath}" is already named "${name}".`, relPath)
    }
    await assertInsideRootRealpath(root, abs)
    await assertInsideRootRealpath(root, dst)
    let dstExists = false
    try {
      await fsp.lstat(dst)
      dstExists = true
    } catch {
      dstExists = false
    }
    if (dstExists) {
      throw nativeError('already_exists', `"${name}" already exists in this folder.`, `${parent}/${name}`)
    }
    try {
      await fsp.rename(abs, dst)
    } catch (error) {
      throw mapFsError(error, 'rename')
    }
    const newRel = rel.split('/').slice(0, -1).concat(name).join('/')
    const stats = await containedStat(root, dst, 'inspect')
    return { name, path: newRel, kind: stats.isDirectory() ? 'directory' : 'file', size: stats.isFile() ? stats.size : undefined, modifiedAt: stats.mtimeMs }
  }

  async delete(root: string, relPath: string, options: BackendDeleteOptions): Promise<void> {
    const { abs, rel } = resolveWithinRoot(root, relPath)
    if (rel === '') {
      throw nativeError('invalid_path', 'Deleting the workspace root itself is not allowed.', relPath)
    }
    await assertInsideRootRealpath(root, abs)
    try {
      await fsp.rm(abs, { recursive: options.recursive === true, force: false })
    } catch (error) {
      throw mapFsError(error, 'delete')
    }
  }
}

function boundsOf(requested: unknown, cap: number): number {
  const n = Number(requested)
  if (Number.isFinite(n) && n >= 1) return Math.min(Math.floor(n), cap)
  return cap
}