import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_LIMITS } from './limits.js'
import { isNativeError, nativeError } from './errors.js'
import type { NativeAppLaunchResult, NativeAppRefreshResult, NativeAppSpec, NativeAppStatusResult } from './protocol.js'
import type { ApplicationBackend } from './applications.js'
import { AppRegistry, type AppRecord } from './appRegistry.js'

/**
 * The result of running a shell-route activation (AUMID / URI) through the
 * ShellExec.exe helper: the child process reference plus its exit code. The
 * backend only uses the exit code for the activation-status classification;
 * the child reference is returned so the caller can call `.unref()`.
 */
type ShellRouteRunResult = { child: ChildProcess; exitCode: number }

/**
 * Seam used by tests so shell-route activations can be simulated with a
 * chosen exit code without ever running a real process. Matches the shape of
 * `runShellRoute` exactly. The default production implementation calls the
 * real ShellExec.exe helper and waits for it to exit (ShellExec exits as soon
 * as ShellExecute has been dispatched, so this is sub-millisecond).
 */
export type ShellRouteRunner = (route: string, applicationId: string) => Promise<ShellRouteRunResult>

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
 *       - `aumid` — the bundled ShellExec.exe helper performs ShellExecuteEx
 *                  on `shell:AppsFolder\<aumid>` for validated packaged
 *                  (Store/MSIX) applications — required so the packaged app
 *                  surfaces as a persistent foreground WINDOW;
 *       - `uri`   — the same ShellExecuteEx helper for a SAFE, allow-listed
 *                  scheme (e.g. `ms-settings:`, `whatsapp:`, `spotify:`).
 *  4. folders are only ever passed to records that declare `allowFolder`
 *     (File Explorer) and only as a validated absolute directory path;
 *  5. the process is observed over a bounded window with `tasklist` and the
 *     result is reported honestly — `verified` only when really observed alive,
 *     `unverified` when observation was unavailable. A launch is NEVER
 *     reported as success on the spawn event alone. When the spawned process
 *     defers to an already-running instance (single-instance apps), the image
 *     name still allows an honest image-level verification.
 *
 *  6. Shell-route (aumid/uri) activations additionally CONSUME the exit code
 *     returned by the ShellExec.exe fail-closed gateway:
 *        - 0 → activation dispatched to the shell; continue with verify.
 *        - 3 → ShellExecute itself failed (broken package, bad AUMID).
 *        - 4 → the ShellExec security gate REJECTED the route outright.
 *        - 5 → usage / internal error in the helper.
 *     Non-zero exit is always a structured NativeError, never a false
 *     `started:true` claim.
 *
 * `app.*` never builds a command line with user/model input beyond the fixed
 * executable path, a validated AUMID, a validated allow-listed URI, or a
 * validated absolute folder argument; there is no shell host and no arbitrary
 * execution path.
 */
export class RealAppBackend implements ApplicationBackend {
  readonly id = 'real-app'
  private readonly registry: AppRegistry
  private readonly probe: RunningProbe
  private readonly shellRouteRunner: ShellRouteRunner
  /**
   * Launch-window PID reconciler: given the set of pids the target image had
   * BEFORE the launch and the image name, returns the pid of the NEW process
   * that the launch actually produced (confirmed alive after the settle
   * window) — or undefined when no stable new process could be identified.
   * Injectable so tests can simulate hand-off without a real Windows session.
   */
  private readonly reconcile: ProcessReconciler
  private readonly listImagePids: ImagePidLister
  private readonly spawnExe: ExeLaunchSpawner

  constructor(
    registry?: AppRegistry,
    probe?: RunningProbe,
    shellRouteRunner?: ShellRouteRunner,
    reconcile?: ProcessReconciler,
    listPids: ImagePidLister = listImagePidsLive,
    spawnApp: ExeLaunchSpawner = spawnDetached,
  ) {
    this.registry = registry ?? new AppRegistry()
    this.probe = probe ?? observeRunning
    this.shellRouteRunner = shellRouteRunner ?? runShellRoute
    this.reconcile = reconcile ?? ((prePids, image, settleMs, launchedPid) =>
      reconcileLaunchPid(prePids, image, listImagePidsLive, isPidAliveLive, settleMs, launchedPid)
    )
    this.listImagePids = listPids
    this.spawnExe = spawnApp
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
    const observed = await this.probe(image)
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
        const route = 'shell:AppsFolder\\' + (record.aumid ?? '')
        const image = imageName(record)
        // Snapshot the image's pids BEFORE the activation so the shell-route
        // report can attribute the observed application process to THIS launch
        // instead of returning the short-lived ShellExec helper pid.
        const prePids = await listImagePidsLive(image)
        const result = await this.shellRouteRunner(route, applicationId)
        classifyShellExecExit(applicationId, result.exitCode)
        result.child.unref()
        const helperPid = result.child.pid
        return this.reportShellLaunch(record, applicationId, prePids, helperPid)
      }
      case 'uri': {
        const uri = record.uri ?? ''
        const image = imageName(record)
        const prePids = await listImagePidsLive(image)
        const result = await this.shellRouteRunner(uri, applicationId)
        classifyShellExecExit(applicationId, result.exitCode)
        result.child.unref()
        const helperPid = result.child.pid
        return this.reportShellLaunch(record, applicationId, prePids, helperPid)
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
        const image = imageName(record)
        // Snapshot before launch so the spawned process and any hand-off
        // replacement can be correlated with this particular request.
        const prePids = image === '' ? null : await this.listImagePids(image)
        const child = await this.spawnExe(target, folder ? [folder] : [], applicationId)
        child.unref()
        const pid = child.pid
        return this.reportExeLaunch(record, target, pid, prePids)
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

  private async reportExeLaunch(
    record: AppRecord,
    target: string,
    pid: number | undefined,
    prePids: number[] | null,
  ): Promise<NativeAppLaunchResult> {
    const image = imageName(record)
    // First: try to identify the ACTUAL application process this launch
    // produced. The spawned pid may be a transient stub that hands off to a
    // packaged app (e.g. System32\notepad.exe → WindowsApps Notepad.exe); a
    // stub pid must never be reported as the application pid.
    if (image !== '') {
      const reconciled = await this.reconcile(prePids, image, APP_LIMITS.PROCESS_VERIFY_SETTLE_MS, pid)
      if (reconciled !== undefined) {
        return {
          applicationId: record.applicationId,
          started: true,
          pid: reconciled.pid,
          verified: true,
          detail: reconciled.handoff
            ? `Launcher handed off to the real application (pid ${reconciled.pid}); verified running after the settle window.`
            : `Process launched and verified running (pid ${reconciled.pid}).`,
          handoff: reconciled.handoff,
          handoffFromPid: reconciled.handoffFromPid,
          handoffToImage: reconciled.handoffToImage,
          handoffToPid: reconciled.handoffToPid,
        }
      }
      // A child pid is an application identity only when its image is the
      // registered process image. A differently named launcher must reconcile
      // to the real application; its transient pid is never the app identity.
    }
    const sameImageAsTarget = image.toLowerCase() === basename(target).toLowerCase()
    const outcome = sameImageAsTarget ? await verifyProcess(target, pid) : 'unverified'
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
          pid: undefined,
          verified: false,
          detail: 'Process launched, but its application identity or running state could not be verified in the observation window.',
        }
      case 'refuted':
        return {
          applicationId: record.applicationId,
          started: true,
          pid: undefined,
          verified: false,
          detail: 'Process launched, but the application was not observed running in the verification window.',
        }
    }
  }

  private async reportShellLaunch(record: AppRecord, applicationId: string, prePids: number[] | null, helperPid?: number): Promise<NativeAppLaunchResult> {
    const image = imageName(record)
    if (image !== '') {
      const observed = await observeRunningStable(this.probe, image)
      if (observed.running && observed.observed) {
        // Attribute the observed application process to THIS launch: only a
        // pid that was NOT already present before the activation counts as the
        // process this launch produced (a single-instance app that was already
        // running must never be reported as this launch's process).
        const reconciled = await this.reconcile(prePids, image, APP_LIMITS.PROCESS_VERIFY_SETTLE_MS, helperPid)
        if (reconciled !== undefined) {
          return {
            applicationId,
            started: true,
            pid: reconciled.pid,
            verified: true,
            detail: reconciled.handoff
              ? `Shell activation handed off to the real application (pid ${reconciled.pid}); verified running after the settle window.`
              : `Launched via shell route and verified running (pid ${reconciled.pid}).`,
            handoff: reconciled.handoff,
            handoffFromPid: reconciled.handoffFromPid,
            handoffToImage: reconciled.handoffToImage,
            handoffToPid: reconciled.handoffToPid,
          }
        }
        // The app is running by image, but the exact process this launch
        // produced could not be pinned down (e.g. the app was already running
        // and this was a re-activation) → honest, never a guessed pid.
        return {
          applicationId,
          started: true,
          pid: undefined,
          verified: false,
          detail: `Launched via shell route and observed running by image (${image}), but the process identity produced by this launch could not be reconciled.`,
        }
      }
      if (observed.observed) {
        return {
          applicationId,
          started: true,
          pid: undefined,
          verified: false,
          detail: `Launched via shell route, but it was not observed running in the verification window (it exited, or never started).`,
        }
      }
    }
    // The ShellExec helper's own pid is a transient activation pid and is
    // NEVER reported as the application pid.
    return {
      applicationId,
      started: true,
      pid: undefined,
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

/**
 * Absolute path to the bundled ShellExec.exe helper (compiled by
 * `npm run build`), which performs ShellExecute layout on a validated shell
 * route. The helper lives beside the compiled agent in `dist/shellexec/`.
 */
export function shellExecHelperPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'shellexec', 'ShellExec.exe')
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

type RunningObservation = { running: boolean; observed: boolean; pid?: number }

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
/**
 * Probe one process image name. Injectable so the settle/verify rules below can
 * be tested deterministically without a real flashing process.
 */
export type RunningProbe = (image: string) => Promise<RunningObservation>

/** The real application process a launch produced, with hand-off evidence. */
export type ReconciledProcess = {
  pid: number
  handoff: boolean
  handoffFromPid?: number
  handoffToImage?: string
  handoffToPid?: number
}

/**
 * Given the target image's pids BEFORE a launch and the image name, return the
 * process THIS launch produced — a NEW pid (not in prePids) that is still alive
 * after the settle window. Never returns a transient launcher pid: if the
 * launched process exited during hand-off, only the surviving replacement
 * process satisfies the contract. `prePids` is null when the pre-launch
 * snapshot itself was unavailable — the answer is then honestly undefined.
 * Returns undefined whenever no stable new process could be reliably
 * attributed to the launch.
 */
export type ProcessReconciler = (
  prePids: number[] | null,
  image: string,
  settleMs: number,
  launchedPid?: number,
) => Promise<ReconciledProcess | undefined>

export type ImagePidLister = (image: string) => Promise<number[] | null>
export type ExeLaunchSpawner = (target: string, args: string[], applicationId: string) => Promise<ChildProcess>

/**
 * A positive observation must still hold after the settle window before it
 * counts. A shell/Store activation can start a process that exits immediately
 * (broken package state, one-shot hand-off); a single positive probe would then
 * report "verified running" for an app that is already gone.
 */
export async function confirmRunning(
  probe: RunningProbe,
  image: string,
  settleMs: number = APP_LIMITS.PROCESS_VERIFY_SETTLE_MS,
): Promise<RunningObservation> {
  const first = await probe(image)
  if (!first.observed || !first.running) return first
  await new Promise((r) => setTimeout(r, settleMs))
  const settled = await probe(image)
  // If the second probe cannot run, the earlier positive is no longer
  // confirmed. Return the actual second observation (including unobservable).
  return settled
}

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
  const wants = image.toLowerCase()
  for (const line of out.split('\r\n')) {
    const row = parseCsvLine(line)
    if (row.length === 0) continue
    if (row[0]?.toLowerCase() !== wants) continue
    // `tasklist /FO CSV` rows are  "image","pid",session,"session#",mem.
    // This is the ONLY place a real process identity is ever observed; carry
    // the pid with the observation so launch reports can reconcile against the
    // actual application process instead of a transient launcher.
    const pidCell = Number.parseInt(row[1] ?? '', 10)
    return {
      running: true,
      observed: true,
      pid: Number.isFinite(pidCell) && pidCell > 0 ? pidCell : undefined,
    }
  }
  return { running: false, observed: true }
}

/**
 * Poll `tasklist` over the bounded verification window (same window the exe
 * route uses) for a shell (aumid/uri) activation. Packaged apps surface their
 * process a moment after `explorer.exe` hands off to the Store activation, so
 * a single immediate probe would report a false negative for a window that is
 * already opening.
 */
export async function observeRunningStable(
  probe: RunningProbe,
  image: string,
  windowMs: number = APP_LIMITS.PROCESS_VERIFY_TOTAL_MS,
  settleMs: number = APP_LIMITS.PROCESS_VERIFY_SETTLE_MS,
): Promise<RunningObservation> {
  if (process.platform !== 'win32') {
    return { running: false, observed: false }
  }
  const deadline = Date.now() + windowMs
  let sawObservation = false
  while (Date.now() < deadline) {
    const observed = await probe(image)
    if (observed.observed) {
      sawObservation = true
      if (observed.running) {
        // Only a positive that SURVIVES the settle window is a running app.
        const confirmed = await confirmRunning(probe, image, settleMs)
        if (confirmed.running && confirmed.observed) {
          // Carry the settle-confirmed observation's real PID so the shell
          // route can reconcile the transient activation pid to the actual
          // application process instead of reporting a launcher stub.
          return { running: true, observed: true, pid: confirmed.pid }
        }
        sawObservation = sawObservation || confirmed.observed
      }
    }
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, APP_LIMITS.PROCESS_VERIFY_POLL_DELAY_MS))
  }
  return { running: false, observed: sawObservation }
}

/* ------------------------------------------------- launch pid reconciliation */

/**
 * Live `tasklist` lookup of every pid currently running the target image.
 * Fixed-args only; injectable-bounded; returns null when the snapshot cannot
 * be observed. An observed empty process list is distinct from a failed probe.
 */
export async function listImagePidsLive(image: string): Promise<number[] | null> {
  if (process.platform !== 'win32' || image === '') return null
  const out = await runTasklist(
    ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${image}`],
    APP_LIMITS.PROCESS_VERIFY_PROBE_TIMEOUT_MS,
  )
  if (out === null || out.trim().length === 0) return null
  const wants = image.toLowerCase()
  const pids: number[] = []
  for (const line of out.split('\r\n')) {
    const row = parseCsvLine(line)
    if (row.length === 0) continue
    if (row[0]?.toLowerCase() !== wants) continue
    const pid = Number.parseInt(row[1] ?? '', 10)
    if (Number.isFinite(pid) && pid > 0) pids.push(pid)
  }
  if (pids.length > 0) return pids
  // `tasklist` uses this informational row to report a successful empty
  // filter. Unknown output is not evidence that no process was present.
  return /no tasks are running/i.test(out) ? [] : null
}

/** Is this exact pid alive right now, and is it still the expected image? */
function isPidAliveLive(pid: number, image: string): Promise<boolean> {
  if (process.platform !== 'win32' || pid <= 0) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    try {
      const child = execFile(
        'tasklist',
        ['/FO', 'CSV', '/NH', '/FI', `PID eq ${pid}`],
        { windowsHide: true, timeout: APP_LIMITS.PROCESS_VERIFY_PROBE_TIMEOUT_MS, encoding: 'utf8', shell: false },
        (err, stdout) => {
          if (settled) return
          settled = true
          if (err && !stdout) {
            resolve(false)
            return
          }
          const wants = image.toLowerCase()
          const alive = (stdout as string)
            .split('\r\n')
            .some((line) => {
              const row = parseCsvLine(line)
              return row[0]?.toLowerCase() === wants && row[1] === String(pid)
            })
          resolve(alive)
        },
      )
      if (typeof child.unref === 'function') child.unref()
    } catch {
      if (!settled) {
        settled = true
        resolve(false)
      }
    }
  })
}

/**
 * Default reconciler: launch-window correlation. A pid belongs to THIS launch
 * only if it is NEW (absent before the launch) and still alive, as the same
 * image, after the settle window. When the newly spawned launcher exits during
 * hand-off, the surviving replacement process is the answer; when nothing new
 * survives, the result is undefined — an honest failure, never a transient pid.
 */
export async function reconcileLaunchPid(
  prePids: number[] | null,
  image: string,
  listPids: ImagePidLister = listImagePidsLive,
  isAlive: (pid: number, img: string) => Promise<boolean> = isPidAliveLive,
  settleMs: number = APP_LIMITS.PROCESS_VERIFY_SETTLE_MS,
  launchedPid?: number,
): Promise<ReconciledProcess | undefined> {
  // Null pre-launch snapshot: attribution is impossible — no invented answers.
  if (prePids === null) return undefined
  const before = new Set(prePids)
  await new Promise((r) => setTimeout(r, settleMs))
  // Observe the world AFTER the settle window and keep only pids that are NEW
  // (absent before the launch) and still alive as the target image.
  const collect = async (): Promise<number[] | null> => {
    const listed = await listPids(image)
    if (listed === null) return null
    const after = listed.filter((pid) => !before.has(pid))
    const survivors: number[] = []
    for (const pid of after) {
      if (await isAlive(pid, image)) survivors.push(pid)
    }
    return survivors
  }
  let survivors = await collect()
  if (survivors === null) return undefined
  if (survivors.length === 0) {
    // The launcher may have exited during the settle and handed off to a
    // replacement that only became visible afterwards; re-observe once.
    survivors = await collect()
    if (survivors === null) return undefined
  }
  if (survivors.length !== 1) return undefined
  const handoff = launchedPid !== undefined && survivors[0] !== launchedPid
  return {
    pid: survivors[0],
    handoff,
    handoffFromPid: handoff ? launchedPid : undefined,
    handoffToImage: handoff ? image : undefined,
    handoffToPid: handoff ? survivors[0] : undefined,
  }
}

/* ------------------------------------------------- shell-exec exit code */

/**
 * Map the ShellExec.exe exit code to a structured NativeError. Exit code 0
 * means the activation was dispatched to the shell; any non-zero code is a
 * hard failure that MUST NOT be reported as `started:true`.
 *
 * Exit code contract (from ShellExec.cs):
 *   0 → ok
 *   3 → ShellExecute itself returned a failure code (bad package, broken state)
 *   4 → ShellExec security gate rejected the route (fail-closed)
 *   5 → usage / argument-count error (internal: we should never hit this)
 */
function classifyShellExecExit(applicationId: string, exitCode: number): void {
  if (exitCode === 0) return
  switch (exitCode) {
    case 3:
      throw nativeError(
        'io_error',
        `Shell activation refused by Windows for "${applicationId}": ShellExecute returned a failure code.`,
        applicationId,
      )
    case 4:
      throw nativeError(
        'invalid_path',
        `The shell route for "${applicationId}" was rejected by the ShellExec security gate.`,
        applicationId,
      )
    case 5:
      throw nativeError(
        'invalid_argument',
        `ShellExec helper reported a usage error for "${applicationId}".`,
        applicationId,
      )
    default:
      throw nativeError(
        'io_error',
        `ShellExec helper exited with unexpected code ${exitCode} for "${applicationId}".`,
        applicationId,
      )
  }
}

/* ------------------------------------------------------------------ spawn */

type LaunchSpawnOptions = { detached?: boolean; windowsHide?: boolean }

/**
 * Activate a validated shell route (`shell:AppsFolder\<aumid>` or an
 * allow-listed URI) through the bundled ShellExec.exe helper, which performs
 * the real ShellExecuteEx call. Packaged (Store/MSIX) apps only surface as
 * persistent foreground WINDOWS through ShellExecute; a plain CreateProcess
 * spawn (which is all Node `spawn`/`execFile` can do) gives the app a
 * background activation that the shell quietly tears down seconds later.
 *
 * The helper is a fail-closed gateway: it re-runs the same structural
 * validation the registry already applied (an AUMID route or an allow-listed
 * URI) and refuses anything else. All arguments are constructed by the agent
 * from validated registry fields — never from user/model text.
 *
 * This function WAITS for ShellExec.exe to EXIT before returning. ShellExec
 * exits immediately after ShellExecute has been dispatched, so the wait is
 * sub-millisecond and the exit code lets the caller distinguish real
 * activations from rejected ones.
 */
async function runShellRoute(route: string, applicationId: string): Promise<ShellRouteRunResult> {
  return spawnProcessAndWait(shellExecHelperPath(), [route], applicationId, { detached: false, windowsHide: false })
}

function spawnDetached(target: string, args: string[], applicationId: string): Promise<ChildProcess> {
  return spawnProcess(target, args, applicationId, { detached: true, windowsHide: true })
}

export function spawnProcess(
  target: string,
  args: string[],
  applicationId: string,
  opts: LaunchSpawnOptions,
  spawnImpl: typeof spawn = spawn,
): Promise<ChildProcess> {
  return new Promise<ChildProcess>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(nativeError('timeout', `Launch of "${applicationId}" timed out while starting the process.`, applicationId))
    }, APP_LIMITS.LAUNCH_SPAWN_TIMEOUT_MS)

    let child: ChildProcess
    try {
      child = spawnImpl(target, args, {
        detached: opts.detached ?? true,
        stdio: 'ignore',
        windowsHide: opts.windowsHide ?? true,
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

/**
 * Variant of `spawnProcess` that additionally waits for the child to EXIT and
 * returns the exit code. Used exclusively for the ShellExec.exe helper, which
 * is a short-lived stub that exits as soon as ShellExecute has been
 * dispatched. For long-running applications (the `exe` mechanism), the
 * original `spawnProcess` is still used (we never wait for those to exit).
 */
function spawnProcessAndWait(
  target: string,
  args: string[],
  applicationId: string,
  opts: LaunchSpawnOptions,
): Promise<ShellRouteRunResult> {
  return new Promise<ShellRouteRunResult>((resolve, reject) => {
    let settled = false
    let spawnedChild: ChildProcess | undefined
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(nativeError('timeout', `Launch of "${applicationId}" timed out while starting the process.`, applicationId))
    }, APP_LIMITS.LAUNCH_SPAWN_TIMEOUT_MS)

    let child: ChildProcess
    try {
      child = spawn(target, args, {
        detached: opts.detached ?? true,
        stdio: 'ignore',
        windowsHide: opts.windowsHide ?? true,
        shell: false,
      })
    } catch (err) {
      clearTimeout(timer)
      if (settled) return
      settled = true
      reject(translateSpawnError(err, applicationId))
      return
    }
    spawnedChild = child

    child.once('error', (err) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      reject(translateSpawnError(err, applicationId))
    })
    child.once('spawn', () => {
      // Intentionally do NOT resolve on spawn: wait for exit below so the
      // caller can classify the ShellExec exit code.
    })
    child.once('exit', (code, _signal) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      // code is null when killed by signal; treat as unexpected exit code -1
      const exitCode = typeof code === 'number' ? code : -1
      void _signal
      resolve({ child: spawnedChild!, exitCode })
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
        return row[0]?.toLowerCase() === image && row[1] === String(pid)
      })
      if (found) {
        // The pid was observed — but only a pid that is still there after the
        // settle window counts as a running app (a launcher stub exits at once).
        await new Promise((r) => setTimeout(r, APP_LIMITS.PROCESS_VERIFY_SETTLE_MS))
        const settled = await runTasklist(
          ['/FO', 'CSV', '/NH', '/FI', `PID eq ${pid}`],
          APP_LIMITS.PROCESS_VERIFY_PROBE_TIMEOUT_MS,
        )
        if (settled === null) {
          observationFailed = true
        } else {
          const settledLower = settled.toLowerCase()
          const stillRunning = settledLower.split('\r\n').some((line) => {
            const row = parseCsvLine(line)
            return row[0]?.toLowerCase() === image && row[1] === String(pid)
          })
          if (stillRunning) return 'verified'
        }
      }
    }
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, APP_LIMITS.PROCESS_VERIFY_POLL_DELAY_MS))
  }

  // Tasklist never answered → the result is beyond what we can honestly say.
  if (observationFailed) return 'unverified'
  return 'refuted'
}
