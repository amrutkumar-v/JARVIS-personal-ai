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
 * Applications (Phase 1.3) come from the config file plus live discovery
 * (Start Menu, App Paths registry, Store/packaged AUMIDs, verified system
 * tools). Configured entries may use `mechanism: exe` (default) with a
 * `target`, `mechanism: aumid` with an `aumid`, or `mechanism: uri` with a
 * safe scheme such as `ms-settings:`; all may declare `aliases`,
 * `processImage`, and (solely for File Explorer) `allowFolder`.
 *
 *   {
 *     "applications": {
 *       "notepad":  { "name": "Notepad", "target": "{windir}\\System32\\notepad.exe" },
 *       "calc":     { "target": "{windir}\\System32\\calc.exe", "enabled": false },
 *       "visual-studio-code": { "target": "{userprofile}\\AppData\\Local\\Programs\\...",
 *                              "aliases": ["vscode", "code"] },
 *       "calculator-store": { "mechanism": "aumid",
 *                             "aumid": "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
 *       "settings": { "mechanism": "uri", "uri": "ms-settings:" }
 *     }
 *   }
 *
 * No personal or machine-specific absolute paths are committed anywhere; all
 * targets go through tokens.
 */

interface CliArgs {
  port?: number
  host?: string
  token?: string
  noToken?: boolean
  roots?: string[]
  config?: string
  allowedOrigins?: string[]
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
    } else if (arg === '--allowed-origins') {
      out.allowedOrigins = (argv[++i] ?? '').split(',').map((o) => o.trim()).filter((o) => o.length > 0)
    } else if (arg?.startsWith('--')) {
      const eq = arg.indexOf('=')
      const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2)
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i]
      if (key === 'port') out.port = Number(value)
      else if (key === 'host') out.host = value
      else if (key === 'token') out.token = value
      else if (key === 'root') roots.push(value)
      else if (key === 'config') out.config = value
      else if (key === 'allowed-origins')
        out.allowedOrigins = String(value).split(',').map((o) => o.trim()).filter((o) => o.length > 0)
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
    applications?: Record<string, ConfigAppEntry>
    discovery?: boolean
    openFolders?: string[]
    allowedOrigins?: string[]
  }
> {
  const text = await readFile(path, 'utf8')
  const parsed = JSON.parse(text) as {
    port?: number
    host?: string
    token?: string
    roots?: string[]
    applications?: Record<string, ConfigAppEntry>
    discovery?: boolean
    openFolders?: string[]
    allowedOrigins?: string[]
  }
  return {
    port: typeof parsed.port === 'number' ? parsed.port : undefined,
    host: typeof parsed.host === 'string' ? parsed.host : undefined,
    token: typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : undefined,
    roots: Array.isArray(parsed.roots) ? (parsed.roots as string[]).filter((r) => typeof r === 'string') : undefined,
    applications: parsed.applications,
    discovery: typeof parsed.discovery === 'boolean' ? parsed.discovery : undefined,
    openFolders: Array.isArray(parsed.openFolders)
      ? (parsed.openFolders as string[]).filter((f) => typeof f === 'string')
      : undefined,
    allowedOrigins: Array.isArray(parsed.allowedOrigins)
      ? (parsed.allowedOrigins as string[]).filter((o) => typeof o === 'string')
      : undefined,
  }
}

interface ConfigAppEntry {
  name?: string
  target?: unknown
  enabled?: boolean
  mechanism?: string
  aumid?: string
  uri?: string
  aliases?: string[]
  processImage?: string
  allowFolder?: boolean
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
  raw: Record<string, ConfigAppEntry> | undefined,
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

    const mechanism =
      typeof entry.mechanism === 'string' && ['exe', 'aumid', 'uri'].includes(entry.mechanism) ? entry.mechanism : undefined
    const aumid = typeof entry.aumid === 'string' ? entry.aumid.trim() : ''
    const uri = typeof entry.uri === 'string' ? entry.uri.trim() : ''
    const aliases = Array.isArray(entry.aliases)
      ? (entry.aliases as unknown[]).filter((a): a is string => typeof a === 'string' && a.length > 0)
      : undefined
    const processImage = typeof entry.processImage === 'string' && entry.processImage.trim().length > 0 ? entry.processImage.trim() : undefined
    const allowFolder = typeof entry.allowFolder === 'boolean' ? entry.allowFolder : undefined

    // A configured aumid/uri entry needs its identifier, never a target.
    if ((mechanism === 'aumid' && aumid.length > 0) || (mechanism === 'uri' && uri.length > 0)) {
      applications[applicationId] = {
        name: typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : undefined,
        mechanism,
        ...(aumid ? { aumid } : {}),
        ...(uri ? { uri } : {}),
        aliases,
        processImage,
        allowFolder,
        enabled: typeof entry.enabled === 'boolean' ? entry.enabled : undefined,
      }
      continue
    }

    // Regular executable entry: a target is required and must be absolute.
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
      ...(mechanism === 'exe' ? { mechanism } : {}),
      aliases,
      processImage,
      allowFolder,
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
    '  --no-token          explicitly opt into tokenless loopback-only local development',
    '  --root <abs>        granted root (repeatable; tokens: {userprofile} {temp} {workspace}, ~)',
    '  --config <json>     JSON config alternative to flags (flag values win)',
    '  --allowed-origins <csv>  browser origins allowed to POST (default: loopback only)',
    '  --print-identity    exit after printing the resolved identity',
    '  --help              this help',
    '',
    'Open folders (Explorer only): config key "openFolders" (array of absolute paths; tokens supported).',
    'Defaults to the current user\'s Downloads/Documents/Desktop/Pictures/Music/Videos.',
    'These are the ONLY non-root folders open_application may pass to Explorer; they never',
    'extend the file-system roots.',
    '',
    'Token precedence: --token > env JARVIS_NATIVE_TOKEN > config file > explicit --no-token.',
    'If no token is configured and --no-token is not passed, startup fails (safe default).',
    'Without a token, startup is limited to loopback binding and intended only',
    'for local development. Missing Origin is not authentication; use a bearer',
    'token for non-browser clients. Origin: null is denied unless allow-listed.',
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

  // Curated open-folders: the current user's own well-known folders are allowed
  // as EXPLORER-ONLY folder targets (never file-system roots). Override/disable
  // via `openFolders` in the config file.
  const openFolders = config.openFolders === undefined
    ? [
        '{userprofile}\\Downloads',
        '{userprofile}\\Documents',
        '{userprofile}\\Desktop',
        '{userprofile}\\Pictures',
        '{userprofile}\\Music',
        '{userprofile}\\Videos',
      ].map(expandAppTarget)
    : [...new Set(config.openFolders.map(expandAppTarget))]
  const expandedOpenFolders = openFolders.filter((f) => f.length > 0)

  const observation = new RealObsBackend()
  const desktop = new RealDesktopInteractionBackend()
  const agent = await startAgent({
    roots,
    openFolders: expandedOpenFolders,
    host,
    port,
    token,
    backend,
    applications,
    observation,
    desktop,
    allowedOrigins: cli.allowedOrigins ?? config.allowedOrigins,
    allowInsecureNoToken: token.length === 0 && cli.noToken === true,
  })

  process.stdout.write(
    [
      `JARVIS Native Windows Agent v${NATIVE_AGENT_VERSION} running`,
      `  url     ${agent.url}`,
      `  protocol ${NATIVE_PROTOCOL}`,
      `  token   ${token ? 'required (bearer)' : 'INSECURE: NOT required; loopback-only local development mode'}`,
      `  roots`,
      ...roots.map((r) => `    - ${r}`),
      `  open folders (Explorer only)`,
      ...expandedOpenFolders.slice(0, 10).map((f) => `    - ${f}`),
      `  applications (${configuredCount} configured)`,
      `  observation ${process.platform === 'win32' ? 'windows + desktop screenshot (read-only)' : 'unavailable (not Windows)'}`,
      `  desktop interaction ${process.platform === 'win32' ? 'mouse/keyboard/focus (bounded, injected)' : 'unavailable (not Windows)'}`,
      `  web access ${'bounded fetch/search/download (public http(s), SSRF-locked)'}`,
      '',
      `The browser reaches this agent through the JARVIS backend RPC broker.`,
      token ? 'Configure the matching token as server-side JARVIS_BACKEND_NATIVE_TOKEN; never put it in VITE_* or browser storage.' : 'Tokenless mode is local development only; configure a token for backend use.',
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
