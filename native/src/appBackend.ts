import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { basename } from 'node:path'
import { APP_LIMITS } from './limits.js'
import { nativeError } from './errors.js'
import type { NativeAppLaunchResult, NativeAppSpec, NativeAppStatusResult } from './protocol.js'
import type { ApplicationBackend } from './applications.js'
import { AppRegistry } from './appRegistry.js'

/**
 * Native Windows Agent — real application backend (Phase 1.3).
 *
 * `launch` is deliberately narrow:
 *
 *  1. the applicationId must resolve to a registered record (allow-list);
 *  2. the record must be enabled and launchable (plain .exe, not a shell host);
 *  3. the resolved target must exist on disk;
 *  4. Node's `spawn` starts the executable with NO shell (CreateProcess),
 *     detached, hidden from the console, stdio fully detached;
 *  5. the process is observed over a bounded window with `tasklist` and the
 *     result is reported honestly — `verified` only when really observed alive,
 *     `unverified` when observation was unavailable. A launch is NEVER
 *     reported as success on the spawn event alone.
 *
 * `app.*` never builds a command line with user/model input beyond the fixed
 * executable path; there is no shell host and no arbitrary execution path.
 */
export class RealAppBackend implements ApplicationBackend {
  readonly id = 'real-app'
  private readonly registry: AppRegistry

  constructor(registry?: AppRegistry) {
    this.registry = registry ?? new AppRegistry()
  }

  async list(): Promise<NativeAppSpec[]> {
    return this.registry.listRecords().map((r) => this.registry.wireSpec(r))
  }

  resolveProcessName(applicationId: string): string {
    const record = this.registry.getRecord(applicationId)
    if (!record || !record.launchable || record.target === '') return ''
    const image = basename(record.target)
    return image.toLowerCase().endsWith('.exe') ? image.slice(0, -4) : image
  }

  async status(applicationId: string): Promise<NativeAppStatusResult> {
    const record = this.registry.getRecord(applicationId)
    if (!record) {
      throw nativeError(
        'not_found',
        `Application "${applicationId}" is not registered, so it cannot be observed.`,
        applicationId,
      )
    }
    const spec = this.registry.wireSpec(record)
    if (record.target === '') {
      return { ...spec, running: false, runningVerified: false }
    }
    const observed = await observeRunning(record.target)
    return { ...spec, running: observed.running, runningVerified: observed.observed }
  }

  async launch(applicationId: string): Promise<NativeAppLaunchResult> {
    const record = this.registry.getRecord(applicationId)
    if (!record) {
      throw nativeError(
        'not_found',
        `Application "${applicationId}" is not registered, so it cannot be launched.`,
        applicationId,
      )
    }
    if (!record.enabled) {
      throw nativeError(
        'permission_denied',
        `Application "${applicationId}" is disabled; launching it is not allowed.`,
        applicationId,
      )
    }
    if (!record.launchable || record.target === '') {
      throw nativeError(
        'invalid_path',
        `Application "${applicationId}" does not resolve to a launchable target.`,
        applicationId,
      )
    }

    const target = record.target
    const existing = await safeAccess(target)
    if (!existing) {
      throw nativeError(
        'not_found',
        `The target for "${applicationId}" no longer exists, so it cannot be launched.`,
        applicationId,
      )
    }

    const child = await spawnDetached(target, applicationId)
    child.unref()
    const pid = child.pid
    const outcome = await verifyProcess(target, pid)

    switch (outcome) {
      case 'verified':
        return {
          applicationId,
          started: true,
          pid,
          verified: true,
          detail: `Process launched and verified running (pid ${pid}).`,
        }
      case 'unverified':
        return {
          applicationId,
          started: true,
          pid,
          verified: false,
          detail: `Process launched (pid ${pid}), but its state could not be verified in the observation window.`,
        }
      case 'refuted':
        return {
          applicationId,
          started: true,
          pid,
          verified: false,
          detail: `Process launched (pid ${pid}), but it was not observed running in the verification window.`,
        }
    }
  }
}

/* ------------------------------------------------------------ observation */

/** True when the target exists on disk and is a file we can execute. */
async function safeAccess(target: string): Promise<boolean> {
  try {
    const st = await access(target)
    void st
    return true
  } catch {
    return false
  }
}

type RunningObservation = { running: boolean; observed: boolean }

/** Run `tasklist` once with a bounded timeout; `null` when it failed. */
function runTasklist(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    let child: ChildProcess
    try {
      child = execFile(
        'tasklist',
        args,
        { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', shell: false },
        (err, stdout) => {
          if (settled) return
          settled = true
          resolve(err && !stdout ? null : (stdout as string))
        },
      )
      if (typeof child.unref === 'function') child.unref()
    } catch {
      if (!settled) {
        settled = true
        resolve(null)
      }
    }
  })
}

/** Parse one `/FO CSV` line into its quoted cells (`"a","b"`). */
function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  const re = /"([^"]*)"|([^",\r\n]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    cells.push(m[1] ?? m[2])
  }
  return cells
}

/** `tasklist /FO CSV /NH /FI "IMAGENAME eq <exe>"` — is any such process up? */
async function observeRunning(target: string): Promise<RunningObservation> {
  if (process.platform !== 'win32') {
    return { running: false, observed: false }
  }
  const image = basename(target)
  const out = await runTasklist(
    ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${image}`],
    APP_LIMITS.PROCESS_VERIFY_PROBE_TIMEOUT_MS,
  )
  if (out === null || out.trim().length === 0) {
    return { running: false, observed: false }
  }
  const lower = out.toLowerCase()
  const wants = image.toLowerCase()
  const running = lower.split('\r\n').some((line) => {
    const row = parseCsvLine(line)
    return row[0]?.toLowerCase() === wants
  })
  return { running, observed: true }
}

/* ------------------------------------------------------------------ spawn */

function spawnDetached(target: string, applicationId: string): Promise<ChildProcess> {
  return new Promise<ChildProcess>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(nativeError('timeout', `Launch of "${applicationId}" timed out while starting the process.`, applicationId))
    }, APP_LIMITS.LAUNCH_SPAWN_TIMEOUT_MS)

    let child: ChildProcess
    try {
      child = spawn(target, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      })
    } catch (err) {
      clearTimeout(timer)
      if (settled) return
      settled = true
      reject(translateSpawnError(err, applicationId))
      return
    }

    child.once('error', (err) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      reject(translateSpawnError(err, applicationId))
    })
    child.once('spawn', () => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve(child)
    })
  })
}

function translateSpawnError(err: unknown, applicationId: string): unknown {
  const code = (err as { code?: string })?.code
  if (code === 'ENOENT') {
    return nativeError('not_found', `The target for "${applicationId}" could not be started.`, applicationId)
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return nativeError('permission_denied', `Starting "${applicationId}" was denied by the operating system.`, applicationId)
  }
  return nativeError('io_error', `Starting "${applicationId}" failed.`, applicationId)
}

/* --------------------------------------------------------------- verify */

type VerifyOutcome = 'verified' | 'unverified' | 'refuted'

/**
 * Poll `tasklist` over a bounded window for the exact pid. Returns:
 *  - `verified` — pid observed alive within the window;
 *  - `unverified` — observation was unavailable (tasklist unreachable);
 *  - `refuted` — observation worked but the process never appeared in-window.
 */
async function verifyProcess(target: string, pid: number | undefined): Promise<VerifyOutcome> {
  if (pid === undefined || process.platform !== 'win32') return 'unverified'
  const deadline = Date.now() + APP_LIMITS.PROCESS_VERIFY_TOTAL_MS
  const image = basename(target)
  let observationFailed = false

  while (Date.now() < deadline) {
    const out = await runTasklist(
      ['/FO', 'CSV', '/NH', '/FI', `PID eq ${pid}`],
      APP_LIMITS.PROCESS_VERIFY_PROBE_TIMEOUT_MS,
    )
    if (out === null) {
      observationFailed = true
    } else {
      const lower = out.toLowerCase()
      const found = lower.split('\r\n').some((line) => {
        const row = parseCsvLine(line)
        return row[0]?.toLowerCase() === image
      })
      if (found) return 'verified'
    }
    await new Promise((r) => setTimeout(r, APP_LIMITS.PROCESS_VERIFY_POLL_DELAY_MS))
  }

  // Tasklist never answered → the result is beyond what we can honestly say.
  if (observationFailed) return 'unverified'
  return 'refuted'
}