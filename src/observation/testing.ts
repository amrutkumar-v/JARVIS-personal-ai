import { fsError } from '../filesystem'
import type { ObservationProvider, ScreenshotResult, WindowStatus, WindowSummary } from './provider'
import { normalizeWindowId } from './provider'

/**
 * Deterministic in-memory observation provider — TESTS ONLY.
 *
 * Never imported or constructed by production code (src/observation/index.ts
 * deliberately does not export it); production default is the native bridge
 * (or `undefined` in browser mode) and an engine test proves the production
 * path never swaps in a fake. It exists so the observation tools and the
 * engine seam can be exercised quickly and deterministically.
 *
 * Semantics mirror the native MemoryObsBackend wire behaviour:
 *   - listWindows is sorted visible-first then by title (stable)
 *   - getWindowStatus reports exists:true until obs.close() (then not_found)
 *   - captureScreenshot returns a REAL encoded PNG (bounded, transient)
 *   - available=false → every op throws unavailable
 */
export interface ObservationSeed {
  windowId: string
  title?: string
  pid?: number
  processName?: string
  visible?: boolean
  minimized?: boolean
  maximized?: boolean
  bounds?: { left: number; top: number; right: number; bottom: number }
  clientBounds?: { left: number; top: number; right: number; bottom: number }
  fail?: { op: 'list' | 'status' | 'screenshot'; code: 'io' | 'unavailable' | 'not_found' | 'invalid_path'; message?: string }
}

interface SeedState {
  title: string
  pid?: number
  processName?: string
  visible: boolean
  minimized: boolean
  maximized: boolean
  bounds?: { left: number; top: number; right: number; bottom: number }
  clientBounds?: { left: number; top: number; right: number; bottom: number }
}

/** Deterministic 2x2 RGBA test image so payload verification stays real. */
const TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGklEQVR4nAXBAQEAAACCIMf6qrEGBE0ibNoBSiIIwehTveAAAAAASUVORK5CYII='

export class FakeObservationProvider implements ObservationProvider {
  readonly id = 'fake-obs'
  /** Positive marker so tests can assert production never swaps this in. */
  readonly testsOnly = true

  private readonly store = new Map<string, SeedState>()
  private readonly failures = new Map<string, NonNullable<ObservationSeed['fail']>>()
  private available = true
  /** Observation counters so tests can prove a malformed call never ran. */
  statusCalls = 0
  /** Count of real window enumerations (proves a claim was actually observed). */
  listCalls = 0
  screenshotCalls = 0
  /** Queue of screenshots handed out in order (tests only; empty → default). */
  private readonly screenshotQueue: ScreenshotResult[] = []
  /** Deterministic hooks that mutate window state between status calls. */
  private readonly statusHooks = new Map<number, () => void>()

  constructor(seeds: ObservationSeed[] = []) {
    for (const seed of seeds) this.add(seed)
  }

  /** Queue the next captureScreenshot payloads (tests only; never matches the
   * default PNG unless it is exactly TEST_PNG_BASE64). */
  pushScreenshot(shot: { width?: number; height?: number; bytes: string; format?: 'png' }): void {
    this.screenshotQueue.push({
      width: shot.width ?? 2,
      height: shot.height ?? 2,
      format: 'png',
      bytesLength: shot.bytes.length,
      bytes: shot.bytes,
    })
  }

  /** Run `hook` immediately before the Nth getWindowStatus call (1-indexed) —
   * lets tests churn a window's geometry mid-pipeline (stale-observation). */
  onStatusBefore(callIndex: number, hook: () => void): void {
    this.statusHooks.set(callIndex, hook)
  }

  /** Mutate one window's geometry in place (tests only). */
  mutateWindow(windowId: string, patch: { bounds?: { left: number; top: number; right: number; bottom: number }; clientBounds?: { left: number; top: number; right: number; bottom: number } }): void {
    const state = this.store.get(windowId)
    if (!state) return
    if (patch.bounds) state.bounds = patch.bounds
    if (patch.clientBounds) state.clientBounds = patch.clientBounds
  }

  add(seed: ObservationSeed): void {
    this.store.set(seed.windowId, {
      title: seed.title ?? `Window ${seed.windowId}`,
      pid: seed.pid,
      processName: seed.processName,
      visible: seed.visible ?? true,
      minimized: seed.minimized ?? false,
      maximized: seed.maximized ?? false,
      bounds: seed.bounds,
      clientBounds: seed.clientBounds,
    })
    if (seed.fail) this.failures.set(seed.windowId, seed.fail)
  }

  /** Drop a window (tests the closed-window / verification-failure path). */
  close(windowId: string): void {
    this.store.delete(windowId)
  }

  setAvailable(on: boolean, reason?: string): void {
    this.available = on
    if (!on) this.failureReason = reason ?? 'Observation disabled for this test.'
  }

  private failureReason = 'Observation disabled for this test.'

  capabilities() {
    return {
      available: this.available,
      reason: this.available ? undefined : this.failureReason,
      hasApi: this.available,
      canListWindows: this.available,
      canInspectWindows: this.available,
      canCaptureScreenshots: this.available,
    }
  }

  /** Throws the configured failure for a seed, or none. */
  private throwIfConfigured(windowId: string, op: 'list' | 'status' | 'screenshot'): void {
    const fail = this.failures.get(windowId)
    if (fail && fail.op === op) {
      throw fsError(fail.code, fail.message ?? `Forced ${op} failure for ${windowId}.`, windowId)
    }
    if (!this.available) throw fsError('unavailable', this.failureReason)
  }

  async listWindows(): Promise<WindowSummary[]> {
    this.throwIfConfigured('*', 'list')
    this.listCalls += 1
    const summaries = [...this.store.entries()].map(([windowId, state]) => this.toSummary(windowId, state))
    return summaries.sort((a, b) => Number(b.visible) - Number(a.visible) || a.title.localeCompare(b.title))
  }

  async getWindowStatus(windowId: string): Promise<WindowStatus> {
    const parsed = normalizeWindowId(windowId)
    if ('error' in parsed) throw fsError('invalid_path', parsed.error, windowId)
    this.statusCalls += 1
    this.statusHooks.get(this.statusCalls)?.()
    this.throwIfConfigured(parsed.id, 'status')
    const state = this.store.get(parsed.id)
    if (!state) throw fsError('not_found', `Window ${parsed.id} does not exist.`, parsed.id)
    return { ...this.toSummary(parsed.id, state), exists: true }
  }

  async captureScreenshot(): Promise<ScreenshotResult> {
    this.screenshotCalls += 1
    this.throwIfConfigured('*', 'screenshot')
    const queued = this.screenshotQueue.shift()
    if (queued) return queued
    return { width: 2, height: 2, format: 'png', bytesLength: 83, bytes: TEST_PNG_BASE64 }
  }

  private toSummary(windowId: string, state: SeedState): WindowSummary {
    return {
      windowId,
      title: state.title,
      pid: state.pid,
      processName: state.processName,
      visible: state.visible,
      minimized: state.minimized,
      maximized: state.maximized,
      bounds: state.bounds,
      clientBounds: state.clientBounds,
    }
  }
}