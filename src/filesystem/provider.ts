import type { FS_LIMITS } from './limits'

/**
 * Filesystem capability seam (Phase 1.1).
 *
 * JARVIS runs in a browser SPA with no native shell, so raw OS filesystem
 * access is impossible. This module defines the ONE abstraction every
 * filesystem tool speaks to. A provider reports, honestly, what the current
 * runtime can actually do (per operation), and only ever performs REAL
 * operations on a REAL user-granted directory handle (File System Access
 * API). Nothing in the production path pretends an in-memory change was a
 * real filesystem change — the deterministic in-memory provider exists
 * strictly for tests (see testing.ts).
 *
 * All paths are relative to the provider root (`''` = root), posix-style,
 * validated by src/filesystem/paths.ts.
 */
export type FsKind = 'file' | 'directory'

export type FsOp =
  | 'status'
  | 'list'
  | 'search'
  | 'stat'
  | 'read'
  | 'mkdir'
  | 'write'
  | 'copy'
  | 'move'
  | 'rename'
  | 'delete'

export type FsErrorKind =
  | 'unavailable'
  | 'not_found'
  | 'exists'
  | 'invalid_path'
  | 'permission_denied'
  | 'too_large'
  | 'unsupported'
  | 'timeout'
  | 'io'

/** Typed, provider-safe filesystem failure. Tools map these to ToolResult. */
export class FileSystemError extends Error {
  readonly kind: FsErrorKind
  readonly path?: string

  constructor(kind: FsErrorKind, message: string, path?: string) {
    super(message)
    this.name = 'FileSystemError'
    this.kind = kind
    this.path = path
  }
}

export function fsError(kind: FsErrorKind, message: string, path?: string): FileSystemError {
  return new FileSystemError(kind, message, path)
}

export interface FileSystemNode {
  /** Entry name within its parent directory. */
  name: string
  /** Posix-style path relative to the root (`''`, `notes/a.txt`). */
  path: string
  kind: FsKind
  /** Bytes; present for files when known. */
  size?: number
  /** Last modification time (epoch ms); present when known. */
  modifiedAt?: number
}

/**
 * Honest capability report. `available` is true only when the runtime can
 * perform real filesystem operations right now; when false, `reason` says why
 * (no File System Access API / no directory granted yet / unavailable).
 */
export interface FileSystemCapabilities {
  available: boolean
  reason?: string
  /** The runtime exposes a real File System Access API. */
  hasApi: boolean
  /** A directory was granted by the user and is the active root. */
  rootGranted: boolean
  /** Per-operation support under the current runtime. */
  ops: Record<FsOp, boolean>
}

export interface FsListOptions {
  recursive?: boolean
  /** Max directory nesting below `path`. */
  depth?: number
  /** Max entries returned (bounded by FS_LIMITS.MAX_LIST_RESULTS). */
  limit?: number
}

export interface FsSearchOptions {
  /** Case-insensitive substring match on entry names. */
  query?: string
  /** Extension filter, e.g. '.txt' (with or without the dot). */
  extension?: string
  /** Search rooted here instead of the provider root. */
  startPath?: string
  /** Max nesting depth below the root (bounded by FS_LIMITS.MAX_SEARCH_DEPTH). */
  maxDepth?: number
  /** Max results (bounded by FS_LIMITS.MAX_SEARCH_RESULTS). */
  limit?: number
}

export interface FsWriteOptions {
  /** Explicitly allow replacing an existing file. Never silent. */
  overwrite?: boolean
}

export interface FsTextStats {
  content: string
  /** Bytes actually read. */
  bytes: number
}

/**
 * Honest diagnostic about an optional native capability surface (Phase 1.2).
 * Only safe metadata: platform/arch/version/roots plus connection state. Never
 * credentials, user names or machine identifiers.
 */
export interface NativePlatformStatus {
  connected: boolean
  platform?: string
  version?: string
  roots?: string[]
  reason?: string
}

export interface FileSystemProvider {
  readonly id: string

  /** Honest report of what this runtime can do right now. */
  capabilities(): FileSystemCapabilities

  /**
   * When the provider is backed by a native bridge, its live diagnostic
   * status. Absent for browser/granted/test providers.
   */
  nativeStatus?(): NativePlatformStatus | undefined

  /** Manually refresh the bridge diagnostic (bounded probe). */
  refreshNativeStatus?(): Promise<NativePlatformStatus | undefined>

  /**
   * Browser only: ask the user to grant a directory (showDirectoryPicker).
   * Not required (or supported) for injected/test providers.
   */
  requestAccess?(): Promise<FileSystemCapabilities>

  list(path: string, options?: FsListOptions): Promise<FileSystemNode[]>
  search(query: string, options?: FsSearchOptions): Promise<FileSystemNode[]>
  stat(path: string): Promise<FileSystemNode>
  readText(path: string, options?: { maxBytes?: number }): Promise<FsTextStats>
  writeText(path: string, content: string, options?: FsWriteOptions): Promise<{ bytes: number }>
  mkdir(path: string): Promise<FileSystemNode>
  copy(source: string, destination: string, options?: FsWriteOptions): Promise<void>
  move(source: string, destination: string, options?: FsWriteOptions): Promise<void>
  rename(path: string, newName: string): Promise<void>
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
}

export type { FS_LIMITS }