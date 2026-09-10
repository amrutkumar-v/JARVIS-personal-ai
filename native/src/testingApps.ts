import { nativeError } from './errors.js'
import type { NativeErrorCode } from './protocol.js'
import type { NativeAppLaunchResult, NativeAppSpec, NativeAppStatusResult } from './protocol.js'
import type { ApplicationBackend } from './applications.js'
import type { AppSource } from './appRegistry.js'

/**
 * Native Windows Agent — memory application backend (Phase 1.3).
 *
 * `testsOnly: true`. Drives the protocol / web-bridge tests deterministically
 * WITHOUT spawning real processes. Each seed may define a launch outcome:
 * `verified` (the process is observed alive), `unverified` (observation was
 * unavailable), or `refute` (the process never appears). `launchRule` pairs
 * the expectation of a failing launch with a structured `NativeErrorCode`.
 */
export interface MemoryAppSeed {
  applicationId: string
  name?: string
  displayName?: string
  source?: AppSource
  enabled?: boolean
  launchable?: boolean
  /** Details shown as `false` to the engine. */
  launchRule?: 'verified' | 'unverified' | 'refute'
  /** Process-image name (basename without `.exe`) the app runs as; defaults to the applicationId. */
  processName?: string
  /** Force `launch` to throw a structured error. */
  failRule?: { code: NativeErrorCode; message?: string }
}

interface MemoryAppState {
  applicationId: string
  name: string
  displayName: string
  source: AppSource
  enabled: boolean
  launchable: boolean
  launchRule: 'verified' | 'unverified' | 'refute'
  processName: string
  failRule: { code: NativeErrorCode; message?: string } | undefined
  launchCount: number
}

function defaultSeed(applicationId: string): MemoryAppState {
  return {
    applicationId,
    name: applicationId,
    displayName: applicationId,
    source: 'configured',
    enabled: true,
    launchable: true,
    launchRule: 'verified',
    processName: applicationId,
    failRule: undefined,
    launchCount: 0,
  }
}

export class MemoryAppBackend implements ApplicationBackend {
  readonly id = 'memory-app'
  readonly testsOnly = true
  private readonly apps = new Map<string, MemoryAppState>()

  constructor(seeds: MemoryAppSeed[] = []) {
    for (const seed of seeds) this.seed(seed)
  }

  /** Replace/insert a seed (also resets its launch tracking). */
  seed(seed: MemoryAppSeed): void {
    const state: MemoryAppState = {
      ...defaultSeed(seed.applicationId),
      ...seed,
      displayName: seed.displayName ?? seed.name ?? seed.applicationId,
      launchCount: 0,
    }
    this.apps.set(state.applicationId, state)
  }

  /** Current launch count for a seed (tests assert on side effects). */
  launchCount(applicationId: string): number {
    return this.apps.get(applicationId)?.launchCount ?? 0
  }

  async list(): Promise<NativeAppSpec[]> {
    return [...this.apps.values()]
      .sort((a, b) => a.applicationId.localeCompare(b.applicationId))
      .map((a) => ({
        applicationId: a.applicationId,
        name: a.name,
        displayName: a.displayName,
        source: a.source,
        enabled: a.enabled,
        launchable: a.launchable,
      }))
  }

  async status(applicationId: string): Promise<NativeAppStatusResult> {
    const app = this.apps.get(applicationId)
    if (!app) {
      throw nativeError('not_found', `Application "${applicationId}" is not registered.`, applicationId)
    }
    const launched = app.launchCount > 0
    return {
      applicationId: app.applicationId,
      name: app.name,
      displayName: app.displayName,
      source: app.source,
      enabled: app.enabled,
      launchable: app.launchable,
      running: launched,
      runningVerified: launched && app.launchRule === 'verified',
    }
  }

  resolveProcessName(applicationId: string): string {
    const app = this.apps.get(applicationId)
    if (!app || !app.launchable) return ''
    return app.processName
  }

  async launch(applicationId: string): Promise<NativeAppLaunchResult> {
    const app = this.apps.get(applicationId)
    if (!app) {
      throw nativeError('not_found', `Application "${applicationId}" is not registered.`, applicationId)
    }
    if (!app.enabled) {
      throw nativeError('permission_denied', `Application "${applicationId}" is disabled.`, applicationId)
    }
    if (!app.launchable) {
      throw nativeError('invalid_path', `Application "${applicationId}" is not launchable.`, applicationId)
    }
    if (app.failRule) {
      throw nativeError(app.failRule.code, app.failRule.message ?? `Launch failed for "${applicationId}".`, applicationId)
    }

    app.launchCount += 1
    const pid = 1000 + app.launchCount
    const rule = app.launchRule ?? 'verified'
    const verified = rule === 'verified'
    const detail =
      rule === 'verified'
        ? `Process launched and verified running (pid ${pid}).`
        : rule === 'unverified'
          ? `Process launched (pid ${pid}), but its state could not be verified in the observation window.`
          : `Process launched (pid ${pid}), but it was not observed running in the verification window.`
    return { applicationId, started: true, pid, verified, detail }
  }
}