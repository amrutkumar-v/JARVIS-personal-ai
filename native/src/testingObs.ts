import { nativeError } from './errors.js'
import { OBS_LIMITS } from './obsLimits.js'
import { encodeBgraPng } from './png.js'
import type { NativeScreenshotResult, NativeWindowStatusResult, NativeWindowSummary } from './protocol.js'
import type { ObservationBackend } from './observation.js'

/**
 * Native Windows Agent — memory observation backend (Phase 1.4).
 *
 * `testsOnly: true`. Drives the protocol / web-bridge tests deterministically
 * WITHOUT touching the Win32 API. The window list and status come from seeded
 * records; the screenshot is a tiny generated image encoded by the SAME encoder
 * the real backend uses, so the tool layer is exercised end-to-end. It can
 * never be bound by production wiring — like the other testing backends it is
 * injected only by tests.
 */

export interface MemoryWindowSeed {
  windowId: string
  title?: string
  pid?: number
  processName?: string
  visible?: boolean
  minimized?: boolean
  maximized?: boolean
  bounds?: { left: number; top: number; right: number; bottom: number }
  clientBounds?: { left: number; top: number; right: number; bottom: number }
}

interface MemoryWindowState {
  windowId: string
  title: string
  pid?: number
  processName?: string
  visible: boolean
  minimized: boolean
  maximized: boolean
  bounds?: { left: number; top: number; right: number; bottom: number }
  clientBounds?: { left: number; top: number; right: number; bottom: number }
}

function defaultWindow(windowId: string): MemoryWindowState {
  return {
    windowId,
    title: `Window ${windowId}`,
    visible: true,
    minimized: false,
    maximized: false,
  }
}

/** A tiny 2x2 image used to prove the screenshot pipeline without a screen. */
const TEST_IMAGE: Buffer = (() => {
  const bgra = Buffer.alloc(2 * 2 * 4)
  bgra[3] = 255
  bgra[7] = 255
  bgra[11] = 255
  bgra[15] = 255
  return encodeBgraPng(2, 2, bgra)
})()

export class MemoryObsBackend implements ObservationBackend {
  readonly id = 'memory-obs'
  readonly testsOnly = true
  private readonly windows = new Map<string, MemoryWindowState>()

  constructor(seeds: MemoryWindowSeed[] = []) {
    for (const seed of seeds) this.seed(seed)
  }

  /** Replace/insert a window seed. */
  seed(seed: MemoryWindowSeed): void {
    this.windows.set(seed.windowId, {
      ...defaultWindow(seed.windowId),
      ...seed,
    })
  }

  /** Remove a window seed (simulates a window that disappeared). */
  close(windowId: string): void {
    this.windows.delete(windowId)
  }

  async listWindows(): Promise<NativeWindowSummary[]> {
    const sorted = [...this.windows.values()].sort((a, b) => {
      if (a.visible !== b.visible) return a.visible ? -1 : 1
      return a.title.localeCompare(b.title)
    })
    return sorted.slice(0, OBS_LIMITS.MAX_WINDOWS).map((w) => ({
      windowId: w.windowId,
      title: w.title,
      pid: w.pid,
      processName: w.processName,
      visible: w.visible,
      minimized: w.minimized,
      maximized: w.maximized,
      bounds: w.bounds,
      clientBounds: w.clientBounds,
    }))
  }

  async getWindowStatus(windowId: string): Promise<NativeWindowStatusResult> {
    const w = this.windows.get(windowId)
    if (!w) {
      throw nativeError('not_found', `Window "${windowId}" no longer exists.`, windowId)
    }
    return {
      windowId: w.windowId,
      exists: true,
      title: w.title,
      pid: w.pid,
      processName: w.processName,
      visible: w.visible,
      minimized: w.minimized,
      maximized: w.maximized,
      bounds: w.bounds,
      clientBounds: w.clientBounds,
    }
  }

  async captureScreenshot(): Promise<NativeScreenshotResult> {
    return {
      width: 2,
      height: 2,
      format: 'png',
      bytesLength: TEST_IMAGE.length,
      bytes: TEST_IMAGE.toString('base64'),
    }
  }
}