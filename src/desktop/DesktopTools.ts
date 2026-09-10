import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolInput,
  ToolPermission,
  ToolResult,
  ToolVerification,
} from '../tools/Tool'
import type { ToolInputSchema } from '../engine/provider'
import { FileSystemError } from '../filesystem'
import { normalizeWindowId } from '../observation'
import type {
  DesktopClickResult,
  DesktopFocusResult,
  DesktopKeyResult,
  DesktopMoveResult,
} from './provider'
import {
  parseClientCoord,
  parseDesktopKey,
  parseHotkeyKeys,
  parseScreenCoord,
  parseScrollDelta,
  parseTypeText,
} from './provider'
import type { DesktopProvider } from './provider'

/**
 * Desktop-interaction tools (Phase 1.5) — HANDS.
 *
 * Ten narrow input tools backed by the DesktopProvider seam:
 *
 *   desktop.cursor     read_only   measured cursor position (never estimated)
 *   desktop.move       low_risk    absolute SCREEN coordinates (verifiable)
 *   desktop.click      low_risk    client-relative left click in a window
 *   desktop.double_click low_risk  client-relative double click in a window
 *   desktop.right_click  low_risk  client-relative context click in a window
 *   desktop.scroll     low_risk    bounded wheel scroll in a window
 *   desktop.key_press  low_risk    one allow-listed key
 *   desktop.hotkey     low_risk    allow-listed key combination (<= 4 keys)
 *   desktop.type       low_risk    bounded UNICODE text (never echoed back)
 *   window.focus       low_risk    bring a window to the foreground (verifiable)
 *
 * The provider is OPTIONAL by design: when undefined (browser mode) no desktop
 * tools exist at all — the engine never fabricates a fake "desktop". Every
 * injected input is reported HONESTLY: what was injected and what could be
 * verified, never a claim about the semantic effect of the input. Typed text
 * never appears in any message or result payload (only a count).
 */
const CLICK_TIP = ' Input was injected, but its effect was not confirmed — inspect the window to verify.'

function desktopFailure(error: unknown): ToolResult {
  if (error instanceof FileSystemError) {
    return { ok: false, message: error.message, data: { kind: error.kind, windowId: error.path } }
  }
  const message = error instanceof Error ? error.message : 'Unknown desktop interaction failure.'
  return { ok: false, message }
}

/** Short-circuit when the desktop capability is not actually available. */
function availabilityBlocker(provider: DesktopProvider): ToolResult | null {
  const caps = provider.capabilities()
  if (caps.available) return null
  return {
    ok: false,
    message: `Desktop interaction is not available right now: ${caps.reason ?? 'the provider is inactive.'}`,
    data: { available: false, reason: caps.reason },
  }
}

function paramStr(input: ToolInput, key: string): string | undefined {
  const value = input.params?.[key]
  return typeof value === 'string' ? value : undefined
}

function paramNum(input: ToolInput, key: string): unknown {
  return input.params?.[key]
}

function windowParam(input: ToolInput): { id: string } | { error: string } {
  const raw = paramStr(input, 'window_id')
  if (!raw) return { error: 'This action needs a window. Provide window_id.' }
  return normalizeWindowId(raw)
}

function coordParams(input: ToolInput): { x: number; y: number } | { error: string } {
  const x = parseClientCoord(paramNum(input, 'x'), 'x')
  if ('error' in x) return x
  const y = parseClientCoord(paramNum(input, 'y'), 'y')
  if ('error' in y) return y
  return { x: x.value, y: y.value }
}

function injectedFailure(cancelledResult: { injected: boolean; cancelled: boolean }): ToolResult | null {
  if (!cancelledResult.cancelled) return null
  return { ok: false, message: 'The action was cancelled before it was injected.', data: cancelledResult }
}

abstract class DesktopTool implements Tool {
  readonly category: ToolCategory = 'system'
  readonly verifiable: boolean = false
  readonly requiresPermission: boolean = false
  protected readonly provider: DesktopProvider

  constructor(provider: DesktopProvider) {
    this.provider = provider
  }

  abstract readonly id: string
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly permission: ToolPermission
  abstract readonly inputSchema: ToolInputSchema

  abstract canRun(query: string): boolean
  abstract execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult>
}

/* ----------------------------------------------------------------- cursor */

export class DesktopCursorTool extends DesktopTool {
  readonly id = 'desktop.cursor'
  readonly name = 'Cursor position'
  readonly description =
    'Reports the current cursor position in absolute virtual-desktop screen coordinates (the primary screen origin is ' +
    'usually (0,0); a multi-monitor desktop may include negative origins). The position is measured by the OS — never estimated.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = { type: 'object', properties: {}, required: [] }

  canRun(query: string): boolean {
    return /\b(where|cursor|mouse|pointer)\b/i.test(query) && /\b(cursor|mouse|pointer|position)\b/i.test(query)
  }

  async execute(): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    try {
      const cursor = await this.provider.cursor()
      return { ok: true, message: `The cursor is at screen (${cursor.x}, ${cursor.y}).`, data: cursor }
    } catch (error) {
      return desktopFailure(error)
    }
  }
}

/* ------------------------------------------------------------------- move */

export class DesktopMoveTool extends DesktopTool {
  readonly id = 'desktop.move'
  readonly name = 'Move the cursor'
  readonly description =
    'Moves the cursor to an ABSOLUTE virtual-desktop screen coordinate (x, y). The position is then re-read by the OS; ' +
    'the tool only reports a confirmed move as verified. Use desktop.cursor first to learn the current coordinates.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      x: { type: 'number', description: 'Absolute screen x (pixels).' },
      y: { type: 'number', description: 'Absolute screen y (pixels).' },
    },
    required: ['x', 'y'],
  }

  canRun(query: string): boolean {
    return /\b(move|put|place|position|cursor|mouse|pointer)\b/i.test(query) &&
      /\b(cursor|mouse|pointer|there|here)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const x = parseScreenCoord(paramNum(input, 'x'), 'x')
    if ('error' in x) return { ok: false, message: x.error, data: { kind: 'invalid_input' } }
    const y = parseScreenCoord(paramNum(input, 'y'), 'y')
    if ('error' in y) return { ok: false, message: y.error, data: { kind: 'invalid_input' } }
    try {
      const result: DesktopMoveResult = await this.provider.moveMouse(x.value, y.value)
      if (result.cancelled) {
        return { ok: false, message: 'The move was cancelled before it was executed.', data: result }
      }
      const confirmed = result.verified ? ' The final position was confirmed by the OS.' : ''
      return { ok: true, message: `Moved the cursor to screen (${result.x}, ${result.y}).${confirmed}`, data: result }
    } catch (error) {
      return desktopFailure(error)
    }
  }

  verify(input: ToolInput, _result: ToolResult): Promise<ToolVerification> {
    const x = parseScreenCoord(paramNum(input, 'x'), 'x')
    const y = parseScreenCoord(paramNum(input, 'y'), 'y')
    if ('error' in x || 'error' in y) {
      return Promise.resolve({ ok: false, message: 'No valid target coordinates to verify.' })
    }
    return this.provider
      .cursor()
      .then((cursor) =>
        cursor.x === x.value && cursor.y === y.value
          ? { ok: true, message: `Confirmed the cursor is at screen (${cursor.x}, ${cursor.y}).`, checks: ['cursor position'] }
          : {
              ok: false,
              message: `Verification failed: the cursor is at (${cursor.x}, ${cursor.y}), not (${x.value}, ${y.value}).`,
            },
      )
      .catch((error) => ({
        ok: false,
        message: `Verification failed: ${error instanceof Error ? error.message : 'unknown reason.'}`,
      }))
  }
}

/* --------------------------------------------------------- click/double/right */

export class DesktopClickTool extends DesktopTool {
  readonly id = 'desktop.click'
  readonly name = 'Left click'
  readonly description =
    'Injects a single left click at client-relative (x, y) inside the given window (visible + not minimized, from ' +
    'window.list). The click is injected exactly once; its effect is not confirmed.'
  readonly permission: ToolPermission = 'low_risk'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      window_id: { type: 'string', description: 'Window id from window.list.' },
      x: { type: 'number', description: 'Client-relative x (pixels).' },
      y: { type: 'number', description: 'Client-relative y (pixels).' },
    },
    required: ['window_id', 'x', 'y'],
  }

  canRun(query: string): boolean {
    return /\b(click|press|tap)\b/i.test(query) && /\b(window|on|button|field|app)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const win = windowParam(input)
    if ('error' in win) return { ok: false, message: win.error, data: { kind: 'invalid_input' } }
    const coords = coordParams(input)
    if ('error' in coords) return { ok: false, message: coords.error, data: { kind: 'invalid_input' } }
    try {
      const result: DesktopClickResult = await this.provider.click(win.id, coords.x, coords.y)
      const cancelled = injectedFailure(result)
      if (cancelled) return cancelled
      return {
        ok: true,
        message: `Injected a single left click at client (${coords.x}, ${coords.y}) in window ${win.id}.${CLICK_TIP}`,
        data: result,
      }
    } catch (error) {
      return desktopFailure(error)
    }
  }
}

export class DesktopDoubleClickTool extends DesktopTool {
  readonly id = 'desktop.double_click'
  readonly name = 'Double left click'
  readonly description =
    'Injects a double left click at client-relative (x, y) inside the given window (visible + not minimized, from ' +
    'window.list). The sequence is injected exactly once; its effect is not confirmed.'
  readonly permission: ToolPermission = 'low_risk'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      window_id: { type: 'string', description: 'Window id from window.list.' },
      x: { type: 'number', description: 'Client-relative x (pixels).' },
      y: { type: 'number', description: 'Client-relative y (pixels).' },
    },
    required: ['window_id', 'x', 'y'],
  }

  canRun(query: string): boolean {
    return /\b(double.?click|open|launch)\b/i.test(query) && /\b(window|on|icon|file|app)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const win = windowParam(input)
    if ('error' in win) return { ok: false, message: win.error, data: { kind: 'invalid_input' } }
    const coords = coordParams(input)
    if ('error' in coords) return { ok: false, message: coords.error, data: { kind: 'invalid_input' } }
    try {
      const result: DesktopClickResult = await this.provider.doubleClick(win.id, coords.x, coords.y)
      const cancelled = injectedFailure(result)
      if (cancelled) return cancelled
      return {
        ok: true,
        message: `Injected a double left click at client (${coords.x}, ${coords.y}) in window ${win.id}.${CLICK_TIP}`,
        data: result,
      }
    } catch (error) {
      return desktopFailure(error)
    }
  }
}

export class DesktopRightClickTool extends DesktopTool {
  readonly id = 'desktop.right_click'
  readonly name = 'Right click'
  readonly description =
    'Injects a right (context) click at client-relative (x, y) inside the given window (visible + not minimized, ' +
    'from window.list). The click is injected exactly once; its effect is not confirmed.'
  readonly permission: ToolPermission = 'low_risk'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      window_id: { type: 'string', description: 'Window id from window.list.' },
      x: { type: 'number', description: 'Client-relative x (pixels).' },
      y: { type: 'number', description: 'Client-relative y (pixels).' },
    },
    required: ['window_id', 'x', 'y'],
  }

  canRun(query: string): boolean {
    return /\b(right.?click|context|menu)\b/i.test(query) && /\b(window|on|there|here|button)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const win = windowParam(input)
    if ('error' in win) return { ok: false, message: win.error, data: { kind: 'invalid_input' } }
    const coords = coordParams(input)
    if ('error' in coords) return { ok: false, message: coords.error, data: { kind: 'invalid_input' } }
    try {
      const result: DesktopClickResult = await this.provider.rightClick(win.id, coords.x, coords.y)
      const cancelled = injectedFailure(result)
      if (cancelled) return cancelled
      return {
        ok: true,
        message: `Injected a right click at client (${coords.x}, ${coords.y}) in window ${win.id}.${CLICK_TIP}`,
        data: result,
      }
    } catch (error) {
      return desktopFailure(error)
    }
  }
}

/* ----------------------------------------------------------------- scroll */

export class DesktopScrollTool extends DesktopTool {
  readonly id = 'desktop.scroll'
  readonly name = 'Scroll a window'
  readonly description =
    'Injects a bounded scroll of `delta` wheel units (positive = up, negative = down) at client-relative (x, y) ' +
    'inside the given window. The scroll is injected exactly once; its effect is not confirmed.'
  readonly permission: ToolPermission = 'low_risk'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      window_id: { type: 'string', description: 'Window id from window.list.' },
      x: { type: 'number', description: 'Client-relative x (pixels).' },
      y: { type: 'number', description: 'Client-relative y (pixels).' },
      delta: { type: 'number', description: 'Signed wheel units (positive scrolls up).' },
    },
    required: ['window_id', 'x', 'y', 'delta'],
  }

  canRun(query: string): boolean {
    return /\b(scroll|wheel|zoom|move down|move up)\b/i.test(query) && /\b(window|down|up|page|here)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const win = windowParam(input)
    if ('error' in win) return { ok: false, message: win.error, data: { kind: 'invalid_input' } }
    const coords = coordParams(input)
    if ('error' in coords) return { ok: false, message: coords.error, data: { kind: 'invalid_input' } }
    const delta = parseScrollDelta(paramNum(input, 'delta'))
    if ('error' in delta) return { ok: false, message: delta.error, data: { kind: 'invalid_input' } }
    try {
      const result = await this.provider.scroll(win.id, coords.x, coords.y, delta.value)
      const cancelled = injectedFailure(result)
      if (cancelled) return cancelled
      return {
        ok: true,
        message: `Injected a scroll of ${result.delta} wheel units at client (${coords.x}, ${coords.y}) in window ${win.id}.${CLICK_TIP}`,
        data: result,
      }
    } catch (error) {
      return desktopFailure(error)
    }
  }
}

/* ---------------------------------------------------------------- key press */

export class DesktopKeyPressTool extends DesktopTool {
  readonly id = 'desktop.key_press'
  readonly name = 'Press a key'
  readonly description =
    'Injects ONE key from the allow-list (a-z, 0-9, f1-f12, enter, tab, escape, space, backspace, delete, home, ' +
    'end, pageup, pagedown, arrows, shift, control, alt, capslock). Delivered to the window that currently has focus; ' +
    'its effect is not confirmed.'
  readonly permission: ToolPermission = 'low_risk'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: { key: { type: 'string', description: 'One allow-listed key name (e.g. "enter", "tab", "a").' } },
    required: ['key'],
  }

  canRun(query: string): boolean {
    return /\b(press|hit|tap|type the (enter|tab|return) key|send)\b/i.test(query) && /\b(key|enter|tab|escape|enter)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const parsed = parseDesktopKey(paramStr(input, 'key'))
    if ('error' in parsed) return { ok: false, message: parsed.error, data: { kind: 'invalid_input' } }
    try {
      const result: DesktopKeyResult = await this.provider.keyPress(parsed.key)
      const cancelled = injectedFailure(result)
      if (cancelled) return cancelled
      return {
        ok: true,
        message: `Injected the "${parsed.key}" key (sent to whichever window has focus). Effect not confirmed.`,
        data: { ...result, key: parsed.key },
      }
    } catch (error) {
      return desktopFailure(error)
    }
  }
}

/* ------------------------------------------------------------------ hotkey */

export class DesktopHotkeyTool extends DesktopTool {
  readonly id = 'desktop.hotkey'
  readonly name = 'Press a hotkey'
  readonly description =
    'Injects an allow-listed key combination (1 to 4 keys, e.g. ["control","shift","t"]). Modifiers are held first, then ' +
    'released after the remaining keys. Delivered to the focused window; its effect is not confirmed.'
  readonly permission: ToolPermission = 'low_risk'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      keys: { type: 'array', description: 'Allow-listed key names (max 4).' },
    },
    required: ['keys'],
  }

  canRun(query: string): boolean {
    return /\b(hotkey|shortcut|combination|press .* (and|then|plus|ctrl|control|shift|alt))\b/i.test(query) &&
      /\b(key|keys|ctrl|control|shift|alt|shortcut|hotkey)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const parsed = parseHotkeyKeys(input.params?.['keys'])
    if ('error' in parsed) return { ok: false, message: parsed.error, data: { kind: 'invalid_input' } }
    try {
      const result: DesktopKeyResult = await this.provider.hotkey(parsed.keys)
      const cancelled = injectedFailure(result)
      if (cancelled) return cancelled
      return {
        ok: true,
        message: `Injected the hotkey ${parsed.keys.join('+')} (sent to whichever window has focus). Effect not confirmed.`,
        data: { ...result, keys: parsed.keys },
      }
    } catch (error) {
      return desktopFailure(error)
    }
  }
}

/* -------------------------------------------------------------------- type */

export class DesktopTypeTool extends DesktopTool {
  readonly id = 'desktop.type'
  readonly name = 'Type text'
  readonly description =
    'Injects bounded text (up to 2000 characters) as real keyboard input, delivered to the focused window. Only the ' +
    'character COUNT is ever reported — the text itself is never echoed back or recorded, and it is never logged. ' +
    'This can submit forms or send messages, so use it only where the user approved the exact content.'
  readonly permission: ToolPermission = 'low_risk'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: { text: { type: 'string', description: 'Text to type (the tool never echoes it back).' } },
    required: ['text'],
  }

  canRun(query: string): boolean {
    return /\b(type|write|enter|paste into)\b/i.test(query) && /\b(text|text into|input|message|in the (field|box))\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const parsed = parseTypeText(paramStr(input, 'text'))
    if ('error' in parsed) return { ok: false, message: parsed.error, data: { kind: 'invalid_input' } }
    try {
      const result: DesktopKeyResult = await this.provider.typeText(parsed.text)
      const cancelled = injectedFailure(result)
      if (cancelled) return cancelled
      // Count only — the typed text itself must never return to the model,
      // a plan, a trace or any log.
      return {
        ok: true,
        message: `Injected ${result.length} characters of typed input (the text itself is never echoed back). Effect not confirmed.`,
        data: { length: result.length, injected: result.injected, cancelled: result.cancelled },
      }
    } catch (error) {
      return desktopFailure(error)
    }
  }
}

/* ------------------------------------------------------------------- focus */

export class WindowFocusTool extends DesktopTool {
  readonly id = 'window.focus'
  readonly name = 'Focus a window'
  readonly description =
    'Brings a visible window (from window.list) to the foreground. `focused` reflects the POST-attempt OS state: the ' +
    'tool only reports focus as achieved when the target window is the foreground window right now. A window that has ' +
    'closed or cannot be activated is reported honestly.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: { window_id: { type: 'string', description: 'Window id from window.list.' } },
    required: ['window_id'],
  }

  canRun(query: string): boolean {
    return /\b(focus|bring .*(to (the )?front|foreground)|switch to|show)\b/i.test(query) && /\b(window|app)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const win = windowParam(input)
    if ('error' in win) return { ok: false, message: win.error, data: { kind: 'invalid_input' } }
    try {
      const result: DesktopFocusResult = await this.provider.focusWindow(win.id)
      if (result.focused) {
        return { ok: true, message: `Brought window ${result.windowId} to the foreground (confirmed).`, data: result }
      }
      return { ok: false, message: `Could not bring window ${result.windowId} to the foreground: ${result.detail}`, data: result }
    } catch (error) {
      return desktopFailure(error)
    }
  }

  verify(_input: ToolInput, result: ToolResult): Promise<ToolVerification> {
    const focus = result.data as DesktopFocusResult | undefined
    if (!focus || typeof focus.focused !== 'boolean' || typeof focus.windowId !== 'string') {
      return Promise.resolve({ ok: false, message: 'The focus result carried no verifiable state.' })
    }
    return Promise.resolve(
      focus.focused
        ? { ok: true, message: `Confirmed window ${focus.windowId} is the foreground window.`, checks: ['foreground window'] }
        : { ok: false, message: `Verification failed: window ${focus.windowId} is not the foreground window: ${focus.detail}` },
    )
  }
}

/** All desktop-interaction tools bound to one provider (empty when none supplied). */
export function createDesktopTools(provider: DesktopProvider | undefined): Tool[] {
  if (!provider) return []
  return [
    new DesktopCursorTool(provider),
    new DesktopMoveTool(provider),
    new DesktopClickTool(provider),
    new DesktopDoubleClickTool(provider),
    new DesktopRightClickTool(provider),
    new DesktopScrollTool(provider),
    new DesktopKeyPressTool(provider),
    new DesktopHotkeyTool(provider),
    new DesktopTypeTool(provider),
    new WindowFocusTool(provider),
  ]
}