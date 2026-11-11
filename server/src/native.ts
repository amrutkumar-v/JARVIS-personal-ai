/**
 * Native agent supervision for the JARVIS Core backend (Phase 2.8).
 *
 * The backend can LAUNCH the real native Windows agent as a child process
 * (so the user has one thing to start), probe it on a schedule for the
 * health endpoint, and restart it on unexpected exit with bounded backoff.
 * Restarting is honest and capped: after `childRestartLimit` exits within
 * `childRestartWindowMs` the supervisor stops retrying and reports the state
 * as failed rather than looping forever.
 *
 * When supervision is disabled the supervisor still probes an externally
 * started agent, so `/health` reflects reality either way.
 */

import { spawn } from 'node:child_process'
import type { Logger } from './log.js'
import { nullLogger } from './log.js'
import { probeNativeAgent } from './jsonrpc.js'
import type { ProbeResult } from './jsonrpc.js'

export interface SpawnHandle {
  pid?: number
  onExit(callback: (code: number | null, signal: string | null) => void): void
  onError(callback: (error: Error) => void): void
  onLine(callback: (stream: 'stdout' | 'stderr', line: string) => void): void
  kill(): void
}

export type SpawnFactory = (script: string, args: string[], env: Record<string, string>) => SpawnHandle

/**
 * Build the supervised agent's CLI args.
 *
 * The bearer token is deliberately NEVER placed in argv. A child process
 * command line is readable by any local user (`wmic`/`Get-CimInstance`), so
 * the token travels to the agent through its environment instead
 * (`JARVIS_NATIVE_TOKEN`, read by the agent's existing precedence contract).
 */
export function buildNativeAgentArgs(options: {
  port: number
  token: string
  allowNoToken?: boolean
  config?: string
  allowedOrigins?: string[]
}): string[] {
  if (!options.token && options.allowNoToken !== true) {
    throw new Error('Native agent token is required. Set allowNoToken only for explicit loopback development.')
  }
  const args: string[] = [`--port`, String(options.port)]
  // A tokenless agent still needs the explicit opt-in flag; a tokenized agent
  // receives nothing here and reads JARVIS_NATIVE_TOKEN from its environment.
  if (!options.token) args.push('--no-token')
  args.push('--root', '{workspace}')
  if (options.config) args.push('--config', options.config)
  if (options.allowedOrigins && options.allowedOrigins.length > 0) {
    args.push('--allowed-origins', options.allowedOrigins.join(','))
  }
  return args
}

/**
 * Environment for the supervised agent child.
 *
 * Only the native agent token is forwarded, under the exact variable name the
 * agent already reads. No other credential is propagated, and nothing here is
 * ever rendered into argv.
 */
export function buildNativeAgentEnv(options: { token: string | undefined }): Record<string, string> {
  return options.token ? { JARVIS_NATIVE_TOKEN: options.token } : {}
}

/** Real child-process handle for `node native/dist/agentMain.js`. */
export function spawnNodeAgent(script: string, args: string[], env: Record<string, string>): SpawnHandle {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const lineCallbacks = new Set<(stream: 'stdout' | 'stderr', line: string) => void>()
  const emitLines = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      for (const cb of lineCallbacks) cb(stream, line)
    }
  }
  child.stdout?.on('data', (chunk: Buffer) => emitLines('stdout', chunk))
  child.stderr?.on('data', (chunk: Buffer) => emitLines('stderr', chunk))
  return {
    pid: child.pid,
    onExit: (cb) => child.once('exit', cb),
    onError: (cb) => child.once('error', cb),
    onLine: (cb) => lineCallbacks.add(cb),
    kill: () => {
      const pid = child.pid
      try {
        if (pid !== undefined && process.platform === 'win32') {
          // Kill the whole process tree so no orphan keeps the port alive.
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } else {
          child.kill()
        }
      } catch {
        // Already gone.
      }
    },
  }
}

export interface NativeStatus {
  supervising: boolean
  connected: boolean
  reachable: boolean
  childRunning: boolean
  /** True when an agent was already running on the port and was ADOPTED
   * instead of spawning a duplicate (orphan or user-started process). */
  adopted?: boolean
  childPid?: number
  protocol?: string
  version?: string
  platform?: string
  error?: string
  lastProbeAt?: number
  restarts: number
}

export interface NativeSupervisorOptions {
  probeUrl: string
  token?: string
  /** Explicit opt-in to a tokenless agent bound to loopback. */
  allowInsecureNoToken?: boolean
  /** Spawn the native agent as a supervised child process. */
  supervise: boolean
  /** Node script to launch for the agent (absolute path). */
  agentScript: string
  /** Native agent CLI args (port, token, roots). */
  agentArgs: string[]
  /** Injectable spawn; defaults to the real `spawnNodeAgent`. */
  spawn?: SpawnFactory
  /** Injectable probe; defaults to `probeNativeAgent`. */
  probe?: (baseUrl: string, token: string) => Promise<ProbeResult>
  probeIntervalMs?: number
  childRestartLimit?: number
  childRestartWindowMs?: number
  /** Injectable restart delay; defaults to bounded exponential backoff. */
  restartBackoff?: (attempts: number) => number
  log?: Logger
  now?: () => number
}

interface ChildState {
  handle: SpawnHandle | null
  running: boolean
  /** Timestamps of recent child exits (for the restart window). */
  exitTimes: number[]
  spawnErrorAt?: number
}

export class NativeSupervisor {
  private readonly options: NativeSupervisorOptions
  private readonly log: Logger
  private readonly now: () => number
  private readonly probeUrl: string
  private readonly child: ChildState = { handle: null, running: false, exitTimes: [] }
  private probeStatus: ProbeResult = { ok: false, connected: false, reachable: false }
  private lastProbeAt: number | undefined
  private restarts = 0
  private adopted = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private probeTimer: ReturnType<typeof setInterval> | null = null
  private shuttingDown = false
  /** Monotonic id of the newest probe; only the newest result is applied. */
  private probeSeq = 0
  private lastAppliedProbeId = 0
  /** Every child ever spawned, so a shutdown kills them ALL. */
  private readonly children = new Set<SpawnHandle>()

  constructor(options: NativeSupervisorOptions) {
    if (options.supervise && !options.token && options.allowInsecureNoToken !== true) {
      throw new Error('Refusing to supervise a tokenless native agent without explicit local-development opt-in.')
    }
    this.options = options
    this.log = options.log ?? nullLogger()
    this.now = options.now ?? (() => Date.now())
    this.probeUrl = options.probeUrl
  }

  /** Start child supervision (when enabled) and the probe loop. */
  start(): void {
    if (this.options.supervise) void this.ensureChild()
    this.probeTimer = setInterval(() => void this.probe(), this.options.probeIntervalMs ?? 5000)
    // The probe must not keep the event loop alive on its own.
    this.probeTimer.unref?.()
    void this.probe()
  }

  /**
   * Probe-first adoption. Before spawning a duplicate agent, check whether
   * something ALREADY answers on the port — if it does (a user-started agent
   * or an orphan from a hard-killed backend), adopt it instead of crashing a
   * second copy into EADDRINUSE. Only spawn when the port is genuinely dead.
   */
  private async ensureChild(): Promise<void> {
    if (this.child.running || this.restartTimer) return
    const result = await this.probe()
    if (result.ok) {
      this.adopted = true
      this.log.info('native', 'native agent already running; adopting it instead of spawning a duplicate', {
        url: this.probeUrl,
        version: result.version,
      })
      return
    }
    this.adopted = false
    this.spawnChild()
  }

  /** Bound, rolling-window child restarter. */
  private spawnChild(): void {
    if (this.shuttingDown) return
    // Never start a second agent while one is already running: two agents
    // would race for the port, and the loser's EADDRINUSE exit would burn the
    // restart budget.
    if (this.child.running) return
    const spawnFactory = this.options.spawn ?? ((script, args, env) => spawnNodeAgent(script, args, env))
    let handle: SpawnHandle
    try {
      // The token travels via the child environment, never via argv.
      handle = spawnFactory(
        this.options.agentScript,
        [...this.options.agentArgs],
        buildNativeAgentEnv({ token: this.options.token }),
      )
    } catch (error) {
      this.recordChildExit(error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.child.handle = handle
    this.child.running = true
    this.children.add(handle)
    this.adopted = false
    this.log.info('native', 'native agent child started', { pid: handle.pid })

    handle.onExit((code, signal) => {
      this.log.warn('native', 'native agent child exited', { code, signal })
      this.recordChildExit()
    })
    handle.onError((error) => {
      this.log.warn('native', 'native agent child spawn error', { error: error.message })
      this.recordChildExit(error)
    })
    if ('onLine' in handle) {
      handle.onLine((stream, line) => {
        this.log.info('native', line, { stream })
      })
    }
  }

  private recordChildExit(error?: Error): void {
    this.child.running = false
    this.child.handle = null
    if (error) this.child.spawnErrorAt = this.now()
    if (this.shuttingDown) return
    // Re-probe before restarting: if an agent now owns the port (an orphan
    // survived our redundant spawn), adopt it instead of queuing a duplicate.
    // `probe()` returns the NEWEST known state, so a slow probe that resolves
    // late cannot make this decision on stale information.
    void this.probe().then((result) => {
      if (result.ok) {
        this.adopted = true
        return
      }
      this.adopted = false
      this.scheduleRestart()
    })
  }

  private scheduleRestart(): void {
    // A restart is already pending: queueing a second one would spawn two
    // agents and orphan the first (only the last handle is killed on stop).
    if (this.restartTimer) return
    const at = this.now()
    this.child.exitTimes = this.child.exitTimes.filter((t) => at - t < (this.options.childRestartWindowMs ?? 60_000))
    this.child.exitTimes.push(at)
    const limit = this.options.childRestartLimit ?? 5
    if (this.child.exitTimes.length > limit) {
      this.log.error('native', 'native agent restart limit reached; supervision stopped', {
        restarts: this.child.exitTimes.length,
      })
      return
    }
    const backoffMs = (this.options.restartBackoff ?? ((attempts: number) => Math.min(1000 * attempts, 15_000)))(this.child.exitTimes.length)
    this.restarts += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.spawnChild()
    }, backoffMs)
    this.restartTimer.unref?.()
  }

  /** Probe the native agent and refresh connection state. */
  async probe(): Promise<ProbeResult> {
    const probe = this.options.probe ?? probeNativeAgent
    const probeId = ++this.probeSeq
    this.lastProbeAt = this.now()
    let result = await probe(this.probeUrl, this.options.token ?? '')
    if (result.ok) {
      const expectedTokenRequired = Boolean(this.options.token)
      const permittedNoToken = !expectedTokenRequired && this.options.allowInsecureNoToken === true
      if (result.tokenRequired !== expectedTokenRequired || (!expectedTokenRequired && !permittedNoToken)) {
        result = {
          ok: false,
          connected: false,
          reachable: result.reachable,
          protocol: result.protocol,
          version: result.version,
          platform: result.platform,
          tokenRequired: result.tokenRequired,
          error: expectedTokenRequired
            ? 'Native agent identity does not confirm bearer-token protection.'
            : 'Native agent is tokenless; explicit local-development opt-in is required.',
        }
      }
    }
    // A slow probe that resolves AFTER a newer one must not overwrite the
    // newer state — otherwise `/health` can report a connected agent as
    // disconnected for a whole probe interval.
    if (probeId < this.lastAppliedProbeId) return this.probeStatus
    this.lastAppliedProbeId = probeId
    this.probeStatus = result
    if (!result.ok) {
      this.log.warn('native', result.error ?? 'native agent probe failed', {
        reachable: result.reachable,
      })
    }
    return result
  }

  status(): NativeStatus {
    return {
      supervising: this.options.supervise,
      connected: this.probeStatus.ok === true,
      reachable: this.probeStatus.reachable === true,
      childRunning: this.child.running,
      adopted: this.adopted,
      childPid: this.child.running ? this.child.handle?.pid : undefined,
      protocol: this.probeStatus.protocol,
      version: this.probeStatus.version,
      platform: this.probeStatus.platform,
      error: this.probeStatus.ok ? undefined : this.probeStatus.error,
      lastProbeAt: this.lastProbeAt,
      restarts: this.restarts,
    }
  }

  stop(): void {
    this.shuttingDown = true
    if (this.probeTimer) clearInterval(this.probeTimer)
    this.probeTimer = null
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    // Kill EVERY child ever spawned: an orphan would keep holding port 8765
    // and would be adopted by the next backend boot with stale configuration.
    for (const handle of this.children) {
      try {
        handle.kill()
      } catch {
        // already gone
      }
    }
    this.children.clear()
    if (this.child.handle) this.child.handle.kill()
    this.child.handle = null
    this.child.running = false
  }
}
