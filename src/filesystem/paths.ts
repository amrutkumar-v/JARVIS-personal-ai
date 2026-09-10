import { fsError } from './provider'

/**
 * Safe filesystem path handling (Phase 1.1).
 *
 * User-supplied paths are untrusted input. All provider-visible paths are
 * normalized, rooted at the granted workspace root, and never allowed to
 * escape it: traversal (`..`), absolute paths, drive letters, control
 * characters and reserved device names are rejected up front rather than
 * silently reinterpreted. Paths may use `/` or `\` — both normalize to `/`.
 * `''` (or whitespace) resolves to the root itself.
 */
// oxlint-disable-next-line no-control-regex -- path safety rejects control characters on purpose
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Normalize and validate a relative filesystem path.
 * Returns a posix-style path relative to the root (`''` = root).
 * Throws a `FileSystemError` of kind `invalid_path` when unsafe.
 */
export function normalizeSafePath(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw fsError('invalid_path', 'Path must be a text string.')
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  if (CONTROL_RE.test(trimmed)) {
    throw fsError('invalid_path', 'Invalid path: contains control characters.', trimmed)
  }
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw fsError('invalid_path', 'Absolute paths are outside the granted workspace root.', trimmed)
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw fsError('invalid_path', 'Absolute paths are outside the granted workspace root.', trimmed)
  }

  const out: string[] = []
  const segments = trimmed.split(/[\\/]+/)
  for (let seg of segments) {
    seg = seg.trim()
    if (seg.length === 0 || seg === '.') continue
    if (seg === '..') {
      throw fsError('invalid_path', 'Path escapes the granted workspace root.', trimmed)
    }
    if (CONTROL_RE.test(seg)) {
      throw fsError('invalid_path', 'Invalid path: contains control characters.', trimmed)
    }
    if (RESERVED_NAME_RE.test(seg)) {
      throw fsError('invalid_path', `Invalid path segment "${seg}".`, trimmed)
    }
    out.push(seg)
  }
  return out.join('/')
}

/** True when the path is the workspace root itself. */
export function isRootPath(path: string): boolean {
  return path.length === 0
}

/** Parent of a normalized path (`''` when the path has no parent). */
export function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  if (i <= 0) return ''
  return path.slice(0, i)
}

/** Leaf name of a normalized path (the path itself when it has no parent). */
export function baseNameOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/**
 * Validate a single entry name (rename/mkdir targets). Must be a plain name:
 * no separators, no traversal, no control characters, no reserved device
 * names. Returns the trimmed name.
 */
export function validateSegmentName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw fsError('invalid_path', 'Name must be a text string.')
  }
  const name = raw.trim()
  if (name.length === 0) {
    throw fsError('invalid_path', 'Name cannot be empty.')
  }
  if (name === '.' || name === '..') {
    throw fsError('invalid_path', 'Invalid name.', name)
  }
  if (/[\\/]/.test(name)) {
    throw fsError('invalid_path', 'Name cannot contain path separators.', name)
  }
  if (CONTROL_RE.test(name)) {
    throw fsError('invalid_path', 'Invalid name: contains control characters.', name)
  }
  if (RESERVED_NAME_RE.test(name)) {
    throw fsError('invalid_path', `Reserved name "${name}" is not allowed.`, name)
  }
  return name
}