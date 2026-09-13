/**
 * Web-side application capability contract (Phase 1.3).
 *
 * Mirrors the native wire types (`native/src/protocol.ts`) WITHOUT importing
 * them: this module is compiled by the strict app tsconfig and must stay
 * self-contained, so the id charset + validation are duplicated here by design
 * (platform-facing bridge types live in `src/native/NativeWindowsApplicationProvider.ts`).
 *
 * A provider exposes the app.list / app.status / app.launch surface to the
 * engine ONLY when a real backend is supplied. Browser mode yields no APP_*
 * tools at all — never a fabricated/in-memory "system".
 */
export type AppSource = 'configured' | 'discovered' | 'appPaths' | 'packaged' | 'system'

export interface AppSpec {
  applicationId: string
  name?: string
  displayName: string
  source: AppSource
  enabled: boolean
  /** Resolved target exists and is a plain .exe (not a shell host). */
  launchable: boolean
  /** How the native agent starts it: 'exe' | 'aumid' | 'uri' (absent = exe). */
  launchMechanism?: 'exe' | 'aumid' | 'uri'
  /** Extra names the native registry can resolve this application by. */
  aliases?: string[]
  /** Process-image name (basename without `.exe`) used for honest observation. */
  processImage?: string
}

export interface AppStatus extends AppSpec {
  /** Whether the application process is currently running (best-effort). */
  running: boolean
  /** False when the platform cannot be verified (non-Windows/native off). */
  runningVerified: boolean
}

export interface AppLaunchResult {
  applicationId: string
  started: boolean
  pid?: number
  /** True = the process is confirmed running by the backend. */
  verified: boolean
  /** Provider-safe explanation (never a raw OS error). */
  detail: string
}

export interface AppRefreshResult {
  total: number
  discovered: number
  configured: number
  refreshedAt: number
}

export type AppOp = 'list' | 'status' | 'launch' | 'refresh'

export interface ApplicationCapabilities {
  /** False when the native agent is unreachable / not Windows. */
  available: boolean
  reason?: string
  ops: Record<AppOp, boolean>
}

export interface ApplicationProvider {
  id: string
  capabilities(): ApplicationCapabilities
  /** Async re-probe; used for the engine start() wiring seam. */
  refreshNativeStatus?(): Promise<void>
  list(): Promise<AppSpec[]>
  status(applicationId: string): Promise<AppStatus>
  /** Launch by application id. `options.folder` is a validated absolute
   * directory, passed only to applications that explicitly allow it. */
  launch(applicationId: string, options?: { folder?: string }): Promise<AppLaunchResult>
  /** Re-run native discovery. Optional — only when supported. */
  refresh?(): Promise<AppRefreshResult>
  /** Close a registered application by its id. Optional — only when the native agent supports it. */
  close?(applicationId: string): Promise<AppCloseResult>
}

export interface AppCloseResult {
  applicationId: string
  terminated: boolean
  verified: boolean
  detail: string
}

/** Id charset matches APP_ID_PATTERN (dashboard-style, never a path). */
export const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Normalize + validate an application id for the web side. Returns a trimmed
 * id on success, or a human reason on failure (discriminated union).
 */
export function normalizeApplicationId(input: unknown): { id: string } | { error: string } {
  if (typeof input !== 'string') return { error: 'applicationId must be a string.' }
  const id = input.trim()
  if (id.length === 0) return { error: 'applicationId must not be empty.' }
  if (id.length > 64) return { error: 'applicationId must be at most 64 characters.' }
  if (!APP_ID_PATTERN.test(id)) {
    return { error: 'applicationId must start with a letter or digit and use only letters, digits, ".", "_" or "-".' }
  }
  return { id }
}

/** Max characters of a normalized display-name slug. */
export const APP_TARGET_MAX_CHARS = 64

/**
 * Convert a human phrase (display name, brand name, alias, "Google Chrome")
 * into an app-id-shaped target string: lowercase, non-alphanumeric runs of
 * separation become a single "-", bounded to APP_TARGET_MAX_CHARS. The native
 * registry is the authoritative resolver — this keeps the web side honest by
 * producing the same id shape the native `resolve()` understands.
 */
export function normalizeAppTarget(claim: string): string {
  const trimmed = claim.trim()
  const slug =
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, APP_TARGET_MAX_CHARS)
  return slug.length > 0 ? slug : trimmed.toLowerCase().slice(0, APP_TARGET_MAX_CHARS) || ''
}