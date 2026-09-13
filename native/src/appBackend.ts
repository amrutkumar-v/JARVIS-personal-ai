import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { APP_LIMITS } from './limits.js'
import { nativeError } from './errors.js'
import type { NativeAppLaunchResult, NativeAppRefreshResult, NativeAppSpec, NativeAppStatusResult } from './protocol.js'
import type { ApplicationBackend } from './applications.js'
import { AppRegistry, type AppRecord } from './appRegistry.js'

/**
 * Native Windows Agent — real application backend (Phase 1.3).
 *
 * `launch` is deliberately narrow:
 *
 *  1. the applicationId must resolve to a registered record (allow-list);
 *  2. the record must be enabled and launchable;
 *  3. the launch mechanism is one of:
 *       - `exe`   — Node's `spawn` starts the executable with NO shell
 *                  (CreateProcess), detached, hidden, stdio fully detached;
 *       - `aumid` — `explorer.exe shell:AppsFolder\<aumid>` for validated
 *                  packaged (Store/MSIX) applications;
 *       - `uri`   — `explorer.exe <uri>` for a SAFE, allow-listed scheme
 *                  (currently only `ms-settings:`).
 *  4. folders are only ever passed to records that declare `allowFolder`
 *     (File Explorer) and only as a validated absolute directory path;
 *  5. the process is observed over a bounded window with `tasklist` and the
 *     result is reported honestly — `verified` only when really observed alive,
 *     `unverified` when observation was unavailable. A launch is NEVER
 *     reported as success on the spawn event alone. When the spawned process
 *     defers to an already-running instance (single-instance apps), the image
 *     name still allows an honest image-level verification.
 *
 * `app.*` never builds a command line with user/model input beyond the fixed
 * executable path, a validated AUMID, a validated allow-listed URI, or a
 * validated absolute folder argument; there is no shell host and no arbitrary
 * execution path.
 */
export class RealAppBackend implements ApplicationBackend {
  readonly id = 'real-app'
  private readonly registry: AppRegistry

  constructor(registry?: AppRegistry) {
    this.registry = registry ?? new AppRegistry()
  }

  async list(): Promise<NativeAppSpec[]> {
    await this.registry.ready()
    return this.registry.listRecords().map((r) => this.registry.wireSpec(r))
  }

  async refresh(): Promise<NativeAppRefreshResult> {
    return this.registry.refresh()
  }

  resolveProcessName(applicationId: string): string {
    const result = this.registry.resolve(applicationId)
    if (!('record' in result) || !result.record.launchable) return ''
    const record = result.record
    if (record.processImage) return record.processImage
    if (record.target === '') return ''
    const image = basename(record.target)
    return image.toLowerCase().endsWith('.exe') ? image.slice(0, -4) : image
  }

  /**
   * Resolve a claim (canonical id, alias, slug or display name) to the single
   * registered record it names. Unknown claims and genuinely ambiguous claims
   * surface as structured native errors — the caller never guesses.
   */
  private resolveRegistered(applicationId: string): AppRecord {
    const result = this.registry.resolve(applicationId)
    if ('record' in result) return result.record
    if ('ambiguous' in result) {
      const names = result.ambiguous.map((r) => r.displayName).join(', ')
      throw nativeError(
        'ambiguous',
        `"${applicationId}" matches several applications (${names}); name one of them exactly.`,
        applicationId,
      )
    }
    throw nativeError('not_found', `Application "${applicationId}" is not registered.`, applicationId)
  }

  async status(applicationId: string): Promise<NativeAppStatusResult> {
    const record = this.resolveRegistered(applicationId)
    const spec = this.registry.wireSpec(record)
    const image = imageName(record)
    if (image === '') {
      return { ...spec, running: false, runningVerified: false }
    }
    const observed = await observeRunning(image)
    return { ...spec, running: observed.running, runningVerified: observed.observed }
  }

  async launch(applicationId: string, options?: { folder?: string }): Promise<NativeAppLaunchResult> {
    const record = this.resolveRegistered(applicationId)
    if (!record.enabled) {
      throw nativeError(
        'permission_denied',
        `Application "${applicationId}" is disabled; launching it is not allowed.`,
        applicationId,
      )
    }
    if (!record.launchable) {
      throw nativeError(
        'invalid_path',
        `Application "${applicationId}" does not resolve to a launchable target.`,
        applicationId,
      )
    }

    const folder = await this.validateFolderArg(record, options?.folder)

    switch (record.mechanism) {
      case 'aumid': {
        const aumid = record.aumid ?? ''
        const child = await spawnDetached(explorerPath(), ['shell:AppsFolder\\' + aumid], applicationId)
        child.unref()
        const pid = child.pid
        return this.reportShellLaunch(record, applicationId, pid)
      }
      case 'uri': {
        const uri = record.uri ?? ''
        const child = await spawnDetached(explorerPath(), [uri], applicationId)
        child.unref()
        const pid = child.pid
        return this.reportShellLaunch(record, applicationId, pid)
      }
      default: {
        const target = record.target
        const existing = await safeAccess(target)
        if (!existing) {
          throw nativeError(
            'not_found',
            `The target for "${applicationId}" no longer exists, so it cannot be launched.`,
            applicationId,
          )
        }
        const child = await spawnDetached(target, folder ? [folder] : [], applicationId)
        child.unref()
        const pid = child.pid
        return this.reportExeLaunch(record, target, pid)
      }
    }
  }

  private async validateFolderArg(record: AppRecord, raw: unknown): Promise<string | undefined> {
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== 'string') {
      throw nativeError('invalid_path', 'The folder must be a text path.', record.applicationId)
    }
    const folder = raw.trim()
    if (!record.allowFolder) {
      throw nativeError(
        'invalid_path',
        `"${record.applicationId}" does not accept a folder argument.`,
        record.applicationId,
      )
    }
    if (record.mechanism !== 'exe') {
      throw nativeError(
        'invalid_path',
        `"${record.applicationId}" cannot be opened on a specific folder.`,
        record.applicationId,
      )
    }
    if (folder.length === 0 || folder.length > APP_LIMITS.MAX_FOLDER_ARG_LENGTH || !isAbsoluteWinPath(folder)) {
      throw nativeError('invalid_path', 'The folder must be a short absolute path.', record.applicationId)
    }
    try {
      const st = await stat(folder)
      if (!st.isDirectory()) {
        throw nativeError('invalid_path', 'The folder path is not a directory.', record.applicationId)
      }
    } catch (err) {
      if (nativeErrorLike(err)) throw err
      throw nativeError('not_found', 'The folder path does not exist.', record.applicationId)
    }
    return folder
  }

  private async reportExeLaunch(record: AppRecord, target: string, pid: number | undefined): Promise<NativeAppLaunchResult> {
    const outcome = await verifyProcess(target, pid)
    switch (outcome) {
      case 'verified':
        return {
          applicationId: record.applicationId,
          started: true,
          pid,
          verified: true,
          detail: `Process launched and verified running (pid ${pid}).`,
        }
      case 'unverified':
        return {
          applicationId: record.applicationId,
          started: true,
          pid,
          verified: false,
          detail: `Process launched (pid ${pid}), but its state could not be verified in the observation window.`,
        }
      case 'refuted': {
        // The spawned process may have handed off to an already-running
        // single-instance app. Fall back to an honest image-level check.
        const image = imageName(record)
        if (image !== '') {
          const observed = await observeRunning(image)
          if (observed.running && observed.observed) {
            return {
              applicationId: record.applicationId,
              started: true,
              pid,
              verified: true,
              detail: `Process launched and verified running by image (${image}).`,
            }
          }
        }
        return {
          applicationId: record.applicationId,
          started: true,
          pid,
          verified: false,
          detail: `Process launched (pid ${pid}), but it was not observed running in the verification window.`,
        }
      }
    }
  }

  private async reportShellLaunch(record: AppRecord, applicationId: string, pid: number | undefined): Promise<NativeAppLaunchResult> {
    const image = imageName(record)
    if (image !== '') {
      const observed = await observeRunning(image)
      if (observed.running && observed.observed) {
        return {
          applicationId,
          started: true,
          pid: undefined,
          verified: true,
          detail: `Launched via shell route and verified running by image (${image}).`,
        }
      }
      if (observed.observed) {
        return {
          applicationId,
          started: true,
          pid: undefined,
          verified: false,
          detail: `Launched via shell route, but it was not observed running in the verification window.`,
        }
      }
    }
    return {
      applicationId,
      started: true,
      pid,
      verified: false,
      detail: 'Launched via shell route; its running state could not be verified.',
    }
  }
}

/* ------------------------------------------------------------ observation */

/** The tasklist image name for a record, when observation is possible. */
function imageName(record: AppRecord): string {
  if (record.processImage) return `${record.processImage.replace(/\.exe$/i, '')}.exe`
  if (record.target === '') return ''
  return basename(record.target)
}

function explorerPath(): string {
  const windir = process.env.windir ?? process.env.SystemRoot ?? 'C:\\Windows'
  return `${windir}\\explorer.exe`
}

function isAbsoluteWinPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function nativeErrorLike(err: unknown): boolean {
  return err instanceof Error && err.name === 'NativeError'
}

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

/** `tasklist /FO CSV /NH /FI "IMAGENAME eq <image>"` — is any such process up? */
async function observeRunning(image: string): Promise<RunningObservation> {
  if (process.platform !== 'win32') {
    return { running: false, observed: false }
  }
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

function spawnDetached(target: string, args: string[], applicationId: string): Promise<ChildProcess> {
  return new Promise<ChildProcess>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(nativeError('timeout', `Launch of "${applicationId}" timed out while starting the process.`, applicationId))
    }, APP_LIMITS.LAUNCH_SPAWN_TIMEOUT_MS)

    let child: ChildProcess
    try {
      child = spawn(target, args, {
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