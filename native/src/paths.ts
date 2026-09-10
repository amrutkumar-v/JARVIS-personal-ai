import { promises as fsp } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { nativeError } from './errors.js'

/**
 * Native Windows Agent — path safety (Phase 1.2).
 *
 * Second line of defense behind the Web path validators: user-supplied paths
 * are untrusted, so the agent re-validates every relative path before touching
 * the real filesystem. Rules enforced here, independent of the Web side:
 *   - paths are relative to a configured allowed root only;
 *   - traversal (`..`), absolute paths, drive letters, UNC prefixes, control
 *     characters, reserved device names and Windows-illegal characters are
 *     rejected up front ("defense in depth" — never rely on one validator);
 *   - after resolution, the target must still live inside the root
 *     (case-insensitive containment check);
 *   - symlinks/junctions are resolved and must land inside the root, so a link
 *     inside the workspace can never smuggle access outside it.
 */
// oxlint-disable-next-line no-control-regex -- path safety rejects control characters on purpose
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
/** Characters Windows refuses in a file/directory name. */
const ILLEGAL_SEGMENT_RE = /[:*?"<>|]/
const WIN_DRIVE_RE = /^[A-Za-z]:[\\/]/
const UNC_RE = /^[\\/]{2}/

export interface ResolvedTarget {
  /** Absolute native path (inside one configured root). */
  abs: string
  /** Posix-style path relative to the root (`''` = root). */
  rel: string
}

/**
 * Normalize and validate a root-relative path. Returns the posix-style path
 * (`''` = root). Throws `NativeError(invalid_path)` when unsafe.
 */
export function normalizeRelPath(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw nativeError('invalid_path', 'Path must be a text string.')
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  if (CONTROL_RE.test(trimmed)) {
    throw nativeError('invalid_path', 'Invalid path: contains control characters.')
  }
  if (UNC_RE.test(trimmed)) {
    throw nativeError('invalid_path', 'UNC paths are not allowed inside a workspace root.')
  }
  if (WIN_DRIVE_RE.test(trimmed)) {
    throw nativeError('invalid_path', 'Absolute or drive-prefixed paths are not allowed.')
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw nativeError('invalid_path', 'Absolute paths are not allowed inside a workspace root.')
  }

  const out: string[] = []
  const segments = trimmed.split(/[\\/]+/)
  for (let seg of segments) {
    seg = seg.trim()
    if (seg.length === 0 || seg === '.') continue
    if (seg === '..') {
      throw nativeError('invalid_path', 'Path escapes the workspace root.')
    }
    if (CONTROL_RE.test(seg)) {
      throw nativeError('invalid_path', 'Invalid path: contains control characters.')
    }
    if (ILLEGAL_SEGMENT_RE.test(seg)) {
      throw nativeError('invalid_path', `Invalid path segment "${seg}".`)
    }
    if (RESERVED_NAME_RE.test(seg)) {
      throw nativeError('invalid_path', `Invalid path segment "${seg}".`)
    }
    out.push(seg)
  }
  return out.join('/')
}

/**
 * Validate a single entry name (rename/mkdir targets): plain names only — no
 * separators, no traversal, no control chars, no reserved or illegal chars.
 */
export function validateNativeSegment(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw nativeError('invalid_path', 'Name must be a text string.')
  }
  const name = raw.trim()
  if (name.length === 0) {
    throw nativeError('invalid_path', 'Name cannot be empty.')
  }
  if (name === '.' || name === '..') {
    throw nativeError('invalid_path', 'Invalid name.')
  }
  if (/[\\/]/.test(name)) {
    throw nativeError('invalid_path', 'Name cannot contain path separators.')
  }
  if (CONTROL_RE.test(name)) {
    throw nativeError('invalid_path', 'Invalid name: contains control characters.')
  }
  if (ILLEGAL_SEGMENT_RE.test(name)) {
    throw nativeError('invalid_path', `Invalid name "${name}".`)
  }
  if (RESERVED_NAME_RE.test(name)) {
    throw nativeError('invalid_path', `Reserved name "${name}" is not allowed.`)
  }
  return name
}

/** Case-insensitive containment test (Windows paths are case-insensitive). */
export function isWithinRoot(root: string, candidateAbs: string): boolean {
  if (isAbsolute(candidateAbs) === false) return false
  const rootNorm = root.toLowerCase()
  const candNorm = candidateAbs.toLowerCase()
  return candNorm === rootNorm || candNorm.startsWith(`${rootNorm}\\`) || candNorm.startsWith(`${rootNorm}/`)
}

/**
 * Resolve a root-relative path to an absolute target inside `root`.
 * Restricts the result to the root BEFORE any filesystem access.
 */
export function resolveWithinRoot(root: string, rawRel: unknown): ResolvedTarget {
  if (typeof root !== 'string' || root.length === 0 || isAbsolute(root) === false) {
    throw nativeError('invalid_path', 'A native agent root must be an absolute path.')
  }
  const rel = normalizeRelPath(rawRel)
  const abs = join(root, ...(rel.length === 0 ? [] : rel.split('/')))
  if (!isWithinRoot(root, abs)) {
    throw nativeError('outside_allowed_root', 'Path resolves outside the allowed root.')
  }
  return { abs, rel }
}

/** Realpath of the deepest existing ancestor of `abs` (stops at `stop`). */
async function realpathOfNearestExisting(abs: string, stop: string): Promise<string> {
  let current = abs
  for (;;) {
    try {
      return await fsp.realpath(current)
    } catch {
      /* absolute path does not exist yet → walk up to the nearest existing ancestor */
    }
    const parent = parentAbs(current)
    if (parent === current || parent === stop) {
      return fsp.realpath(stop)
    }
    current = parent
  }
}

function parentAbs(abs: string): string {
  const idx = Math.max(abs.lastIndexOf('\\'), abs.lastIndexOf('/'))
  if (idx <= 0) return abs
  return abs.slice(0, idx)
}

/**
 * Symlink/junction containment: after `resolveWithinRoot`, verify the target
 * (or its nearest existing ancestor) does not realpath to a location outside
 * the root. Called by the backend before every real filesystem operation.
 */
export async function assertInsideRootRealpath(root: string, abs: string): Promise<void> {
  if (!isWithinRoot(root, abs)) {
    throw nativeError('outside_allowed_root', 'Path resolves outside the allowed root.')
  }
  let realRoot: string
  try {
    realRoot = await fsp.realpath(root)
  } catch {
    // Root does not exist (e.g. a configured root not yet created): the target
    // is unreachable, but this is "not found", never a link escape.
    throw nativeError('not_found', 'The target path is not available.', abs)
  }
  let realAbs: string
  try {
    realAbs = await realpathOfNearestExisting(abs, root)
  } catch {
    throw nativeError('not_found', 'The target path is not available.', abs)
  }
  if (!isWithinRoot(realRoot, realAbs)) {
    throw nativeError('outside_allowed_root', 'Path resolves outside the allowed root (via a link).')
  }
}