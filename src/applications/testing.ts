import { fsError } from '../filesystem'
import type { AppCloseResult, AppLaunchResult, AppOp, AppSource, AppSpec, AppStatus, ApplicationCapabilities, ApplicationProvider } from './provider'

/**
 * Deterministic in-memory application provider for TESTS ONLY.
 *
 * Never imported or constructed by production code; production default is the
 * native bridge (or `undefined` in browser mode) and a dedicated engine test
 * proves the production path never swaps in a fake. It exists so application
 * tools and the engine seam can be exercised quickly and deterministically —
 * the moment a tool reports a fake launch as a REAL one, a test here fails.
 *
 * Semantics mirror the native MemoryAppBackend wire behaviour:
 *   - launchOutcome 'verified'  → status { running: true,  runningVerified: true }
 *   - launchOutcome 'unverified'→ status { running: true,  runningVerified: false }
 *   - launchOutcome 'refuted'   → status { running: false, runningVerified: true }
 *   - disabled / non-launchable → permission_denied on launch
 *   - unknown id                → not_found on status/launch
 *   - available=false           → every op throws unavailable
 */
export interface AppSeed {
  applicationId: string
  name?: string
  displayName?: string
  source?: AppSource
  enabled?: boolean
  launchable?: boolean
  launchOutcome?: 'verified' | 'unverified' | 'refuted'
  fail?: { op: AppOp; code: 'io' | 'unavailable' | 'not_found' | 'permission_denied'; message?: string }
}

interface SeedState {
  name?: string
  displayName: string
  source: AppSource
  enabled: boolean
  launchable: boolean
  launchOutcome: NonNullable<AppSeed['launchOutcome']>
}

export class FakeApplicationProvider implements ApplicationProvider {
  readonly id = 'fake-apps'
  /** Positive marker so tests can assert production never swaps this in. */
  readonly testsOnly = true

  private readonly store = new Map<string, SeedState>()
  private readonly failures = new Map<string, NonNullable<AppSeed['fail']>>()
  private readonly launches = new Map<string, number>()
  private readonly closed = new Set<string>()
  private available = true

  constructor(seeds: AppSeed[] = []) {
    for (const seed of seeds) this.add(seed)
  }

  add(seed: AppSeed): void {
    this.store.set(seed.applicationId, {
      name: seed.name,
      displayName: seed.displayName ?? seed.name ?? seed.applicationId,
      source: seed.source ?? 'configured',
      enabled: seed.enabled ?? true,
      launchable: seed.launchable ?? true,
      launchOutcome: seed.launchOutcome ?? 'verified',
    })
    if (seed.fail) this.failures.set(seed.applicationId, seed.fail)
  }

  setAvailable(on: boolean): void {
    this.available = on
  }

  /** How many times an id was successfully launched (side-effect assert). */
  launchCount(applicationId: string): number {
    return this.launches.get(applicationId) ?? 0
  }

  capabilities(): ApplicationCapabilities {
    const ops = Object.fromEntries((['list', 'status', 'launch'] as const).map((op) => [op, this.available])) as Record<AppOp, boolean>
    return {
      available: this.available,
      reason: this.available ? undefined : 'The (test) application provider is intentionally marked unavailable.',
      ops,
    }
  }

  refreshNativeStatus(): Promise<void> {
    return Promise.resolve()
  }

  async list(): Promise<AppSpec[]> {
    this.checkFail('list', undefined)
    return [...this.store.entries()]
      .map(([applicationId, seed]) => this.spec(applicationId, seed))
      .sort((a, b) => (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0))
  }

  status(applicationId: string): Promise<AppStatus> {
    return Promise.resolve(this.statusOf(applicationId))
  }

  launch(applicationId: string): Promise<AppLaunchResult> {
    this.checkFail('launch', applicationId)
    const state = this.store.get(applicationId)
    if (!state) throw fsError('not_found', `No approved application with id "${applicationId}".`, applicationId)
    if (!state.enabled) throw fsError('permission_denied', `"${applicationId}" is disabled and cannot be launched.`, applicationId)
    if (!state.launchable) throw fsError('permission_denied', `"${applicationId}" is not launchable.`, applicationId)
    this.launches.set(applicationId, (this.launches.get(applicationId) ?? 0) + 1)
    const outcome = state.launchOutcome
    if (outcome === 'verified') {
      return Promise.resolve({
        applicationId,
        started: true,
        pid: 4242,
        verified: true,
        detail: `Launch verified (pid 4242).`,
      })
    }
    if (outcome === 'unverified') {
      return Promise.resolve({
        applicationId,
        started: true,
        pid: 4242,
        verified: false,
        detail: `Launch succeeded but could not be verified in the observation window.`,
      })
    }
    return Promise.resolve({
      applicationId,
      started: true,
      pid: 4242,
      verified: false,
      detail: `Launch succeeded but the process was not observed running.`,
    })
  }

  async close(applicationId: string): Promise<AppCloseResult> {
    this.checkFail('launch', applicationId)
    const state = this.store.get(applicationId)
    if (!state) throw fsError('not_found', `No approved application with id "${applicationId}".`, applicationId)
    const wasRunning = this.launchCount(applicationId) > 0 && !this.closed.has(applicationId)
    this.closed.add(applicationId)
    return {
      applicationId,
      terminated: wasRunning,
      verified: wasRunning,
      detail: wasRunning
        ? `Closed "${applicationId}" and confirmed it is no longer running.`
        : `"${applicationId}" was not running.`,
    }
  }

  /* ------------------------------------------------ internals */

  private spec(applicationId: string, state: SeedState): AppSpec {
    return {
      applicationId,
      name: state.name,
      displayName: state.displayName,
      source: state.source,
      enabled: state.enabled,
      launchable: state.launchable,
    }
  }

  private statusOf(applicationId: string): AppStatus {
    this.checkFail('status', applicationId)
    const state = this.store.get(applicationId)
    if (!state) throw fsError('not_found', `No approved application with id "${applicationId}".`, applicationId)
    const count = this.launchCount(applicationId)
    if (count === 0) return { ...this.spec(applicationId, state), running: false, runningVerified: true }
    const outcome = state.launchOutcome
    if (outcome === 'unverified') return { ...this.spec(applicationId, state), running: true, runningVerified: false }
    if (outcome === 'refuted') return { ...this.spec(applicationId, state), running: false, runningVerified: true }
    return { ...this.spec(applicationId, state), running: true, runningVerified: true }
  }

  private checkFail(op: AppOp, applicationId: string | undefined): void {
    if (!this.available) {
      throw fsError('unavailable', 'The application provider is not available right now.')
    }
    const fail = applicationId ? this.failures.get(applicationId) : undefined
    if (fail && fail.op === op) {
      throw fsError(fail.code, fail.message ?? `Op "${op}" failed (injected fault).`, applicationId)
    }
  }
}