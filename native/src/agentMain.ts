import { readFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { startAgent } from './agent.js'
import { APP_ID_PATTERN, NATIVE_AGENT_VERSION, NATIVE_DEFAULT_HOST, NATIVE_DEFAULT_PORT, NATIVE_PROTOCOL } from './protocol.js'
import { APP_LIMITS } from './limits.js'
import { RealFsBackend } from './backend.js'
import { AppRegistry, type AppRegistration } from './appRegistry.js'
import { RealAppBackend } from './appBackend.js'
import { RealObsBackend } from './obsWin32.js'
import { RealDesktopInteractionBackend } from './desktopInput.js'

/**
 * Native Windows Agent — command-line entry point (Phase 1.2 + 1.3 + 1.4 + 1.5).
 *
 *   node native/dist/agentMain.js [--port 8765] [--token ...|--no-token]
 *                                  [--root <abs>]... [--config <json>] [--print-identity]
 *
 * Root path tokens (expanded at startup): `{userprofile}`, `{temp}`,
 * `{workspace}` (= `<temp>/jarvis/workspace`, the default scratch root),
 * `{windir}` (Windows directory, Phase 1.3), and a leading `~`. No personal
 * directory names are hard-coded — personal folders like Desktop/Documents/
 * Downloads must be granted explicitly as absolute paths in the config file.
 *
 * Desktop interaction (Phase 1.5) is bound ONLY when running on Windows; the
 * banner says so honestly. Input is injected through the user32 SendInput
 * family with strict bounds (see desktopLimits.ts + desktop.ts).
 *
 * Applications (Phase 1.3) come from the config file only:
 *
 *   {
 *     "applications": {
 *       "notepad":  { "name": "Notepad", "target": "{windir}\\System32\\notepad.exe" },
 *       "calc":     { "target": "{windir}\\System32\\calc.exe", "enabled": false },
 *       "visual-studio-code": { "target": "{userprofile}\\AppData\\Local\\Programs\\..."
 *     }
 *   }
 *
 * No personal or machine-specific absolute paths are committed anywhere; all
 * targets go through tokens. Discovered Start Menu entries are listed but only
 * configured apps are guaranteed launchable.
 */

interface CliArgs {
  port?: number
  host?: string
  token?: string
  noToken?: boolean
  roots?: string[]
  config?: string
  help?: boolean
  printIdentity?: boolean
}

const TOKENS: Record<string, () => string> = {
  '{userprofile}': () => homedir(),
  '{temp}': () => tmpdir(),
  '{workspace}': () => join(tmpdir(), 'jarvis', 'workspace'),
  '{windir}': () => process.env.windir ?? process.env.SystemRoot ?? 'C:\\Windows',
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {}
  const roots: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      out.help = true
    } else if (arg === '--no-token') {
      out.noToken = true
    } else if (arg === '--print-identity') {
      out.printIdentity = true
    } else if (arg === '--port') {
      out.port = Number(argv[++i])
    } else if (arg === '--host') {
      out.host = argv[++i]
    } else if (arg === '--token') {
      out.token = argv[++i]
    } else if (arg === '--root') {
      roots.push(argv[++i])
    } else if (arg === '--config') {
      out.config = argv[++i]
    } else if (arg?.startsWith('--')) {
      const eq = arg.indexOf('=')
      const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2)
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i]
      if (key === 'port') out.port = Number(value)
      else if (key === 'host') out.host = value
      else if (key === 'token') out.token = value
      else if (key === 'root') roots.push(value)
      else if (key === 'config') out.config = value
    }
  }
  if (roots.length > 0) out.roots = roots
  return out
}

async function loadConfigFile(
  path: string,
): Promise<
  Partial<CliArgs> & {
    roots?: string[]
    applications?: Record<string, { name?: string; target?: unknown; enabled?: boolean }>
    discovery?: boolean
  }
> {
  const text = await readFile(path, 'utf8')
  const parsed = JSON.parse(text) as {
    port?: number
    host?: string
    token?: string
    roots?: string[]
    applications?: Record<string, { name?: string; target?: unknown; enabled?: boolean }>
    discovery?: boolean
  }
  return {
    port: typeof parsed.port === 'number' ? parsed.port : undefined,
    host: typeof parsed.host === 'string' ? parsed.host : undefined,
    token: typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : undefined,
    roots: Array.isArray(parsed.roots) ? (parsed.roots as string[]).filter((r) => typeof r === 'string') : undefined,
    applications: parsed.applications,
    discovery: typeof parsed.discovery === 'boolean' ? parsed.discovery : undefined,
  }
}

function expandRoot(input: string): string {
  let value = input.trim()
  if (value.startsWith('~')) value = join(homedir(), value.slice(1))
  for (const [token, resolve] of Object.entries(TOKENS)) {
    if (value.includes(token)) value = value.replaceAll(token, resolve())
  }
  if (!isAbsolute(value)) {
    throw new Error(`Native agent root must be an absolute path: "${input}"`)
  }
  return value
}

/**
 * Expand an application target. Unlike a root (which must exist), a target may
 * reference the working directory of the executable, so this ALSO leaves a
 * path like `C:\Windows\notepad.exe` unchanged and only validates absoluteness.
 * Returns '' (skip) when the target is unusable.
 */
function expandAppTarget(input: string): string | '' {
  let value = input.trim()
  if (value.startsWith('~')) value = join(homedir(), value.slice(1))
  for (const [token, resolve] of Object.entries(TOKENS)) {
    if (value.includes(token)) value = value.replaceAll(token, resolve())
  }
  if (!isAbsolute(value)) return ''
  return value
}

/** Validate + expand the config allow-list. Invalid entries are dropped with a stderr warning. */
function resolveApplications(
  raw: Record<string, { name?: string; target?: unknown; enabled?: boolean }> | undefined,
): Record<string, AppRegistration> {
  const applications: Record<string, AppRegistration> = {}
  if (!raw) return applications
  for (const [rawId, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue
    const applicationId = rawId.trim()
    if (applicationId.length === 0 || applicationId.length > APP_LIMITS.MAX_APP_ID_LENGTH || !APP_ID_PATTERN.test(applicationId)) {
      process.stderr.write(`[config] Skipping application "${rawId}": the applicationId is not a valid id.\n`)
      continue
    }
    if (typeof entry.target !== 'string' || entry.target.trim().length === 0) {
      process.stderr.write(`[config] Skipping application "${applicationId}": missing "target".\n`)
      continue
    }
    const target = expandAppTarget(entry.target)
    if (target === '') {
      process.stderr.write(`[config] Skipping application "${applicationId}": target "${entry.target}" is not an absolute path.\n`)
      continue
    }
    applications[applicationId] = {
      name: typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : undefined,
      target,
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : undefined,
    }
  }
  return applications
}

function helpText(): string {
  return [
    `JARVIS Native Windows Agent v${NATIVE_AGENT_VERSION} (${NATIVE_PROTOCOL})`,
    '',
    'Usage: node native/dist/agentMain.js [options]',
    '',
    '  --port <n>          listen port (default 8765)',
    '  --host <addr>       bind host (default 127.0.0.1)',
    '  --token <secret>    require this bearer token from clients',
    '  --no-token          loopback-only dev mode without a token (not recommended)',
    '  --root <abs>        granted root (repeatable; tokens: {userprofile} {temp} {workspace}, ~)',
    '  --config <json>     JSON config alternative to flags (flag values win)',
    '  --print-identity    exit after printing the resolved identity',
    '  --help              this help',
    '',
    'Token precedence: --token > env JARVIS_NATIVE_TOKEN > config file > --no-token.',
    'If no token is configured and --no-token is not passed, startup fails (safe default).',
  ].join('\n')
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2))
  if (cli.help) {
    process.stdout.write(`${helpText()}\n`)
    process.exit(0)
  }

  const config = cli.config ? await loadConfigFile(cli.config) : {}

  const host = cli.host ?? config.host ?? NATIVE_DEFAULT_HOST
  const port = cli.port ?? config.port ?? NATIVE_DEFAULT_PORT
  const rootsRaw = cli.roots ?? config.roots ?? ['{workspace}']
  const roots = [...new Set(rootsRaw.map(expandRoot))]
  const token = cli.token ?? (process.env.JARVIS_NATIVE_TOKEN || undefined) ?? config.token ?? (cli.noToken ? '' : undefined)

  if (token === undefined) {
    // Safe default: refuse to run an open, tokenless agent on loopback.
    process.stderr.write(
      'Refusing to start: no native agent token configured.\n' +
        'Set --token <secret> (or env JARVIS_NATIVE_TOKEN), or explicitly accept\n' +
        'loopback-only dev mode with --no-token. See --help.\n',
    )
    process.exit(1)
  }

  const backend = new RealFsBackend()

  // Grant the default scratch root up front; it is the only root JARVIS creates.
  const scratch = roots.find((r) => r.toLowerCase().includes('workspace')) ?? roots[0]!
  try {
    if (!existsSync(scratch)) mkdirSync(scratch, { recursive: true })
  } catch (error) {
    process.stderr.write(`Could not create the workspace root "${scratch}": ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }

  const configuredApps = resolveApplications(config.applications)
  const applications = new RealAppBackend(
    new AppRegistry({
      configured: configuredApps,
      discover: config.discovery !== false,
    }),
  )
  const configuredCount = Object.keys(configuredApps).length

  const observation = new RealObsBackend()
  const desktop = new RealDesktopInteractionBackend()
  const agent = await startAgent({ roots, host, port, token, backend, applications, observation, desktop })

  process.stdout.write(
    [
      `JARVIS Native Windows Agent v${NATIVE_AGENT_VERSION} running`,
      `  url     ${agent.url}`,
      `  protocol ${NATIVE_PROTOCOL}`,
      `  token   ${token ? 'required (bearer)' : 'NOT required (dev loopback only)'}`,
      `  roots`,
      ...roots.map((r) => `    - ${r}`),
      `  applications (${configuredCount} configured)`,
      `  observation ${process.platform === 'win32' ? 'windows + desktop screenshot (read-only)' : 'unavailable (not Windows)'}`,
      `  desktop interaction ${process.platform === 'win32' ? 'mouse/keyboard/focus (bounded, injected)' : 'unavailable (not Windows)'}`,
      `  web access ${'bounded fetch/search/download (public http(s), SSRF-locked)'}`,
      '',
      `Point the web app at it with: VITE_NATIVE_AGENT_URL=${agent.url}`,
      token ? `and: VITE_NATIVE_AGENT_TOKEN=<secret>` : 'and: VITE_NATIVE_AGENT_TOKEN unset',
      'Press Ctrl+C to stop.',
    ].join('\n') + '\n',
  )

  let closing = false
  const shutdown = async (): Promise<void> => {
    if (closing) return
    closing = true
    await agent.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  if (cli.printIdentity) {
    process.stdout.write(`identity: { protocol: "${NATIVE_PROTOCOL}", platform: ${process.platform}, arch: ${process.arch} }\n`)
  }
}

main().catch((error) => {
  process.stderr.write(`Native agent failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})