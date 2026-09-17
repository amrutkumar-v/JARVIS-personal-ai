/**
 * JARVIS Core — persistent backend entry point (Phase 2.8).
 *
 *   node server/dist/index.js [--print-identity]
 *
 * Env:
 *   JARVIS_BACKEND_HOST            bind host (default 127.0.0.1)
 *   JARVIS_BACKEND_PORT            listen port (default 8787)
 *   JARVIS_BACKEND_TOKEN           optional bearer token for POST endpoints
 *   JARVIS_BACKEND_DATA_DIR        data dir (default <repo>/server/data)
 *   JARVIS_BACKEND_STATIC_DIR      built SPA dir (default <repo>/dist)
 *   JARVIS_BACKEND_NATIVE_URL      native agent probe URL (default http://127.0.0.1:8765)
 *   JARVIS_BACKEND_NATIVE_TOKEN    token used to probe / supervise the agent
 *   JARVIS_BACKEND_SUPERVISE_NATIVE (default true) launch + supervise the agent
 *   JARVIS_NATIVE_CMD              node binary for the supervised agent (default process.execPath)
 *   JARVIS_NATIVE_AGENT            agent script (default <repo>/native/dist/agentMain.js)
 *   JARVIS_NATIVE_CONFIG           agent config file (default <repo>/native/agent.config.json
 *                                  when it exists; passed as --config to register apps)
 *   JARVIS_AI_BASE_URL             upstream OpenAI-compatible base URL served through the
 *                                  server-side AI proxy (/api/ai), key kept server-side.
 *   JARVIS_AI_TIMEOUT_MS           AI proxy upstream timeout (default 60000)
 *   JARVIS_BACKEND_SILENT          (default false) no stdout log lines
 *
 * Android companion (Phase 4.1): the main backend stays loopback-only; a
 * SEPARATE narrow phone listener serves the Android app on the LAN.
 *   JARVIS_PHONE_ENABLED           (default true) run the phone LAN listener
 *   JARVIS_PHONE_HOST              bind host for the phone listener (default 0.0.0.0 —
 *                                  use your LAN IP, e.g. 192.168.1.3, to bind one adapter)
 *   JARVIS_PHONE_PORT              phone listener port (default 8788)
 *
 * Single instance: a lock file in the data dir guards against duplicates.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createLogger, type Logger } from './log.js'
import { DeviceRegistry } from './registry.js'
import { EventBus } from './events.js'
import { FileStore } from './files.js'
import { buildNativeAgentArgs, NativeSupervisor } from './native.js'
import { buildHealth } from './health.js'
import { startHttpServer, type RuntimeContext } from './http.js'
import { startPhoneServer } from './phoneServer.js'
import { PhoneTrust } from './phoneTrust.js'
import { PhoneCommandQueue } from './phoneCommands.js'
import { BACKEND_NAME, BACKEND_PROTOCOL, BACKEND_VERSION } from './version.js'

interface Env {
  host: string
  port: number
  token: string
  dataDir: string
  staticDir: string
  publicDir: string
  nativeUrl: string
  nativeToken: string
  nativeAllowedOrigins: string[]
  superviseNative: boolean
  nativeAgent: string
  nativeConfig: string
  aiBaseUrl: string
  aiKey: string
  aiTimeoutMs: number
  silent: boolean
  phoneEnabled: boolean
  phoneHost: string
  phonePort: number
}

function envString(name: string, fallback = ''): string {
  const value = process.env[name]
  return value === undefined || value.trim() === '' ? fallback : value.trim()
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (value === undefined) return fallback
  return value.trim().toLowerCase() === 'true'
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function repoRoot(): string {
  // Emitted to <repo>/server/dist, so the repo root is two levels up.
  return resolve(import.meta.dirname ?? '', '..', '..')
}

/** Resolve the native agent config file; only pass it when it actually exists. */
function resolveNativeConfig(candidate: string): string {
  return existsSync(candidate) ? candidate : ''
}

function readEnv(): Env {
  const root = repoRoot()
  return {
    host: envString('JARVIS_BACKEND_HOST', '127.0.0.1'),
    port: envInt('JARVIS_BACKEND_PORT', 8787),
    token: envString('JARVIS_BACKEND_TOKEN'),
    dataDir: envString('JARVIS_BACKEND_DATA_DIR', join(root, 'server', 'data')),
    staticDir: envString('JARVIS_BACKEND_STATIC_DIR', join(root, 'dist')),
    publicDir: join(root, 'server', 'public'),
    nativeUrl: envString('JARVIS_BACKEND_NATIVE_URL', 'http://127.0.0.1:8765'),
    nativeToken: envString('JARVIS_BACKEND_NATIVE_TOKEN'),
    nativeAllowedOrigins: envString('JARVIS_BACKEND_NATIVE_ALLOWED_ORIGINS')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
    superviseNative: envBool('JARVIS_BACKEND_SUPERVISE_NATIVE', true),
    nativeAgent: envString('JARVIS_NATIVE_AGENT', join(root, 'native', 'dist', 'agentMain.js')),
    nativeConfig: resolveNativeConfig(envString('JARVIS_NATIVE_CONFIG', join(root, 'native', 'agent.config.json'))),
    aiBaseUrl: envString('JARVIS_AI_BASE_URL'),
    aiKey: envString('JARVIS_API_KEY'),
    aiTimeoutMs: envInt('JARVIS_AI_TIMEOUT_MS', 60000),
    silent: envBool('JARVIS_BACKEND_SILENT', false),
    phoneEnabled: envBool('JARVIS_PHONE_ENABLED', true),
    phoneHost: envString('JARVIS_PHONE_HOST', '0.0.0.0'),
    phonePort: envInt('JARVIS_PHONE_PORT', 8788),
  }
}

class Backend {
  private readonly env = readEnv()
  private readonly logger: Logger
  private readonly now = () => Date.now()
  private readonly startedAt = Date.now()
  private readonly wake = { browserOnly: true as const }
  private readonly assistant: Record<string, unknown> = {}
  private supervisor: NativeSupervisor | null = null
  private lockAcquired = false
  private readonly lockFile: string

  constructor() {
    this.lockFile = join(this.env.dataDir, 'backend.pid')
    this.logger = this.env.silent
      ? createLogger({ write: () => undefined })
      : createLogger({ file: join(this.env.dataDir, 'logs', `jarvis-backend-${new Date().toISOString().slice(0, 10)}.log`) })
  }

  private async acquireLock(): Promise<void> {
    await mkdir(this.env.dataDir, { recursive: true })
    if (existsSync(this.lockFile)) {
      try {
        const raw = JSON.parse(await readFile(this.lockFile, 'utf8')) as { pid?: number; cwd?: string }
        if (typeof raw.pid === 'number' && this.ownerAlive(raw.pid)) {
          this.logger.warn('lock', 'another backend instance is already running', { pid: raw.pid })
          process.exitCode = 1
          return
        }
      } catch {
        // Stale/unreadable lock — take it over.
      }
    }
    await writeFile(this.lockFile, JSON.stringify({ pid: process.pid, name: BACKEND_NAME, version: BACKEND_VERSION, cwd: repoRoot(), startedAt: new Date().toISOString() }, null, 2), 'utf8')
    this.lockAcquired = true
  }

  private ownerAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockAcquired) return
    try {
      await unlink(this.lockFile)
    } catch {
      // Lock may already be gone.
    }
    this.lockAcquired = false
  }

  async run(printIdentity: boolean): Promise<void> {
    await this.acquireLock()
    if (process.exitCode === 1) return

    await mkdir(join(this.env.dataDir, 'logs'), { recursive: true })
    await mkdir(join(this.env.dataDir, 'files'), { recursive: true })

    if (printIdentity) {
      process.stdout.write(`${JSON.stringify({ name: BACKEND_NAME, version: BACKEND_VERSION, protocol: BACKEND_PROTOCOL, host: this.env.host, port: this.env.port, superviseNative: this.env.superviseNative })}\n`)
    }

    this.logger.info('core', 'starting', {
      version: BACKEND_VERSION,
      protocol: BACKEND_PROTOCOL,
      pid: process.pid,
      host: this.env.host,
      port: this.env.port,
      superviseNative: this.env.superviseNative,
      dataDir: this.env.dataDir,
    })

    const registry = new DeviceRegistry({
      persistFile: join(this.env.dataDir, 'devices.json'),
      now: this.now,
    })
    await registry.load()
    const bus = new EventBus()
    const files = new FileStore({ dir: join(this.env.dataDir, 'files'), now: this.now })
    const pairing = new PhoneTrust({ persistFile: join(this.env.dataDir, 'phoneTrust.json'), now: () => this.now() })
    await pairing.load()
    const deviceCommands = new PhoneCommandQueue({ now: () => this.now() })

    const nativeArgs = buildNativeAgentArgs({
      port: this.env.nativeUrl.match(/:(\d+)/)?.[1] ? Number(this.env.nativeUrl.match(/:(\d+)/)![1]) : 8765,
      token: this.env.nativeToken,
      config: this.env.nativeConfig,
      allowedOrigins: this.env.nativeAllowedOrigins,
    })

    this.supervisor = new NativeSupervisor({
      probeUrl: this.env.nativeUrl,
      token: this.env.nativeToken,
      supervise: this.env.superviseNative,
      agentScript: this.env.nativeAgent,
      agentArgs: nativeArgs,
      log: this.logger,
      now: this.now,
    })
    this.supervisor.start()

    const context: RuntimeContext = {
      name: BACKEND_NAME,
      version: BACKEND_VERSION,
      protocol: BACKEND_PROTOCOL,
      pid: process.pid,
      startedAt: this.startedAt,
      dataDir: this.env.dataDir,
      lockFile: this.lockFile,
      logFile: join(this.env.dataDir, 'logs', `jarvis-backend-${new Date().toISOString().slice(0, 10)}.log`),
      registry,
      bus,
      files,
      nativeStatus: () => this.supervisor?.status() ?? { supervising: false, connected: false, reachable: false, childRunning: false, restarts: 0 },
      assistant: this.assistant,
      wake: this.wake,
      now: this.now,
      pairing,
      deviceCommands,
      health: () =>
        buildHealth({
          name: BACKEND_NAME,
          version: BACKEND_VERSION,
          protocol: BACKEND_PROTOCOL,
          pid: process.pid,
          startedAt: this.startedAt,
          now: this.now(),
          native: this.supervisor?.status() ?? { supervising: false, connected: false, reachable: false, childRunning: false, restarts: 0 },
          registry,
          assistant: this.assistant,
          wake: this.wake,
          filesCount: files.count(),
          dataDir: this.env.dataDir,
          lockFile: this.lockFile,
          logFile: join(this.env.dataDir, 'logs', `jarvis-backend-${new Date().toISOString().slice(0, 10)}.log`),
        }),
    }

    const running = await startHttpServer({
      host: this.env.host,
      port: this.env.port,
      context,
      staticDir: this.env.staticDir,
      publicDir: this.env.publicDir,
      token: this.env.token,
      ai: this.env.aiBaseUrl
        ? { baseUrl: this.env.aiBaseUrl, key: this.env.aiKey, timeoutMs: this.env.aiTimeoutMs }
        : undefined,
      log: this.logger,
    })

    this.logger.info('core', 'ready', { url: running.url })

    let phoneRunning: { url: string; port: number; close(): Promise<void> } | null = null
    if (this.env.phoneEnabled) {
      try {
        phoneRunning = await startPhoneServer({
          host: this.env.phoneHost,
          port: this.env.phonePort,
          registry,
          pairing,
          commands: deviceCommands,
          now: this.now,
          log: this.logger,
          // Real device events (telephony call state) the phone pushes are
          // fanned out to every SSE client through the same bus as notify/file.
          bus,
        })
        this.logger.info('phone', 'phone listener ready (Android companion over LAN)', {
          url: phoneRunning.url,
          note: 'Allow this port through Windows Firewall for Private networks only, and keep the machine on your home LAN.',
        })
      } catch (error) {
        this.logger.error('phone', 'phone listener failed to start', {
          host: this.env.phoneHost,
          port: this.env.phonePort,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    let closing = false
    const shutdown = async (): Promise<void> => {
      if (closing) return
      closing = true
      this.logger.info('core', 'shutting down')
      this.supervisor?.stop()
      await phoneRunning?.close()
      await running.close()
      await registry.persist()
      await this.releaseLock()
      process.exit(0)
    }
    process.on('SIGINT', () => void shutdown())
    process.on('SIGTERM', () => void shutdown())
  }
}

function isPrintIdentity(argv: string[]): boolean {
  return argv.includes('--print-identity')
}

const backend = new Backend()
void backend.run(isPrintIdentity(process.argv.slice(2))).catch((error) => {
  process.stderr.write(`JARVIS Core failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})