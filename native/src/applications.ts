import type { NativeAppLaunchResult, NativeAppRefreshResult, NativeAppSpec, NativeAppStatusResult } from './protocol.js'

/**
 * Native Windows Agent — application backend seam (Phase 1.3).
 *
 * The agent talks to applications ONLY through this narrow interface. A real
 * backend launches registered executables with a no-shell spawn and verifies
 * them with tasklist; a tests-only memory backend drives the protocol tests
 * deterministically. Errors are always structured `NativeError`s (see
 * `./errors.js`) — never raw OS errors.
 */
export interface ApplicationBackend {
  /** Stable backend identifier (for diagnostics / testsOnly flags). */
  id: string
  /** Backends that are pure test doubles MUST set this true. */
  testsOnly?: boolean

  /** All registered applications (wire form; never exposes target paths). */
  list(): Promise<NativeAppSpec[]>

  /** Honest observation of whether an application currently appears running. */
  status(applicationId: string): Promise<NativeAppStatusResult>

  /**
   * Launch a registered application; never arbitrary paths or commands.
   * `options.folder` is a VALIDATED absolute directory that the record must
   * explicitly allow opening (File Explorer) — it is never free-form input.
   */
  launch(applicationId: string, options?: { folder?: string }): Promise<NativeAppLaunchResult>

  /**
   * Re-scan discovery sources and drop discovered entries that vanished.
   * Configured entries are never touched. Returns honest population counts.
   */
  refresh(): Promise<NativeAppRefreshResult>

  /**
   * Resolve the Windows process-image name (basename without `.exe`) that a
   * registered application runs as, so `app.close` can target the right
   * process. Returns '' when the id is not registered or not launchable —
   * callers must NOT treat '' as a process name to terminate.
   */
  resolveProcessName(applicationId: string): string
}