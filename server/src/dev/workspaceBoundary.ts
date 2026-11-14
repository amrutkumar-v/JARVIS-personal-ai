/**
 * Workspace Boundary & Sandbox Enforcement for DevEngine (CRIT-01 Remediation).
 *
 * Implements strict host filesystem isolation:
 *  - Enforces explicit authorized workspace roots.
 *  - Rejects directory traversal and path-prefix confusion.
 *  - Resolves symlinks, directory junctions, and canonical paths on disk.
 *  - Rejects UNC, remote network, and Win32 device namespace paths.
 *  - Handles Windows drive-letter casing and case-insensitivity safely.
 *  - Fails closed on any filesystem inspection error or unresolvable path.
 */

import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface ResolvedProjectDir {
  ok: true
  dir: string
  created: boolean
}

export interface ResolvedProjectDirError {
  ok: false
  message: string
  error?: string
}

/**
 * Normalizes a candidate project path. Strips bounding quotes, trailing whitespace,
 * trailing sentence periods/colons/question marks, and normalizes separators on Windows.
 */
export function normalizeProjectPath(raw: unknown): string {
  let value = String(raw ?? '').trim()
  value = value.replace(/^["'`]+/, '').replace(/["'`]+$/, '')
  // A trailing sentence period is not part of a Windows directory name.
  value = value.replace(/[.,;:!?]+$/g, '')
  value = value.replace(/[ .]+$/g, '')
  if (process.platform === 'win32') {
    value = value.replace(/\//g, '\\')
    const isUnc = value.startsWith('\\\\')
    value = value.replace(/\\{2,}/g, '\\')
    if (isUnc && !value.startsWith('\\\\')) {
      value = '\\' + value
    }
  }
  return value
}

/**
 * Reserved Win32 DOS device names regex.
 * Matches CON, PRN, AUX, NUL, COM1-9, LPT1-9 with optional extensions (.txt, .log)
 * or trailing spaces/dots that Windows Win32 API strips during resolution.
 */
const DOS_DEVICE_REGEX = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*|[ ]+.*)?$/i

/**
 * Checks whether an individual path segment is a reserved Win32 DOS device name.
 * Handles trailing spaces and dots that Windows strips during file path normalization.
 */
export function isDosDeviceSegment(segment: string): boolean {
  if (typeof segment !== 'string') return false
  const clean = segment.trim().replace(/[ .]+$/, '')
  return DOS_DEVICE_REGEX.test(clean)
}

/**
 * Checks if any segment of a path contains a reserved Win32 DOS device name
 * (case-insensitive, with any extension, or trailing dots/spaces).
 * Checks every relevant path segment, not just the final filename.
 */
export function hasReservedDosDeviceSegment(candidatePath: string): boolean {
  if (typeof candidatePath !== 'string' || candidatePath.trim() === '') return false
  const segments = candidatePath.split(/[\\/]+/)
  for (const seg of segments) {
    if (!seg) continue
    const cleanSeg = seg.replace(/^[a-zA-Z]:$/, '')
    if (cleanSeg && isDosDeviceSegment(cleanSeg)) {
      return true
    }
  }
  return false
}

/**
 * Checks if a path is a UNC network path, SMB share, Win32 device namespace,
 * or contains a reserved Win32 DOS device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9).
 * Examples: \\server\share, //server/share, \\?\C:\Windows, \\.\PhysicalDrive0, D:\JARVIS\CON
 */
export function isUncOrDevicePath(value: string): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (
    /^[\\/]{2}/.test(trimmed) ||
    /^[\\/]\?[\\/]/.test(trimmed) ||
    /^[\\/]\.[\\/]/.test(trimmed)
  ) {
    return true
  }
  return hasReservedDosDeviceSegment(trimmed)
}

/**
 * Checks if a candidate path is an absolute filesystem path.
 * On Windows, requires a concrete drive letter (e.g. C:\ or D:\).
 */
export function isAbsoluteProjectPath(value: string): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false
  if (process.platform === 'win32') {
    return /^[a-zA-Z]:[\\/]/.test(value)
  }
  return isAbsolute(value)
}

/**
 * Checks if candidate is lexicographical equal to or a sub-path of authorizedRoot.
 * Strictly prevents prefix collision (e.g. 'D:\workspace-evil' matching 'D:\workspace').
 * Handles case-insensitivity on Windows.
 */
export function isPathInsideRoot(authorizedRoot: string, candidate: string): boolean {
  const normRoot = resolve(authorizedRoot)
  const normCand = resolve(candidate)

  if (process.platform === 'win32') {
    const rootLower = normRoot.toLowerCase()
    const candLower = normCand.toLowerCase()
    if (candLower === rootLower) return true
    const rootWithSep = rootLower.endsWith('\\') ? rootLower : rootLower + '\\'
    return candLower.startsWith(rootWithSep)
  }

  if (normCand === normRoot) return true
  const rootWithSep = normRoot.endsWith('/') ? normRoot : normRoot + '/'
  return normCand.startsWith(rootWithSep)
}

/**
 * Checks whether candidate is within any of the authorized workspace roots.
 */
export function isPathWithinAuthorizedRoots(candidate: string, allowedRoots: string[]): boolean {
  if (!allowedRoots || allowedRoots.length === 0) return false
  if (hasReservedDosDeviceSegment(candidate)) return false
  return allowedRoots.some((root) => isPathInsideRoot(root, candidate))
}

/**
 * Checks whether a candidate path represents a system root drive (e.g. C:\ or /),
 * user home profile, or sensitive OS system directory that must never be implicitly authorized.
 */
export function isExcessivelyBroadPath(candidate: string): boolean {
  if (typeof candidate !== 'string' || candidate.trim() === '') return true
  const trimmed = candidate.trim()

  // 1. Root drives on Windows (e.g. C:\, D:\, c:, C:) or Unix root (/)
  if (process.platform === 'win32') {
    if (/^[a-zA-Z]:[\\/]?$/.test(trimmed)) return true
  } else {
    if (trimmed === '/' || trimmed === '') return true
  }

  const norm = resolve(trimmed)
  if (process.platform === 'win32') {
    if (/^[a-zA-Z]:[\\/]?$/.test(norm)) return true
    const lower = norm.toLowerCase()
    try {
      const homeLower = resolve(homedir()).toLowerCase()
      if (lower === homeLower) return true
    } catch {}
    const winDir = (process.env.SystemRoot || 'C:\\Windows').toLowerCase()
    const progFiles = (process.env.ProgramFiles || 'C:\\Program Files').toLowerCase()
    const progData = (process.env.ProgramData || 'C:\\ProgramData').toLowerCase()
    if (lower === winDir || lower.startsWith(winDir + '\\')) return true
    if (lower === progFiles || lower.startsWith(progFiles + '\\')) return true
    if (lower === progData || lower.startsWith(progData + '\\')) return true
  } else {
    if (norm === '/' || norm === '') return true
    try {
      if (norm === resolve(homedir())) return true
    } catch {}
    const sensitive = ['/bin', '/sbin', '/usr', '/etc', '/var', '/boot', '/dev', '/sys', '/proc']
    if (sensitive.some((s) => norm === s || norm.startsWith(s + '/'))) return true
  }

  return false
}

/**
 * Returns the isolated, dedicated temporary directory owned by JARVIS.
 * Restricts temp access to a dedicated namespace rather than the broad OS temp root.
 */
export function getDedicatedTempWorkspace(): string {
  const dir = resolve(join(tmpdir(), 'jarvis_workspace'))
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  } catch {}
  return dir
}

/**
 * Safely parses and validates explicitly configured workspace root strings.
 * Filters out empty segments, UNC/device paths, non-absolute paths, and excessively broad directories.
 * Fails closed by returning [] if no valid roots exist.
 */
export function parseExplicitWorkspaceRoots(raw: string): string[] {
  if (typeof raw !== 'string') return []
  const trimmed = raw.trim()
  if (trimmed === '') return []

  const parts = trimmed.split(/[;,]/).map((p) => p.trim()).filter((p) => p.length > 0)
  if (parts.length === 0) return []

  const validRoots: string[] = []
  for (const part of parts) {
    if (/[\u0000-\u001f\u007f]/.test(part)) continue
    if (isUncOrDevicePath(part)) continue
    if (!isAbsoluteProjectPath(part)) continue
    if (isExcessivelyBroadPath(part)) continue

    const resolved = resolve(part)
    if (isExcessivelyBroadPath(resolved)) continue

    validRoots.push(resolved)
  }

  return Array.from(new Set(validRoots))
}

export interface WorkspaceConfigOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  production?: boolean
}

/**
 * Returns the effective authorized workspace roots for JARVIS (BACKLOG-SEC-01).
 *
 * Rules:
 *  1. When JARVIS_WORKSPACE_ROOTS (or JARVIS_WORKSPACE) is explicitly set:
 *     - Explicit environment roots REPLACE defaults entirely (never silently extended).
 *     - JARVIS_WORKSPACE_ROOTS takes deterministic precedence over JARVIS_WORKSPACE.
 *     - Malformed or invalid roots fail closed (return []).
 *  2. When no environment variables are set:
 *     - Current working directory is included ONLY if safe (not drive root or user home).
 *     - Dedicated temporary workspace (jarvis_workspace) is included.
 *     - Development convenience roots (D:\JARVIS, D:\JARVIS-Test, D:\ProjectHub) are included
 *       ONLY when NOT in production mode (production !== true and NODE_ENV !== 'production').
 */
export function getDefaultAllowedWorkspaceRoots(options: WorkspaceConfigOptions = {}): string[] {
  const env = options.env ?? process.env

  // 1. Check explicit environment configuration with deterministic precedence
  const hasRootsVar = typeof env.JARVIS_WORKSPACE_ROOTS === 'string'
  const hasSingleVar = typeof env.JARVIS_WORKSPACE === 'string'

  if (hasRootsVar || hasSingleVar) {
    const rawConfig = hasRootsVar
      ? env.JARVIS_WORKSPACE_ROOTS!
      : env.JARVIS_WORKSPACE!

    // Explicit configuration REPLACES defaults entirely. Fails closed if invalid.
    return parseExplicitWorkspaceRoots(rawConfig)
  }

  // 2. Default roots when NO explicit environment variable is set
  const roots: string[] = []
  const isProd = options.production ?? (env.NODE_ENV === 'production')

  // A. Safe current working directory (excluded if drive root or user profile)
  try {
    const cwd = options.cwd ?? process.cwd()
    if (cwd && !isExcessivelyBroadPath(cwd)) {
      roots.push(resolve(cwd))
    }
  } catch {}

  // B. Dedicated temporary workspace
  roots.push(getDedicatedTempWorkspace())

  // C. Development / Test convenience roots (only in development or test mode)
  if (!isProd) {
    const isTest = env.NODE_ENV === 'test' || Boolean(env.VITEST)
    if (isTest) {
      try {
        roots.push(resolve(tmpdir()))
      } catch {}
    }
    if (process.platform === 'win32') {
      const devRoots = ['D:\\JARVIS', 'D:\\JARVIS-Test', 'D:\\ProjectHub']
      for (const dr of devRoots) {
        if (!isExcessivelyBroadPath(dr)) {
          roots.push(resolve(dr))
        }
      }
    }
  }

  const resolved = roots.map((r) => {
    try {
      return resolve(r)
    } catch {
      return r
    }
  })

  return Array.from(new Set(resolved))
}

/**
 * Normalizes, validates, and safely resolves a project directory within authorized workspace roots.
 *
 * Enforces:
 *  - Non-empty, absolute drive path.
 *  - Rejection of UNC and device namespace paths.
 *  - Lexical containment within authorized roots (preventing prefix confusion & traversal).
 *  - Canonical symlink and junction verification (preventing link escapes to sensitive roots).
 *  - Deepest ancestor verification on directory creation (preventing creation via symlinked parents).
 *  - Fails closed on any unexpected filesystem or permission error.
 */
export function resolveProjectDir(
  raw: unknown,
  ensure = false,
  allowedRoots?: string[],
): ResolvedProjectDir | ResolvedProjectDirError {
  const normalized = normalizeProjectPath(typeof raw === 'string' ? raw : '')
  if (!normalized) {
    return {
      ok: false,
      message: 'projectPath is required and must be a concrete absolute path.',
      error: 'invalid_project_path',
    }
  }

  // 1. Reject UNC, Win32 device namespace, and reserved DOS device paths
  if (isUncOrDevicePath(normalized) || hasReservedDosDeviceSegment(normalized)) {
    return {
      ok: false,
      message: `projectPath must not be a UNC, network, or reserved device path: "${normalized}".`,
      error: 'invalid_project_path',
    }
  }

  // 2. Reject non-absolute paths
  if (!isAbsoluteProjectPath(normalized)) {
    return {
      ok: false,
      message: `projectPath must be an absolute path, received "${normalized}".`,
      error: 'invalid_project_path',
    }
  }

  const effectiveRoots = (allowedRoots !== undefined)
    ? allowedRoots
    : getDefaultAllowedWorkspaceRoots()

  // 2b. Fail closed immediately if no authorized roots are configured
  if (!effectiveRoots || effectiveRoots.length === 0) {
    return {
      ok: false,
      message: `projectPath is outside authorized workspace roots (no authorized roots configured): "${normalized}".`,
      error: 'invalid_project_path',
    }
  }

  const dir = resolve(normalized)

  // 3. Lexical containment check against authorized roots
  if (!isPathWithinAuthorizedRoots(dir, effectiveRoots)) {
    return {
      ok: false,
      message: `projectPath is outside authorized workspace roots: "${normalized}".`,
      error: 'invalid_project_path',
    }
  }

  // 4. Check existing directory on disk
  let statExists = false
  let isDirectory = false
  try {
    const st = statSync(dir)
    statExists = true
    isDirectory = st.isDirectory()
  } catch {
    statExists = false
  }

  if (statExists && !isDirectory) {
    return {
      ok: false,
      message: `projectPath is not a directory: ${dir}`,
      error: 'invalid_project_path',
    }
  }

  if (statExists) {
    // 5. Canonical symlink & junction verification
    try {
      const realDir = realpathSync(dir)
      if (!isPathWithinAuthorizedRoots(realDir, effectiveRoots)) {
        return {
          ok: false,
          message: `projectPath symlink or junction target is outside authorized workspace roots: "${realDir}".`,
          error: 'invalid_project_path',
        }
      }
      return { ok: true, dir, created: false }
    } catch (err) {
      return {
        ok: false,
        message: `Failed to resolve realpath for project directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
        error: 'invalid_project_path',
      }
    }
  }

  // Path does not exist on disk
  if (!ensure) {
    return {
      ok: false,
      message: `Project directory does not exist: ${dir}`,
      error: 'invalid_project_path',
    }
  }

  // ensure is true: directory must be created inside an authorized root
  // 6. Inspect deepest existing ancestor to prevent creation through a symlinked parent
  try {
    let ancestor = dirname(dir)
    while (ancestor && ancestor !== dirname(ancestor)) {
      if (existsSync(ancestor)) {
        const realAncestor = realpathSync(ancestor)
        if (!isPathWithinAuthorizedRoots(realAncestor, effectiveRoots)) {
          return {
            ok: false,
            message: `projectPath ancestor symlink points outside authorized workspace roots: "${realAncestor}".`,
            error: 'invalid_project_path',
          }
        }
        break
      }
      ancestor = dirname(ancestor)
    }

    mkdirSync(dir, { recursive: true })

    // Verify created directory realpath is inside authorized roots
    const realDir = realpathSync(dir)
    if (!isPathWithinAuthorizedRoots(realDir, effectiveRoots)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
      return {
        ok: false,
        message: `Created project directory escaped authorized workspace roots: "${realDir}".`,
        error: 'invalid_project_path',
      }
    }

    return { ok: true, dir, created: true }
  } catch (err) {
    return {
      ok: false,
      message: `Could not create project directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      error: 'invalid_project_path',
    }
  }
}
