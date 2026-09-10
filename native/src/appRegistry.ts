import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { APP_ID_PATTERN, type NativeAppSpec } from './protocol.js'
import { APP_LIMITS } from './limits.js'
import { parseShellLinkTarget } from './windowsLnk.js'

/**
 * Native Windows Agent — application registry (Phase 1.3).
 *
 * Two sources, both bounded and deterministic:
 *
 *  - `configured` — the explicit allow-list from the agent config file. The
 *    ONLY applications the agent is ever allowed to launch. Targets are
 *    absolute paths expanded from tokens ({windir}/{userprofile}/{temp}/~) at
 *    startup; no personal or machine-specific paths are committed anywhere.
 *
 *  - `discovered` — a bounded scan of the two well-known Start Menu program
 *    folders (per-user + all-users top level plus one sublevel, capped by file
 *    count and elapsed time). Shortcuts are resolved through a pure-Node .lnk
 *    parser; discovered entries are listed so the agent can see them, but
 *    they are `launchable` only when they resolve to a plain `.exe` that is
 *    not a shell host.
 *
 * Neither source ever produces a command about arbitrary paths: callers can
 * only reference `applicationId` values that exist in this registry.
 */
export type AppSource = 'configured' | 'discovered'

export interface AppRegistration {
  /** Human label; falls back to the config key / shortcut name. */
  name?: string
  /** Absolute target executable path (expanded before construction). */
  target: string
  /** Explicit allow-flag; false makes the app visible but NEVER launchable. */
  enabled?: boolean
}

/** Internal record. `target` is agent-side only and never serialized. */
export interface AppRecord {
  applicationId: string
  name: string
  displayName: string
  source: AppSource
  enabled: boolean
  launchable: boolean
  /** Absolute path to the launchable executable ('' when not launchable). */
  target: string
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

export interface AppRegistryOptions {
  /** Explicit configuration allow-list (applicationId → registration). */
  configured?: Record<string, AppRegistration>
  /** Absolute folders scanned for `*.lnk` (defaults to Start Menu Programs). */
  discoveryDirs?: string[]
  /** Platform gate; discovery only runs on win32 unless dirs are injected. */
  platform?: NodeJS.Platform
  /** Master switch; defaults to true. */
  discover?: boolean
}

type ScannedState = {
  count: number
  seenTargets: Set<string>
}

export class AppRegistry {
  private readonly records = new Map<string, AppRecord>()
  readonly discoveryEnabled: boolean

  constructor(options: AppRegistryOptions = {}) {
    const platform = options.platform ?? (typeof process !== 'undefined' ? process.platform : 'win32')
    const dirs =
      options.discoveryDirs ??
      (platform === 'win32'
        ? [
            join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
            join(process.env.PROGRAMDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
          ].filter((d) => d.length > 0)
        : [])
    this.discoveryEnabled = options.discover !== false
    this.seedConfigured(options.configured)
    if (this.discoveryEnabled && dirs.length > 0) {
      this.seedDiscovered(dirs)
    }
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
    }
  }

  /* ---------------------------------------------------------------- config */

  private seedConfigured(configured?: Record<string, AppRegistration>): void {
    if (!configured) return
    for (const [rawId, reg] of Object.entries(configured)) {
      if (!reg || typeof reg !== 'object') continue
      const applicationId = rawId.trim()
      if (!APP_ID_PATTERN.test(applicationId)) continue
      const target = typeof reg.target === 'string' ? reg.target.trim() : ''
      if (target === '') continue
      const name = typeof reg.name === 'string' && reg.name.trim().length > 0 ? reg.name.trim() : applicationId
      this.records.set(applicationId, {
        applicationId,
        name,
        displayName: name,
        source: 'configured',
        enabled: reg.enabled !== false,
        launchable: isPlainExe(target),
        target: isPlainExe(target) ? target : '',
      })
    }
  }

  /* -------------------------------------------------------------- discovery */

  private seedDiscovered(dirs: string[]): void {
    const deadline = Date.now() + APP_LIMITS.MAX_DISCOVERY_TIME_MS
    const state: ScannedState = { count: 0, seenTargets: new Set() }

    for (const dir of dirs) {
      if (state.count >= APP_LIMITS.MAX_DISCOVERY_FILES) break
      if (this.records.size >= APP_LIMITS.MAX_DISCOVERED_APPS) break
      this.scanDir(dir, 0, deadline, state)
    }
  }

  private scanDir(dir: string, level: number, deadline: number, state: ScannedState): void {
    if (level > APP_LIMITS.MAX_DISCOVERY_DIR_DEPTH) return
    if (Date.now() > deadline) return

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
      if (this.records.size >= APP_LIMITS.MAX_DISCOVERED_APPS) return

      if (entry.isDirectory()) {
        this.scanDir(join(dir, entry.name), level + 1, deadline, state)
        continue
      }
      if (!entry.name.toLowerCase().endsWith('.lnk')) continue
      state.count += 1

      const target = this.readLnkTarget(join(dir, entry.name))
      const displayName = entry.name.replace(/\.lnk$/i, '')
      const applicationId = slugify(entry.name)

      const existing = this.records.get(applicationId)
      if (existing && existing.source === 'configured') continue
      if (existing && existing.source === 'discovered' && existing.target === target) continue
      if (target && state.seenTargets.has(target)) continue
      if (target) state.seenTargets.add(target)
      this.addDiscovered(applicationId, displayName, target)
    }
  }

  private addDiscovered(applicationId: string, displayName: string, target: string): void {
    let id = applicationId
    for (let n = 2; this.records.has(id); n += 1) {
      id = `${applicationId}-${n}`
    }
    const launchable = isPlainExe(target)
    this.records.set(id, {
      applicationId: id,
      name: displayName,
      displayName,
      source: 'discovered',
      enabled: true,
      launchable,
      target: launchable ? target : '',
    })
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