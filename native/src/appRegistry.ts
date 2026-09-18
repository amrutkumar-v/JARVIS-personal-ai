import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { execFile, type ChildProcess } from 'node:child_process'
import { APP_ID_PATTERN, type NativeAppRefreshResult, type NativeAppSpec } from './protocol.js'
import { APP_LIMITS } from './limits.js'
import { parseShellLinkTarget } from './windowsLnk.js'

/**
 * Native Windows Agent — application registry (Phase 1.3, demonstration-ready).
 *
 * Several sources, every one bounded and deterministic, and NONE of them ever
 * constructs a command from user text:
 *
 *  - `configured` — the explicit allow-list from the agent config file. Targets
 *    are absolute paths expanded from tokens at startup. A configured entry may
 *    also declare `mechanism: aumid` (packaged/Store app AUMID) or
 *    `mechanism: uri` (a safe scheme such as `ms-settings:`), plus `aliases`.
 *
 *  - `discovered` — a bounded scan of the two well-known Start Menu program
 *    folders (per-user + all-users, capped by file count, depth and time).
 *    Shortcuts are resolved through a pure-Node .lnk parser.
 *
 *  - `appPaths` — an App Paths registry walk (`reg query` with FIXED arguments,
 *    never user text) that surfaces real installed applications such as
 *    Chrome, Edge, VS Code, Spotify, Discord and Telegram by their registered
 *    launchable targets.
 *
 *  - `packaged` — an Appx store enumeration (`reg query`, fixed arguments) that
 *    surfaces installed Store/packaged applications by AUMID so they can be
 *    launched through the validated `shell:AppsFolder\<aumid>` mechanism.
 *
 *  - `system` — a small set of well-known Windows system tools (Notepad,
 *    Calculator, Paint, File Explorer, Task Manager, Control Panel, Settings)
 *    seeded ONLY when their real executable exists on disk (or, for the
 *    `ms-settings:` shell route, when running on win32). This is discovery of
 *    the operating system's own tools — not a fabricated list of successes.
 *
 * Resolution is by normalized/alias/fuzzy token matching: a claim like
 * `chrome`, `google chrome`, `Google Chrome`, `ms edge` or `vscode` is matched
 * against registered ids, display names and aliases. Multiple distinct matches
 * are reported as `ambiguous` so the caller can ask the user — the registry
 * never guesses.
 *
 * Discovery that depends on the registry is asynchronous (`reg query`). The
 * registry exposes `ready()` so callers observe a COMPLETE first population,
 * and `refresh()` re-runs discovery and reports honest counts.
 *
 * Neither source ever produces a command about arbitrary paths: callers can
 * reference `applicationId` values that exist in this registry, or claimed
 * names resolved to such values.
 */
export type AppSource = 'configured' | 'discovered' | 'appPaths' | 'packaged' | 'system'
export type LaunchMechanism = 'exe' | 'aumid' | 'uri'

/** AUMID charset (packaged-application id). Conservative, never a path. */
const AUMID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_!+.-]{0,254}$/

/** Launch schemes allowed for `uri` mechanisms. Explicit allow-list only.
 *
 * Security rationale: default-deny. Every entry is (1) shell-owned (ms-settings),
 * (2) a public URI-protocol owned by a publisher whose desktop client is
 * typically installed on a personal machine, or (3) the universal `open:` verb
 * (ShellExec's IsAllowedUri still rejects paths-with-spaces / quotes / shell
 * metacharacters so `open:C:\evil.bat` fails at the C# side independently of
 * this list). Dangerous schemes NEVER included here: powershell, file,
 * javascript, ms-windows-store, search-ms.
 *
 * This list is DEFENSE-IN-DEPTH and MUST be kept exactly in sync with
 * ShellExec.cs `AllowedUriSchemes` string[] (verified by the parity test).
 */
export const ALLOWED_URI_SCHEMES = new Set([
  'ms-settings',
  'mailto',
  'whatsapp',
  'spotify',
  'discord',
  'telegram',
  'slack',
  'ms-teams',
  'obs',
  'zoommtg',
  'zoomus',
  'steam',
  'open',
]) as ReadonlySet<string>

function isValidAumid(value: string): boolean {
  return AUMID_PATTERN.test(value)
}

function isValidUri(value: string): boolean {
  const colon = value.indexOf(':')
  if (colon <= 0) return false
  const scheme = value.slice(0, colon).toLowerCase()
  if (!ALLOWED_URI_SCHEMES.has(scheme)) return false
  const rest = value.slice(colon + 1)
  return rest.length <= 240 && !/\s/.test(value) && !/["'`]/.test(value)
}

export interface AppRegistration {
  /** Human label; falls back to the config key / shortcut name. */
  name?: string
  /** Absolute target executable path (expanded before construction). */
  target?: string
  /** Explicit allow-flag; false makes the app visible but NEVER launchable. */
  enabled?: boolean
  /** Force the launch mechanism; inferred when absent. */
  mechanism?: LaunchMechanism
  /** Packaged-application (Store/MSIX) identifier, validated by AUMID_PATTERN. */
  aumid?: string
  /** Safe URI route (e.g. `ms-settings:`), validated by the scheme allow-list. */
  uri?: string
  /** Extra names this application can be resolved by. */
  aliases?: string[]
  /** Actual process-image name used to observe the running state. */
  processImage?: string
  /** True when the app may be launched with a validated folder argument (@ File Explorer). */
  allowFolder?: boolean
}

/** Internal record. `target` is agent-side only and never serialized. */
export interface AppRecord {
  applicationId: string
  name: string
  displayName: string
  source: AppSource
  enabled: boolean
  launchable: boolean
  mechanism: LaunchMechanism
  /** Absolute path to the launchable executable ('' for aumid/uri). */
  target: string
  /** Validated packaged-application id (mechanism `aumid`). */
  aumid?: string
  /** Validated safe URI route (mechanism `uri`). */
  uri?: string
  /** Extra resolution names (never targets). */
  aliases: string[]
  /** Process-image name (basename without `.exe`) for observation, when known. */
  processImage?: string
  /** True only for File Explorer: may receive a validated folder argument. */
  allowFolder: boolean
}

/** Executables the agent refuses to launch: they ARE the shell/script hosts. */
export const SHELL_HOST_BASENAMES = new Set([
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
])

function isPlainExe(target: string): boolean {
  const lower = target.toLowerCase()
  return lower.endsWith('.exe') && !SHELL_HOST_BASENAMES.has(basename(target).toLowerCase())
}

/** Deterministic dashboard-style id from a shortcut file name. */
export function slugify(name: string): string {
  const slug = name
    .replace(/\.lnk$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
  return slug || 'app'
}

/**
 * Derive natural-name aliases from a Store/packaged display name so a claim
 * like `whatsapp` resolves to the record whose slug is `whatsappdesktop`.
 * Splits camelCase + punctuation into word tokens; never fabricates a target
 * and never invents names — it only re-tokens the REAL registry display name.
 *
 * Additionally, for the package-family slug it strips the common Store-app
 * suffix tokens "desktop" and "app" (e.g. "WhatsAppDesktop" slugified to
 * "whatsappdesktop" → also registers "whatsapp"). These suffixes are a
 * convention of the Microsoft Store submission pattern, not invention: the
 * publisher explicitly chose `{Brand}Desktop` as the package prefix. The
 * stripped variant is only added when the remnant is ≥ 3 characters and
 * still matches the slug charset (never introduces new tokens).
 */
export function packagedAliases(displayName: string): string[] {
  const tokenParts = (displayName ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .split(' ')
  const tokens = new Set<string>()
  for (const part of tokenParts) {
    const token = part.trim()
    if (token.length >= 3) tokens.add(token)
  }
  const slug = slugify(displayName)
  if (slug.length >= 3) tokens.add(slug)
  // Strip Microsoft Store package suffixes: {Brand}Desktop / {Brand}App /
  // {Brand}Client / {Brand}UWP → {Brand}. Each strip is bounded and only
  // adds the stripped alias if the remnant is still ≥ 3 chars.
  const STORE_SUFFIXES = ['desktop', 'app', 'client', 'uwp']
  for (const suffix of STORE_SUFFIXES) {
    if (slug.endsWith(suffix) && slug.length > suffix.length) {
      const remnant = slug.slice(0, -suffix.length).replace(/[^a-z0-9]+$/, '')
      if (remnant.length >= 3) tokens.add(remnant)
    }
  }
  return [...tokens].sort().slice(0, 8)
}

/**
 * Normalize a claimed application name to the registry's matching form:
 * lowercase, whitespace/underscores/punctuation collapsed to dashes. This is
 * the SAME normalization applied to configured slugs and display names, so a
 * claim can never smuggle a path or a shell metacharacter into resolution.
 */
export function normalizeClaim(input: string): string {
  return (input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '-')
    .split(' ')
    .filter((t) => t.length > 0)
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

/**
 * Bounded heuristic to derive a plausible process-image basename for a
 * packaged (Store/MSIX) app from its real displayName + AUMID. Returns
 * `undefined` when the target cannot be reliably derived (i.e. never guesses).
 *
 * The image name is used ONLY for post-launch tasklist.exe observation, never
 * for launch construction. Fabricating one would fake verification, so we
 * return undefined whenever the derivation is non-obvious.
 *
 * Rules:
 *   1. Take the slugified displayName.
 *   2. Strip Microsoft Store package suffixes ({Brand}Desktop / App / Client).
 *   3. If the stripped remnant has >= 3 chars and is purely [a-z0-9-],
 *      return it (dashes collapsed). Otherwise undefined.
 */
export function inferPackagedProcessImage(displayName: string, aumid: string): string | undefined {
  const slug = slugify(displayName)
  const SUFFIXES = ['desktop', 'app', 'client', 'uwp']
  let base = slug
  for (const suffix of SUFFIXES) {
    if (base.endsWith('-' + suffix)) {
      base = base.slice(0, -(suffix.length + 1))
      break
    }
    if (base.endsWith(suffix) && base.length > suffix.length + 2) {
      // Only strip when the remnant would still have at least 2 chars before it
      // (avoids stripping the single-word slug "App" → "").
      const remnant = base.slice(0, -suffix.length)
      if (remnant.length >= 3) base = remnant
    }
  }
  base = base.replace(/-+/g, '')
  if (base.length >= 3 && /^[a-z0-9]+$/.test(base)) return base
  return undefined
}

/**
 * Curated synonym table (a dictionary, never an execution layer). It only
 * influences which REGISTERED record a claim resolves to; it can never create
 * or fake a launchable application.
 */
const CURATED_ALIASES: Record<string, readonly string[]> = {
  chrome: ['google-chrome'],
  'google-chrome': ['chrome'],
  msedge: ['microsoft-edge', 'edge'],
  'microsoft-edge': ['msedge', 'edge'],
  edge: ['msedge', 'microsoft-edge'],
  vscode: ['visual-studio-code', 'code'],
  code: ['visual-studio-code', 'vscode'],
  'visual-studio-code': ['vscode', 'code'],
  calc: ['calculator'],
  calculator: ['calc'],
  explorer: ['file-explorer', 'files'],
  'file-explorer': ['explorer', 'files'],
  mspaint: ['paint'],
  paint: ['mspaint'],
  taskmgr: ['task-manager'],
  'task-manager': ['taskmgr'],
  control: ['control-panel'],
  'control-panel': ['control'],
  winword: ['word'],
  word: ['winword'],
  excel: ['ms-excel'],
  'ms-excel': ['excel'],
  powerpoint: ['ms-powerpoint'],
  'ms-powerpoint': ['powerpoint'],
  outlook: ['ms-outlook'],
  'ms-outlook': ['outlook'],
  onenote: ['ms-onenote'],
  'ms-onenote': ['onenote'],
  terminal: ['windows-terminal'],
  'windows-terminal': ['terminal'],
  obs: ['obs-studio'],
  'obs-studio': ['obs'],
}

/**
 * Well-known Windows system tools. Each entry is seeded ONLY when the real
 * target exists on disk (win32), or — for the `ms-settings:` shell route —
 * when running on win32 at all. cmd/powershell remain excluded (shell hosts).
 */
export interface SystemAppSeed {
  id: string
  displayName: string
  exe?: string
  uri?: string
  aliases?: string[]
  processImage?: string
  allowFolder?: boolean
}

const SYSTEM_APP_SEEDS: readonly SystemAppSeed[] = [
  { id: 'notepad', displayName: 'Notepad', exe: '{windir}\\System32\\notepad.exe', aliases: [], processImage: 'notepad' },
  { id: 'calculator', displayName: 'Calculator', exe: '{windir}\\System32\\calc.exe', aliases: ['calc'] },
  { id: 'paint', displayName: 'Paint', exe: '{windir}\\System32\\mspaint.exe', aliases: ['mspaint'], processImage: 'mspaint' },
  {
    id: 'file-explorer',
    displayName: 'File Explorer',
    exe: '{windir}\\explorer.exe',
    aliases: ['explorer', 'files'],
    processImage: 'explorer',
    allowFolder: true,
  },
  { id: 'task-manager', displayName: 'Task Manager', exe: '{windir}\\System32\\Taskmgr.exe', aliases: ['taskmgr'], processImage: 'Taskmgr' },
  { id: 'control-panel', displayName: 'Control Panel', exe: '{windir}\\System32\\control.exe', aliases: ['control'], processImage: 'control' },
  { id: 'settings', displayName: 'Settings', uri: 'ms-settings:', aliases: ['windows settings'] },
]

/** `%WINDIR%` (fallback C:\Windows); used to verify system app targets. */
function windowsDir(): string {
  return process.env.windir ?? process.env.SystemRoot ?? 'C:\\Windows'
}

export interface AppPathEntry {
  /** Registered pretty name (e.g. "chrome.exe" → "chrome"). */
  name: string
  /** Absolute launchable target from the App Paths default value. */
  path: string
}

/** One packaged (Store/MSIX) application from the Appx store enumeration. */
export interface PackagedAppEntry {
  /** Full AUMID, e.g. "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App". */
  aumid: string
  /** Short display token derived from the package name. */
  displayName: string
}

export type AppPathsReader = () => Promise<AppPathEntry[]>
export type PackagedReader = () => Promise<PackagedAppEntry[]>

export interface AppRegistryOptions {
  /** Explicit configuration allow-list (applicationId → registration). */
  configured?: Record<string, AppRegistration>
  /** Absolute folders scanned for `*.lnk` (defaults to Start Menu Programs). */
  discoveryDirs?: string[]
  /** Platform gate; discovery only runs on win32 unless dirs are injected. */
  platform?: NodeJS.Platform
  /** Master switch; defaults to true. */
  discover?: boolean
  /** When false, the well-known system-tool seeds are skipped (tests). */
  systemApps?: boolean
  /** Override the well-known system-tool seeds (tests inject real temp files). */
  systemAppSeeds?: readonly SystemAppSeed[]
  /** Inject a real App Paths reader (defaults to a fixed-args `reg query`). */
  appPathsReader?: AppPathsReader
  /** Inject a real packaged-application reader (fixed-args `reg query`). */
  packagedReader?: PackagedReader
}

export class AppRegistry {
  private readonly configured = new Map<string, AppRegistration>()
  private readonly records = new Map<string, AppRecord>()
  private readonly discoveryDirs: string[]
  private readonly platform: NodeJS.Platform
  private readonly seedSystem: boolean
  private readonly appPathsReader?: AppPathsReader
  private readonly packagedReader?: PackagedReader
  private readonly systemAppSeeds: readonly SystemAppSeed[]
  private readonly readyPromise: Promise<void>
  readonly discoveryEnabled: boolean

  constructor(options: AppRegistryOptions = {}) {
    this.platform = options.platform ?? (typeof process !== 'undefined' ? process.platform : 'win32')
    this.discoveryDirs =
      options.discoveryDirs ??
      (this.platform === 'win32'
        ? [
            join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
            join(process.env.PROGRAMDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
          ].filter((d) => d.length > 0)
        : [])
    this.discoveryEnabled = options.discover !== false
    this.seedSystem = options.systemApps !== false
    this.appPathsReader = options.appPathsReader
    this.packagedReader = options.packagedReader
    this.systemAppSeeds = options.systemAppSeeds ?? SYSTEM_APP_SEEDS

    this.seedConfigured(options.configured)
    this.readyPromise = this.discoveryEnabled ? this.runDiscovery() : Promise.resolve()
  }

  /** Resolve once the asynchronous discovery sources (App Paths/packaged) have
   * populated the registry. Callers observe a complete first population. */
  ready(): Promise<void> {
    return this.readyPromise
  }

  /** All records (configured first, then discovered), sorted by display name. */
  listRecords(): AppRecord[] {
    return [...this.records.values()].sort((a, b) => {
      const an = a.displayName.toLowerCase()
      const bn = b.displayName.toLowerCase()
      return an < bn ? -1 : an > bn ? 1 : 0
    })
  }

  getRecord(applicationId: string): AppRecord | undefined {
    return this.records.get(applicationId)
  }

  wireSpec(record: AppRecord): NativeAppSpec {
    return {
      applicationId: record.applicationId,
      name: record.name,
      displayName: record.displayName,
      source: record.source,
      enabled: record.enabled,
      launchable: record.launchable,
      launchMechanism: record.mechanism,
      ...(record.aliases.length > 0 ? { aliases: [...record.aliases] } : {}),
      ...(record.processImage ? { processImage: record.processImage } : {}),
    }
  }

  /**
   * Resolve a claimed application name/id to its record. Matching is exact id
   * first, then the curated synonym table, then a token-containment rule against
   * id/display/alias tokens. When more than one DISTINCT application matches,
   * the resolver reports `ambiguous` (with the candidates) instead of guessing.
   */
  resolve(claim: string): { record: AppRecord } | { ambiguous: AppRecord[] } | { missing: string } {
    const normalized = normalizeClaim(claim)
    if (normalized.length === 0) return { missing: 'Please name an application.' }

    const direct = this.records.get(normalized)
    if (direct) return { record: direct }

    const exact = new Map<string, AppRecord>()
    const synonyms = CURATED_ALIASES[normalized] ?? []
    for (const alias of synonyms) {
      const rec = this.records.get(alias)
      if (rec) exact.set(alias, rec)
    }

    const claimTokens = normalized.split('-').filter((t) => t.length > 0)
    const tokenMatch = (rec: AppRecord): boolean => {
      const pool = new Set<string>()
      for (const part of [rec.applicationId, rec.displayName, rec.name, ...rec.aliases]) {
        for (const token of part.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0)) {
          pool.add(token)
        }
      }
      return claimTokens.every((t) => pool.has(t))
    }

    const scored = new Map<string, number>()
    for (const [id, rec] of exact) scored.set(id, 2)
    for (const rec of this.records.values()) {
      if (scored.has(rec.applicationId)) continue
      if (tokenMatch(rec)) scored.set(rec.applicationId, 1)
    }

    if (scored.size === 0) return { missing: normalized }
    const best = Math.max(...scored.values())
    const winners = [...scored.entries()]
      .filter(([, s]) => s === best)
      .map(([id]) => this.records.get(id)!)
      .filter((r) => r !== undefined)
    if (winners.length === 1) return { record: winners[0] }
    if (winners.length > 1) return { ambiguous: winners }
    return { missing: normalized }
  }

  /**
   * Re-run discovery from the live sources and drop discovered entries that
   * vanished. Configured entries are never touched.
   */
  async refresh(): Promise<NativeAppRefreshResult> {
    const refreshedAt = Date.now()
    await this.runDiscovery()
    const all = this.listRecords()
    const discovered = all.filter((r) => r.source !== 'configured').length
    const configured = all.filter((r) => r.source === 'configured').length
    return { total: all.length, discovered, configured, refreshedAt }
  }

  /* ---------------------------------------------------------------- config */

  private seedConfigured(configured?: Record<string, AppRegistration>): void {
    if (!configured) return
    for (const [rawId, reg] of Object.entries(configured)) {
      if (!reg || typeof reg !== 'object') continue
      const applicationId = rawId.trim()
      if (!APP_ID_PATTERN.test(applicationId)) continue
      this.configured.set(applicationId, { ...reg })
    }
    for (const [applicationId, reg] of this.configured) {
      const built = buildRecord(applicationId, reg, 'configured')
      if (built) this.records.set(applicationId, built)
    }
  }

  /* -------------------------------------------------------------- discovery */

  private async runDiscovery(): Promise<void> {
    for (const [id, rec] of this.records) {
      if (rec.source === 'configured') continue
      this.records.delete(id)
    }

    const deadline = Date.now() + APP_LIMITS.MAX_DISCOVERY_TIME_MS
    const seenTargets = new Set<string>()

    this.discoverSystem(deadline)
    this.scanStartMenu(deadline, seenTargets)
    await this.discoverAppPaths(deadline, seenTargets)
    await this.discoverPackaged(deadline)
  }

  private discoversActive(): boolean {
    return this.records.size < APP_LIMITS.MAX_DISCOVERED_APPS
  }

  private discoverSystem(deadline: number): void {
    if (this.platform !== 'win32' || !this.seedSystem) return
    const windir = windowsDir()
    for (const seed of this.systemAppSeeds) {
      if (!this.discoversActive()) return
      if (Date.now() > deadline) return
      if (this.records.has(seed.id)) continue
      if (seed.uri !== undefined) {
        if (!isValidUri(seed.uri)) continue
        this.addRecord(seed.id, {
          source: 'system',
          name: seed.displayName,
          displayName: seed.displayName,
          enabled: true,
          launchable: true,
          mechanism: 'uri',
          uri: seed.uri,
          target: '',
          aliases: seed.aliases ?? [],
        })
        continue
      }
      if (!seed.exe) continue
      const target = seed.exe.replaceAll('{windir}', windir)
      if (!isPlainExe(target) || !existsSync(target)) continue
      this.addRecord(seed.id, {
        source: 'system',
        name: seed.displayName,
        displayName: seed.displayName,
        enabled: true,
        launchable: true,
        mechanism: 'exe',
        target,
        aliases: seed.aliases ?? [],
        processImage: seed.processImage,
        allowFolder: seed.allowFolder === true,
      })
    }
  }

  private scanStartMenu(deadline: number, seenTargets: Set<string>): void {
    if (this.discoveryDirs.length === 0) return
    const state: ScannedState = { count: 0 }
    for (const dir of this.discoveryDirs) {
      if (!this.discoversActive()) break
      if (Date.now() > deadline) break
      this.scanDir(dir, 0, deadline, state, seenTargets)
    }
  }

  private scanDir(dir: string, level: number, deadline: number, state: ScannedState, seenTargets: Set<string>): void {
    if (level > APP_LIMITS.MAX_DISCOVERY_DIR_DEPTH) return
    if (Date.now() > deadline) return
    if (!this.discoversActive()) return

    let entries: { name: string; isDirectory(): boolean }[] | null
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: () => d.isDirectory() }))
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const entry of entries) {
      if (Date.now() > deadline) return
      if (state.count >= APP_LIMITS.MAX_DISCOVERY_FILES) return
      if (!this.discoversActive()) return

      if (entry.isDirectory()) {
        this.scanDir(join(dir, entry.name), level + 1, deadline, state, seenTargets)
        continue
      }
      if (!entry.name.toLowerCase().endsWith('.lnk')) continue
      state.count += 1

      const target = this.readLnkTarget(join(dir, entry.name))
      if (!isPlainExe(target)) continue
      const displayName = entry.name.replace(/\.lnk$/i, '')
      const applicationId = slugify(entry.name)

      if (this.records.has(applicationId)) continue
      if (seenTargets.has(target)) continue
      seenTargets.add(target)
      this.addRecord(applicationId, {
        source: 'discovered',
        name: displayName,
        displayName,
        enabled: true,
        launchable: true,
        mechanism: 'exe',
        target,
      })
    }
  }

  private async discoverAppPaths(deadline: number, seenTargets: Set<string>): Promise<void> {
    const reader =
      this.appPathsReader ??
      (this.platform === 'win32' ? readAppPathsRegistry : (async () => [] as AppPathEntry[]))
    let entries: AppPathEntry[]
    try {
      entries = await reader()
    } catch {
      return
    }
    if (Date.now() > deadline) return
    for (const entry of entries) {
      if (Date.now() > deadline) return
      if (!this.discoversActive()) return
      const target = entry.path.trim()
      if (!isPlainExe(target)) continue
      if (seenTargets.has(target)) continue
      seenTargets.add(target)
      const displayName = entry.name.replace(/\.exe$/i, '')
      const applicationId = uniqueId(this.records, slugify(displayName))
      this.addRecord(applicationId, {
        source: 'appPaths',
        name: displayName,
        displayName,
        enabled: true,
        launchable: true,
        mechanism: 'exe',
        target,
      })
    }
  }

  private async discoverPackaged(deadline: number): Promise<void> {
    const reader =
      this.packagedReader ??
      (this.platform === 'win32' ? readPackagedAppsRegistry : (async () => [] as PackagedAppEntry[]))
    let entries: PackagedAppEntry[]
    try {
      entries = await reader()
    } catch {
      return
    }
    if (Date.now() > deadline) return
    for (const entry of entries) {
      if (Date.now() > deadline) return
      if (!this.discoversActive()) return
      const aumid = entry.aumid.trim()
      if (!isValidAumid(aumid)) continue
      const base = slugify(entry.displayName)
      const applicationId = uniqueId(this.records, base)
      if (applicationId !== base) continue // packaged duplicates only honored once
      this.addRecord(applicationId, {
        source: 'packaged',
        name: entry.displayName,
        displayName: entry.displayName,
        enabled: true,
        launchable: true,
        mechanism: 'aumid',
        aumid,
        target: '',
        aliases: packagedAliases(entry.displayName),
        processImage: inferPackagedProcessImage(entry.displayName, aumid),
      })
    }
  }

  private addRecord(applicationId: string, partial: Omit<AppRecord, 'applicationId' | 'aliases' | 'allowFolder'> & { aliases?: string[]; allowFolder?: boolean }): void {
    const record: AppRecord = {
      applicationId,
      allowFolder: false,
      ...partial,
      aliases: (partial.aliases ?? []).filter((a) => a.length > 0),
    }
    this.records.set(applicationId, record)
  }

  private readLnkTarget(fullPath: string): string {
    let data: Buffer
    try {
      data = readFileSync(fullPath)
    } catch {
      return ''
    }
    if (data.byteLength > APP_LIMITS.MAX_LNK_BYTES) return ''
    return parseShellLinkTarget(data) ?? ''
  }
}

/* ------------------------------------------------------------- record build */

function buildRecord(applicationId: string, reg: AppRegistration, source: AppSource): AppRecord | undefined {
  const base: AppRecord = {
    applicationId,
    name: (reg.name ?? applicationId).trim(),
    displayName: (reg.name ?? applicationId).trim(),
    source,
    enabled: reg.enabled !== false,
    launchable: true,
    mechanism: 'exe',
    target: '',
    aliases: (reg.aliases ?? []).filter((a) => a.length > 0),
    allowFolder: reg.allowFolder === true,
    ...(reg.processImage ? { processImage: reg.processImage } : {}),
  }

  if (reg.mechanism === 'aumid' || (reg.mechanism === undefined && reg.aumid && !reg.target)) {
    if (reg.aumid && isValidAumid(reg.aumid)) {
      return { ...base, launchable: true, mechanism: 'aumid', aumid: reg.aumid }
    }
    return undefined
  }

  if (reg.mechanism === 'uri' || (reg.mechanism === undefined && reg.uri && !reg.target)) {
    if (reg.uri && isValidUri(reg.uri)) {
      return { ...base, launchable: true, mechanism: 'uri', uri: reg.uri }
    }
    return undefined
  }

  const target = typeof reg.target === 'string' ? reg.target.trim() : ''
  if (target === '') return undefined
  if (!isPlainExe(target)) return { ...base, launchable: false, target: '' }
  return { ...base, launchable: true, mechanism: 'exe', target }
}

function uniqueId(records: ReadonlyMap<string, AppRecord>, base: string): string {
  let id = base
  for (let n = 2; records.has(id); n += 1) id = `${base}-${n}`
  return id
}

/* ---------------------------------------------------- real registry readers */

function isAbsoluteWin(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * Read the App Paths registry (HKLM + HKCU) using `reg query` with FIXED
 * arguments. Like `tasklist`, this is a fixed system utility invocation — no
 * user/model text ever becomes part of the command line.
 */
async function readAppPathsRegistry(): Promise<AppPathEntry[]> {
  const out = await runRegQuery(
    ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', '/s'],
    APP_LIMITS.REG_QUERY_TIMEOUT_MS,
  )
  if (out === null) return []
  const entries: AppPathEntry[] = []
  let currentKey = ''
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('HKEY_')) {
      currentKey = trimmed
      continue
    }
    const keyMatch = currentKey.match(/\\App Paths\\([^\\]+\.exe)$/i)
    if (!keyMatch) continue
    const name = keyMatch[1]
    if (!/^[\w.-]+\.exe$/i.test(name)) continue
    const defaultMatch = trimmed.match(/^\(Default\)\s+REG_SZ\s+(.+)$/)
    if (!defaultMatch) continue
    const path = defaultMatch[1].trim().replace(/^"|"$/g, '')
    if (isPlainExe(path) && isAbsoluteWin(path)) {
      entries.push({ name, path })
    }
  }
  return entries
}

/**
 * Read installed packaged (Store/MSIX) applications from the Appx store
 * enumeration using `reg query` with FIXED arguments, returning conservative
 * AUMIDs. Capped by APP_LIMITS.
 */
async function readPackagedAppsRegistry(): Promise<PackagedAppEntry[]> {
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Appx\\AppxAllUserStore\\Applications',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Appx\\AppxAllUserStore\\Applications',
  ]
  const entries: PackagedAppEntry[] = []
  for (const root of roots) {
    if (entries.length >= APP_LIMITS.MAX_PACKAGED_ENTRIES) break
    const out = await runRegQuery(['query', root, '/s'], APP_LIMITS.REG_QUERY_TIMEOUT_MS)
    if (out === null) continue
    let currentKey = ''
    for (const line of out.split(/\r?\n/)) {
      if (entries.length >= APP_LIMITS.MAX_PACKAGED_ENTRIES) break
      const trimmed = line.trim()
      if (trimmed.startsWith('HKEY_')) {
        currentKey = trimmed
        continue
      }
      if (!currentKey.includes('\\Applications\\')) continue
      const pkg = currentKey.split('\\Applications\\')[1]?.split('\\')[0] ?? ''
      if (!/^[A-Za-z0-9._-]+$/.test(pkg)) continue
      const aumidMatch = trimmed.match(/^\(Default\)\s+REG_SZ\s+(.+)$/)
      const aumid = aumidMatch ? aumidMatch[1].trim().replace(/^"|"$/g, '') : ''
      const resolved = aumid.length > 0 ? aumid : `${pkg}!App`
      if (!isValidAumid(resolved)) continue
      const displayName = pkg.split('_')[0] ?? pkg
      entries.push({ aumid: resolved, displayName })
    }
  }
  return entries
}

/** Run `reg` with fixed args and a bounded timeout; `null` when unavailable. */
function runRegQuery(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    let child: ChildProcess
    try {
      child = execFile(
        'reg',
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

type ScannedState = { count: number }