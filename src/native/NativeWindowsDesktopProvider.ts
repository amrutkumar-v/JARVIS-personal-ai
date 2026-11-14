import { fsError } from '../filesystem'
import type {
  DesktopCapabilities,
  DesktopClickResult,
  DesktopCursorResult,
  DesktopFocusResult,
  DesktopKeyResult,
  DesktopMoveResult,
  DesktopProvider,
  DesktopScrollResult,
  DesktopWindowStateResult,
} from '../desktop'
import { DESKTOP_LIMITS } from '../desktop'
import { normalizeWindowId } from '../observation'
import type { NativeAgentRpc } from './nativeRpc'
import type {
  NativeDesktopActionResult,
  NativeDesktopCapabilitiesResult,
  NativeDesktopClickResult,
  NativeDesktopFocusResult,
  NativeDesktopMoveResult,
  NativeCursorResult,
  NativeDesktopScrollResult,
  NativeDesktopWindowStateResult,
} from '../../native/src/protocol'

/**
 * Native Windows desktop-interaction bridge provider (Phase 1.5).
 *
 * Speaks the SHARED `NativeAgentRpc` (same transport + connectivity probe as
 * the filesystem / application / observation bridges). All input injection
 * happens on the native side (bounded Win32 SendInput / SetCursorPos /
 * SetForegroundWindow over FFI) — the browser never sees raw handles and never
 * blocks in a renderer thread. When the agent is unreachable the provider
 * reports `available:false` honestly.
 *
 * Coordinates are validated exactly like the native agent:
 *   - window.id is normalized to the native WINDOW_ID_PATTERN (no paths,
 *     pointers or commands ever reach the wire)
 *   - screen vs client coordinate rules live in the TOOLS; the wire methods
 *     below pass through the wrapper contract unchanged
 *
 * Typed text travels once from the tool to the agent and is never logged,
 * echoed or persisted anywhere on the web side (the result carries only the
 * injected length, derived locally from the already-validated string).
 */
export class NativeWindowsDesktopProvider implements DesktopProvider {
  readonly id = 'native-windows-desktop'
  private readonly rpc: NativeAgentRpc
  private cachedCaps: NativeDesktopCapabilitiesResult | undefined

  constructor(rpc: NativeAgentRpc) {
    this.rpc = rpc
  }

  capabilities(): DesktopCapabilities {
    const connected = this.rpc.knownStatus.connected
    const known = this.rpc.knownStatus
    const ops = {
      cursor: connected,
      move: connected,
      click: connected,
      double_click: connected,
      right_click: connected,
      scroll: connected,
      key_press: connected,
      hotkey: connected,
      type: connected,
      focus: connected,
      minimize: connected,
      maximize: connected,
      restore: connected,
    }
    return {
      available: connected,
      hasApi: connected,
      reason: connected ? undefined : (known.reason ?? 'The native Windows agent is not available.'),
      virtualScreen: this.cachedCaps?.virtualScreen,
      limits: {
        maxHotkeyKeys: this.cachedCaps?.limits.maxHotkeyKeys ?? DESKTOP_LIMITS.MAX_HOTKEY_KEYS,
        maxTypeTextLength: this.cachedCaps?.limits.maxTypeTextLength ?? DESKTOP_LIMITS.MAX_TYPE_TEXT_LENGTH,
        maxScrollDelta: this.cachedCaps?.limits.maxScrollDelta ?? DESKTOP_LIMITS.MAX_SCROLL_DELTA,
        maxDesktopActionTimeMs: this.cachedCaps?.limits.maxDesktopActionTimeMs ?? DESKTOP_LIMITS.MAX_DESKTOP_ACTION_TIME_MS,
        maxClientCoordinate: this.cachedCaps?.limits.maxClientCoordinate ?? DESKTOP_LIMITS.MAX_CLIENT_COORDINATE,
        maxScreenCoordinate: this.cachedCaps?.limits.maxScreenCoordinate ?? DESKTOP_LIMITS.MAX_SCREEN_COORDINATE,
      },
      ops,
    }
  }

  async refreshNativeStatus(): Promise<void> {
    await this.rpc.probe()
    // Pull the real virtual-desktop geometry + agent-enforced limits from the
    // live agent so capabilities() reports measured bounds, not placeholders.
    try {
      const caps = await this.rpc.call<NativeDesktopCapabilitiesResult>('desktop.capabilities', {})
      this.cachedCaps = caps
    } catch {
      this.cachedCaps = undefined
    }
  }

  async cursor(): Promise<DesktopCursorResult> {
    const value = await this.rpc.call<NativeCursorResult>('desktop.cursor', {})
    return ({ x: value.x, y: value.y, measured: value.measured } satisfies DesktopCursorResult)
  }

  async moveMouse(x: number, y: number): Promise<DesktopMoveResult> {
    const value = await this.rpc.call<NativeDesktopMoveResult>('desktop.move', { x, y })
    return ({ x: value.x, y: value.y, verified: value.verified, cancelled: value.cancelled } satisfies DesktopMoveResult)
  }

  async click(windowId: string, x: number, y: number): Promise<DesktopClickResult> {
    const id = this.requireWindowId(windowId)
    const value = await this.rpc.call<NativeDesktopClickResult>('desktop.click', { windowId: id, x, y })
    return this.mapClick(value)
  }

  async doubleClick(windowId: string, x: number, y: number): Promise<DesktopClickResult> {
    const id = this.requireWindowId(windowId)
    const value = await this.rpc.call<NativeDesktopClickResult>('desktop.doubleClick', { windowId: id, x, y })
    return this.mapClick(value)
  }

  async rightClick(windowId: string, x: number, y: number): Promise<DesktopClickResult> {
    const id = this.requireWindowId(windowId)
    const value = await this.rpc.call<NativeDesktopClickResult>('desktop.rightClick', { windowId: id, x, y })
    return this.mapClick(value)
  }

  async scroll(windowId: string, x: number, y: number, delta: number): Promise<DesktopScrollResult> {
    const id = this.requireWindowId(windowId)
    const value = await this.rpc.call<NativeDesktopScrollResult>('desktop.scroll', { windowId: id, x, y, delta })
    return ({ windowId: value.windowId, x: value.x, y: value.y, injected: value.injected, cancelled: value.cancelled, delta: value.delta } satisfies DesktopScrollResult)
  }

  async keyPress(key: string): Promise<DesktopKeyResult> {
    const value = await this.rpc.call<NativeDesktopActionResult>('desktop.keyPress', { key })
    return ({ length: 1, injected: value.injected, cancelled: value.cancelled } satisfies DesktopKeyResult)
  }

  async hotkey(keys: string[]): Promise<DesktopKeyResult> {
    const value = await this.rpc.call<NativeDesktopActionResult>('desktop.hotkey', { keys })
    return ({ length: keys.length, injected: value.injected, cancelled: value.cancelled } satisfies DesktopKeyResult)
  }

  async typeText(text: string): Promise<DesktopKeyResult> {
    const value = await this.rpc.call<NativeDesktopActionResult>('desktop.type', { text })
    // Length derived locally from the already-validated string; the text
    // itself never returns over the wire or to any caller.
    return ({ length: text.length, injected: value.injected, cancelled: value.cancelled } satisfies DesktopKeyResult)
  }

  async focusWindow(windowId: string): Promise<DesktopFocusResult> {
    const id = this.requireWindowId(windowId)
    const value = await this.rpc.call<NativeDesktopFocusResult>('window.focus', { windowId: id })
    return ({ windowId: value.windowId, focused: value.focused, detail: value.detail } satisfies DesktopFocusResult)
  }

  async minimizeWindow(windowId: string): Promise<DesktopWindowStateResult> {
    const id = this.requireWindowId(windowId)
    const value = await this.rpc.call<NativeDesktopWindowStateResult>('window.minimize', { windowId: id })
    return ({ windowId: value.windowId, action: value.action, success: value.success, detail: value.detail } satisfies DesktopWindowStateResult)
  }

  async maximizeWindow(windowId: string): Promise<DesktopWindowStateResult> {
    const id = this.requireWindowId(windowId)
    const value = await this.rpc.call<NativeDesktopWindowStateResult>('window.maximize', { windowId: id })
    return ({ windowId: value.windowId, action: value.action, success: value.success, detail: value.detail } satisfies DesktopWindowStateResult)
  }

  async restoreWindow(windowId: string): Promise<DesktopWindowStateResult> {
    const id = this.requireWindowId(windowId)
    const value = await this.rpc.call<NativeDesktopWindowStateResult>('window.restore', { windowId: id })
    return ({ windowId: value.windowId, action: value.action, success: value.success, detail: value.detail } satisfies DesktopWindowStateResult)
  }

  private requireWindowId(windowId: string): string {
    const parsed = normalizeWindowId(windowId)
    if ('error' in parsed) throw fsError('invalid_path', parsed.error, windowId)
    return parsed.id
  }

  private mapClick(value: NativeDesktopClickResult): DesktopClickResult {
    return ({ windowId: value.windowId, x: value.x, y: value.y, injected: value.injected, cancelled: value.cancelled } satisfies DesktopClickResult)
  }
}

export function isNativeDesktopProvider(provider: DesktopProvider): provider is NativeWindowsDesktopProvider {
  return provider instanceof NativeWindowsDesktopProvider
}

/**
 * Capability fallback used before any native wiring: honest, limits-only.
 * Kept for parity with the other bridge surfaces; the bootstrap returns
 * `undefined` (not this) in browser mode so no desktop tools register.
 */
export function unsupportedWebDesktopCapabilities(reason: string): DesktopCapabilities {
  const limits = {
    maxHotkeyKeys: DESKTOP_LIMITS.MAX_HOTKEY_KEYS,
    maxTypeTextLength: DESKTOP_LIMITS.MAX_TYPE_TEXT_LENGTH,
    maxScrollDelta: DESKTOP_LIMITS.MAX_SCROLL_DELTA,
    maxDesktopActionTimeMs: DESKTOP_LIMITS.MAX_DESKTOP_ACTION_TIME_MS,
    maxClientCoordinate: DESKTOP_LIMITS.MAX_CLIENT_COORDINATE,
    maxScreenCoordinate: DESKTOP_LIMITS.MAX_SCREEN_COORDINATE,
  }
  return {
    available: false,
    hasApi: false,
    reason,
    limits,
    ops: {
      cursor: false,
      move: false,
      click: false,
      double_click: false,
      right_click: false,
      scroll: false,
      key_press: false,
      hotkey: false,
      type: false,
      focus: false,
      minimize: false,
      maximize: false,
      restore: false,
    },
  }
}