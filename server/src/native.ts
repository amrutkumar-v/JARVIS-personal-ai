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
      try {
        child.kill()
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
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private probeTimer: ReturnType<typeof setInterval> | null = null
  private shuttingDown = false

  constructor(options: NativeSupervisorOptions) {
    this.options = options
    this.log = options.log ?? nullLogger()
    this.now = options.now ?? (() => Date.now())
    this.probeUrl = options.probeUrl
  }

  /** Start child supervision (when enabled) and the probe loop. */
  start(): void {
    if (this.options.supervise) this.ensureChild()
    this.probeTimer = setInterval(() => void this.probe(), this.options.probeIntervalMs ?? 5000)
    void this.probe()
  }

  /** Bound, rolling-window child restarter. */
  private spawnChild(): void {
    if (this.shuttingDown) return
    const spawnFactory = this.options.spawn ?? ((script, args, env) => spawnNodeAgent(script, args, env))
    let handle: SpawnHandle
    try {
      handle = spawnFactory(this.options.agentScript, [...this.options.agentArgs], {})
    } catch (error) {
      this.recordChildExit(error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.child.handle = handle
    this.child.running = true
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
  }

  private ensureChild(): void {
    if (this.child.running) return
    if (this.restartTimer) return
    this.spawnChild()
  }

  /** Probe the native agent and refresh connection state. */
  async probe(): Promise<ProbeResult> {
    const probe = this.options.probe ?? probeNativeAgent
    this.lastProbeAt = this.now()
    const result = await probe(this.probeUrl, this.options.token ?? '')
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
    if (this.child.handle) this.child.handle.kill()
    this.child.handle = null
    this.child.running = false
  }
}