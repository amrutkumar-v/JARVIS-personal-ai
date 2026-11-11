/**
 * Shared safety validators for folder paths and application targets.
 * Used by both reasoning validation and goal validation to keep the
 * security boundary consistent.
 */

const UNSAFE_PATH =
  /([a-zA-Z]:[\\/]|^\s*[\\/][\\/]|\.\.|[\u0001-\u001f]|(^|[/\\])etc([/\\]|$)|[/\\]system32([/\\]|$)|%[a-zA-Z][a-zA-Z0-9_]*%)/i

const PATH_LIKE_APP_TARGET = /[\\/:[\]|]/
const SHELL_INJECTION = /[;&|$`<>]/

const SAFE_FOLDER_PREFIXES = ['{userprofile}', '{workspace}', '{temp}']

/**
 * A folder argument is only safe when it is a bounded curated token under the
 * user profile / workspace / temp roots. No absolute paths, never a raw
 * user-supplied path.
 */
export function isSafeFolder(value: string): boolean {
  if (value.trim().length === 0 || value.length > 260) return false
  if (UNSAFE_PATH.test(value)) return false
  return SAFE_FOLDER_PREFIXES.some((prefix) => {
    if (value === prefix) return true
    if (value.startsWith(prefix)) {
      return value.charAt(prefix.length) === '\\' && !value.includes('..')
    }
    return false
  })
}

/**
 * An application target (id/alias typed by the model) must be a NAME.
 * Never a path, executable, or shell command.
 */
export function isSafeApplicationTarget(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 64) return false
  if (PATH_LIKE_APP_TARGET.test(trimmed)) return false
  if (SHELL_INJECTION.test(trimmed)) return false
  if (/\.exe$/i.test(trimmed)) return false
  if (/\.(bat|cmd|ps1|sh|com)$/i.test(trimmed)) return false
  if (UNSAFE_PATH.test(trimmed)) return false
  return true
}

/**
 * Detect whether a tool schema property represents a folder/path argument.
 * This replaces the fragile name-based regex with schema-based detection.
 */
export function isFolderPathProperty(property: { type: string; description?: string }): boolean {
  if (property.type !== 'string') return false
  const desc = (property.description ?? '').toLowerCase()
  return /folder|path|directory|location/.test(desc)
}

/**
 * Detect a path argument that the TOOL resolves against a root the tool OWNS
 * (the granted workspace root), rather than one that must be a curated token.
 *
 * The filesystem family declares this in its schema — every path argument is
 * documented as "relative to the workspace root". Those arguments are NOT
 * `{userprofile}` / `{workspace}` / `{temp}` tokens; they are ordinary
 * workspace-relative paths, and the enforcement point for them is the TOOL's
 * own normalizer (`src/filesystem/paths.ts` → `normalizeSafePath`), which
 * rejects absolute paths, drive letters, traversal, control characters and
 * reserved device names before any provider sees the path.
 *
 * Curated-folder arguments (e.g. `open_folder`'s `folder`) do NOT carry that
 * wording and keep the strict curated-token rule.
 */
export function isWorkspaceRelativeProperty(property: { type: string; description?: string }): boolean {
  if (property.type !== 'string') return false
  return (property.description ?? '').toLowerCase().includes('workspace root')
}

/**
 * A workspace-relative path argument.
 *
 * This is the FIRST line of defence for the filesystem family, not the only
 * one: the tool re-validates the same shapes through `normalizeSafePath`
 * before touching the provider. The shapes rejected here are exactly the ones
 * that must never reach a tool — an absolute path, a drive letter, a UNC
 * path, a traversal, a control character, a shell-style `%VAR%` expansion and
 * the sensitive system directories.
 *
 * Unlike `isSafeFolder`, a plain relative path ("notes", "notes/todo.txt",
 * "shopping.txt") is legal here, because these arguments are resolved against
 * a root the tool owns.
 */
export function isSafeWorkspacePath(value: string): boolean {
  const trimmed = value.trim()
  // The root itself is legal ("" = the workspace root).
  if (trimmed.length === 0) return true
  if (trimmed.length > 260) return false
  if (UNSAFE_PATH.test(trimmed)) return false
  // A drive letter ("C:", "C:\…") is never workspace-relative.
  if (/^[A-Za-z]:/.test(trimmed)) return false
  // An absolute or UNC path is never workspace-relative.
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return false
  return true
}

/**
 * Detect whether a tool schema property represents an application target argument.
 */
export function isApplicationTargetProperty(property: { type: string; description?: string }): boolean {
  if (property.type !== 'string') return false
  const desc = (property.description ?? '').toLowerCase()
  return /application[_-]?id|app[_-]?id|target/.test(desc)
}