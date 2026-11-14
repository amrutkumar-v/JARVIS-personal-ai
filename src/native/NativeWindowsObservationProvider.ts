import { fsError } from '../filesystem'
import type {
  ObservationCapabilities,
  ObservationProvider,
  ScreenshotResult,
  WindowSummary,
  WindowStatus,
} from '../observation'
import { normalizeWindowId } from '../observation'
import type { NativeAgentRpc } from './nativeRpc'
import type { NativeScreenshotResult, NativeWindowSummary, NativeWindowStatusResult } from '../../native/src/protocol'

/**
 * Native Windows observation bridge provider (Phase 1.4).
 *
 * Speaks the SHARED `NativeAgentRpc` (same transport + connectivity probe as
 * the filesystem + application bridges). All window enumeration, inspection
 * and screen capture happen on the native side (bounded Win32 FFI) — the
 * browser never sees raw handles, never blocks in a renderer thread and never
 * touches pixel data beyond the one transit base64 string. When the agent is
 * unreachable the provider reports `available:false` honestly.
 *
 * The window-id validation here is the SAME charset as the native agent's
 * `WINDOW_ID_PATTERN`; a local mismatch is impossible by construction, so an
 * invalid id surfaces as a structured `invalid_path` error before any wire
 * call — the stale/prefixed string never reaches the agent.
 *
 * Screenshot bytes are transient by contract: they arrive as a base64 string,
 * are handed once to the tool for verification, and are never persisted,
 * logged or uploaded anywhere.
 */
export class NativeWindowsObservationProvider implements ObservationProvider {
  readonly id = 'native-windows-obs'
  private readonly rpc: NativeAgentRpc

  constructor(rpc: NativeAgentRpc) {
    this.rpc = rpc
  }

  capabilities(): ObservationCapabilities {
    const connected = this.rpc.knownStatus.connected
    const known = this.rpc.knownStatus
    return {
      available: connected,
      reason: connected ? undefined : (known.reason ?? 'The native Windows agent is not available.'),
      hasApi: connected,
      canListWindows: connected,
      canInspectWindows: connected,
      canCaptureScreenshots: connected,
    }
  }

  async refreshNativeStatus(): Promise<void> {
    await this.rpc.probe()
  }

  async listWindows(): Promise<WindowSummary[]> {
    const { windows } = await this.rpc.call<{ windows: NativeWindowSummary[] }>('window.list', {})
    return windows.map((w) => this.mapSummary(w))
  }

  async getWindowStatus(windowId: string): Promise<WindowStatus> {
    const parsed = normalizeWindowId(windowId)
    if ('error' in parsed) throw fsError('invalid_path', parsed.error, windowId)
    const entry = await this.rpc.call<NativeWindowStatusResult>('window.status', { windowId: parsed.id })
    return { ...this.mapSummary(entry), exists: entry.exists }
  }

  async captureScreenshot(): Promise<ScreenshotResult> {
    const shot = await this.rpc.call<NativeScreenshotResult>('desktop.screenshot', {})
    return {
      width: shot.width,
      height: shot.height,
      format: shot.format,
      bytesLength: shot.bytesLength,
      bytes: shot.bytes,
    }
  }

  private mapSummary(w: NativeWindowSummary): WindowSummary {
    return {
      windowId: w.windowId,
      title: w.title,
      pid: w.pid,
      processName: w.processName,
      visible: w.visible,
      minimized: w.minimized,
      maximized: w.maximized,
      bounds: w.bounds,
      clientBounds: w.clientBounds,
      isForeground: w.isForeground,
    }
  }
}

export function isNativeObservationProvider(provider: ObservationProvider): provider is NativeWindowsObservationProvider {
  return provider instanceof NativeWindowsObservationProvider
}