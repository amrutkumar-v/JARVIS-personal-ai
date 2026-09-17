/**
 * Running-application inventory derived from a REAL window enumeration.
 *
 * "What applications are open?" is an INFORMATION request, so it must be
 * answered from what the desktop actually reports — never from a catalog of
 * installed apps (that is `app.list`, a different question) and never from a
 * hard-coded list of famous applications.
 *
 * Everything here is a pure derivation over real observations
 * (`window.list` → one entry per top-level window, with the owning process
 * name and its visibility). The rules are:
 *
 *  - only VISIBLE windows with a non-empty title are considered — a hidden or
 *    titleless window cannot be attributed to a user-facing application, and
 *    the caller is told how many were set aside;
 *  - Windows shell surfaces (Program Manager, the input/experience hosts, the
 *    lock screen) are NOT applications, so they are excluded by an explicit,
 *    documented title list and counted separately — JARVIS never claims to have
 *    filtered "background processes" it cannot see;
 *  - the application identity is the owning PROCESS (a real observation). Only
 *    when the process is a generic UWP host does the label fall back to the
 *    window title, and the entry is then flagged `labelInferred` so nothing
 *    downstream presents an inference as a process fact;
 *  - grouping and output are bounded and deterministic (most windows first,
 *    then label), so the same desktop always produces the same answer.
 */

import type { WindowSummary } from './provider'

/** Hard ceiling on applications reported for one observation. */
export const MAX_RUNNING_APPS = 12
/** Hard ceiling on window titles kept per application. */
export const MAX_TITLES_PER_APP = 3
/** Hard ceiling on one retained window title. */
export const MAX_TITLE_CHARS = 80
/** Hard ceiling on the rendered inventory (stays inside the tool-summary cap). */
export const MAX_INVENTORY_CHARS = 900

/** Windows shell surfaces that are never a user-facing application. */
const SHELL_WINDOW_TITLES: readonly RegExp[] = [
  /^program manager$/i,
  /^windows input experience$/i,
  /^microsoft text input application$/i,
  /^windows shell experience host$/i,
  /^windows default lock screen$/i,
  /^task switching$/i,
  /^start$/i,
  /^search$/i,
]

/** UWP host processes whose own name says nothing about the hosted app. */
const GENERIC_HOST_PROCESSES: ReadonlySet<string> = new Set([
  'applicationframehost',
  'wwahost',
  'runtimebroker',
])

/** One user-facing application, derived from real top-level windows. */
export interface RunningApplication {
  /** Best-effort display label (process name, or the window title for a UWP host). */
  label: string
  /** Owning process executable NAME only (never a path), when observable. */
  processName?: string
  /** True when the label came from a window TITLE because the owner process is a
   *  generic host — the application identity is then an inference, not a
   *  process observation. */
  labelInferred: boolean
  /** Number of visible windows this application owns. */
  windowCount: number
  /** Verbatim, bounded window titles (real observations). */
  titles: string[]
  /** Opaque window ids these titles came from (real enumeration). */
  windowIds: string[]
}

export interface RunningAppsReport {
  apps: RunningApplication[]
  /** Visible windows with a title that were considered. */
  considered: number
  /** Considered windows excluded because they are Windows shell surfaces. */
  excludedShell: number
  /** Top-level windows that were hidden or had no title (not attributable). */
  notAttributable: number
}

function isShellSurface(title: string): boolean {
  return SHELL_WINDOW_TITLES.some((p) => p.test(title.trim()))
}

function clipTitle(title: string): string {
  const t = title.trim()
  return t.length > MAX_TITLE_CHARS ? `${t.slice(0, MAX_TITLE_CHARS - 1)}…` : t
}

function baseName(processName: string): string {
  const trimmed = processName.trim().replace(/\.exe$/i, '')
  return trimmed.length > 0 ? trimmed : processName.trim()
}

/**
 * Derive the user-facing application inventory from a real window list.
 * Never throws; never invents an entry that was not observed.
 */
export function deriveRunningApps(windows: readonly WindowSummary[]): RunningAppsReport {
  const visible = windows.filter((w) => w.visible && typeof w.title === 'string' && w.title.trim().length > 0)
  const notAttributable = windows.length - visible.length

  const considered: WindowSummary[] = []
  let excludedShell = 0
  for (const win of visible) {
    if (isShellSurface(win.title)) {
      excludedShell += 1
      continue
    }
    considered.push(win)
  }

  const byKey = new Map<string, RunningApplication>()
  for (const win of considered) {
    const rawProcess = win.processName?.trim()
    const processName = rawProcess ? baseName(rawProcess) : undefined
    const genericHost = processName !== undefined && GENERIC_HOST_PROCESSES.has(processName.toLowerCase())
    const labelInferred = processName === undefined || genericHost
    const label = labelInferred ? clipTitle(win.title) : processName!
    const key = processName ? `p:${processName.toLowerCase()}` : `t:${label.toLowerCase()}`

    const existing = byKey.get(key)
    if (existing) {
      existing.windowCount += 1
      if (existing.titles.length < MAX_TITLES_PER_APP) existing.titles.push(clipTitle(win.title))
      if (existing.windowIds.length < MAX_TITLES_PER_APP) existing.windowIds.push(win.windowId)
      continue
    }
    byKey.set(key, {
      label,
      processName,
      labelInferred,
      windowCount: 1,
      titles: [clipTitle(win.title)],
      windowIds: [win.windowId],
    })
  }

  const apps = [...byKey.values()].sort(
    (a, b) => b.windowCount - a.windowCount || a.label.localeCompare(b.label),
  )

  return {
    apps: apps.slice(0, MAX_RUNNING_APPS),
    considered: considered.length,
    excludedShell,
    notAttributable,
  }
}

/**
 * Render the inventory as one bounded line for a tool summary (the only field
 * fed back to the model), e.g.
 * `5 applications: chrome (2 windows: "New Tab…", "Docs…"); notepad ("Untitled…")`.
 * Returns '' when nothing user-facing was observed.
 */
export function renderRunningApps(report: RunningAppsReport): string {
  if (report.apps.length === 0) return ''
  const parts: string[] = []
  for (const app of report.apps) {
    // A title that IS the label (the UWP-host case) adds no information.
    const distinct = app.titles.filter((t) => t.toLowerCase() !== app.label.toLowerCase())
    const titles = distinct.length > 0 ? ` (${distinct.map((t) => `"${t}"`).join(', ')})` : ''
    const count = app.windowCount > 1 ? ` [${app.windowCount} windows]` : ''
    const inferred = app.labelInferred ? ' (identified from its window title)' : ''
    parts.push(`${app.label}${count}${titles}${inferred}`)
    if (parts.join('; ').length >= MAX_INVENTORY_CHARS) break
  }
  const rendered = parts.join('; ')
  const clipped = rendered.length > MAX_INVENTORY_CHARS ? `${rendered.slice(0, MAX_INVENTORY_CHARS - 1)}…` : rendered
  return clipped.trim()
}
