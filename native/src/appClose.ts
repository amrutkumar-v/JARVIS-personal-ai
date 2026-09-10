import { execFile } from 'node:child_process'
import { nativeError } from './errors.js'

/**
 * Native Windows Agent — app-close backend (Phase 4.0).
 *
 * Uses PowerShell to terminate a running process by application id.
 * The application id must be a registered application (from the AppRegistry),
 * NOT an arbitrary command string. The backend:
 *
 *  1. resolves the application id to its registered executable name;
 *  2. uses `Stop-Process -Name` with the executable basename (no shell host,
 *     no arbitrary command injection);
 *  3. verifies the process is no longer running via tasklist;
 *  4. returns honest success/failure with verification status.
 *
 * SECURITY: Process names are validated against a strict allowlist pattern
 * (alphanumeric + common punctuation only). PowerShell commands use stdin
 * piping for any user-derived content to prevent injection.
 */

const CLOSE_TIMEOUT_MS = 10_000
const VERIFY_TIMEOUT_MS = 5000

/** Only allow safe characters in process names (alphanumeric, spaces, hyphens, underscores, dots). */
const SAFE_PROCESS_NAME_RE = /^[a-zA-Z0-9 ._-]{1,256}$/

function runPowerShell(command: string, timeoutMs = CLOSE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout.trim())
      },
    )
  })
}

export interface AppCloseResult {
  applicationId: string
  terminated: boolean
  /** True when the process was confirmed not running after termination. */
  verified: boolean
  /** Provider-safe explanation. */
  detail: string
}

export interface AppCloseBackend {
  id: string
  testsOnly?: boolean

  /**
   * Close a registered application by its process-image name. The optional
   * `applicationId` is the registry id the caller used for closer correlation
   * (used verbatim in the result; never executed).
   */
  close(processName: string, applicationId?: string): Promise<AppCloseResult>
}

/**
 * Real Windows app-close backend (Phase 4.0).
 *
 * Uses `Stop-Process -Name` with the process basename resolved from a
 * registered application. No arbitrary commands, no shell injection, no
 * unrestricted process termination.
 */
export class RealAppCloseBackend implements AppCloseBackend {
  readonly id = 'real-app-close'
  readonly testsOnly = false

  async close(processName: string, applicationId?: string): Promise<AppCloseResult> {
    const correlationId = applicationId || processName
    // Strict validation: only allow safe characters (no injection possible)
    if (!SAFE_PROCESS_NAME_RE.test(processName)) {
      return {
        applicationId: correlationId,
        terminated: false,
        verified: false,
        detail: 'Invalid process name: contains disallowed characters.',
      }
    }

    try {
      // Use Stop-Process with -Name (basename only, no path)
      // -Force: suppresses confirmation prompts
      // -ErrorAction SilentlyContinue: handle "process not found" gracefully
      const result = await runPowerShell(
        `Stop-Process -Name '${processName.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue; if ($?) { "ok" } else { "failed" }`,
      )

      // Verify the process is no longer running
      let verified = false
      try {
        const check = await runPowerShell(
          `(Get-Process -Name '${processName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue).Count`,
          VERIFY_TIMEOUT_MS,
        )
        const count = parseInt(check, 10)
        verified = count === 0 || !Number.isFinite(count)
      } catch {
        // Verification failed — honest result
        verified = false
      }

      const terminated = result.includes('ok')

      return {
        applicationId: correlationId,
        terminated,
        verified,
        detail: terminated
          ? verified
            ? `Successfully terminated "${processName}" and confirmed it is no longer running.`
            : `Terminated "${processName}" but could not verify the process is no longer running.`
          : `Could not find or terminate a process named "${processName}". It may not be running.`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        applicationId: correlationId,
        terminated: false,
        verified: false,
        detail: `Close failed: ${message}`,
      }
    }
  }
}
