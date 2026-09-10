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
import type { ObservationProvider, ScreenshotResult } from './provider'
import { normalizeWindowId } from './provider'
import { verifyPngEnvelope } from './pngVerify'

/**
 * Observation tools (Phase 1.4) — EYES, NOT HANDS.
 *
 * Three narrow read-only tools backed by the ObservationProvider seam:
 *
 *   window.list          read_only         list of windows, deterministically
 *   window.status        read_only         inspect one window (verifiable)
 *   desktop.screenshot   user_confirmation capture the entire primary screen
 *
 * The provider is OPTIONAL by design: when undefined (browser mode) no
 * observation tools exist at all — the engine never fabricates a fake screen.
 * Nothing here can move, focus, click or type. `desktop.screenshot` is the
 * only privacy-sensitive surface (it can expose private messages), so it is
 * gated behind explicit user confirmation and its verification is a
 * TRANSPORT-LEVEL PNG structural check — never a claim about picture content.
 */

function obsFailure(error: unknown): ToolResult {
  if (error instanceof FileSystemError) {
    return { ok: false, message: error.message, data: { kind: error.kind, windowId: error.path } }
  }
  const message = error instanceof Error ? error.message : 'Unknown observation failure.'
  return { ok: false, message }
}

/** Short-circuit when the observation capability is not actually available. */
function availabilityBlocker(provider: ObservationProvider): ToolResult | null {
  const caps = provider.capabilities()
  if (caps.available) return null
  return {
    ok: false,
    message: `Observation is not available right now: ${caps.reason ?? 'the provider is inactive.'}`,
    data: { available: false, reason: caps.reason },
  }
}

function paramStr(input: ToolInput, key: string): string | undefined {
  const value = input.params?.[key]
  return typeof value === 'string' ? value : undefined
}

abstract class ObservationTool implements Tool {
  readonly category: ToolCategory = 'system'
  readonly verifiable: boolean = false
  readonly requiresPermission: boolean = false
  protected readonly provider: ObservationProvider

  constructor(provider: ObservationProvider) {
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

/* ------------------------------------------------------------------- list */

export class WindowListTool extends ObservationTool {
  readonly id = 'window.list'
  readonly name = 'List windows'
  readonly description =
    'Lists the open top-level windows on this Windows desktop, deterministically ordered (visible windows first, ' +
    'then by title). Each entry reports the window id, title, owning process name, and visibility/minimized/maximized ' +
    'state. This is a plain read of the desktop — it never moves, focuses or changes any window.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = { type: 'object', properties: {}, required: [] }

  canRun(query: string): boolean {
    return /\b(list|show|find|what.*(open|running)|enumerate)\b/i.test(query) &&
      /\b(window|windows|desktop|app(lication)?s?)\b/i.test(query)
  }

  async execute(): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    try {
      const windows = await this.provider.listWindows()
      if (!windows.length) {
        return { ok: true, message: 'No top-level windows are currently observable.', data: { windows: [] } }
      }
      const visible = windows.filter((w) => w.visible).length
      return {
        ok: true,
        message: `${windows.length} window${windows.length === 1 ? '' : 's'} observed (${visible} visible).`,
        data: { windows, count: windows.length, visible },
      }
    } catch (error) {
      return obsFailure(error)
    }
  }
}

/* ----------------------------------------------------------------- status */

export class WindowStatusTool extends ObservationTool {
  readonly id = 'window.status'
  readonly name = 'Window status'
  readonly description =
    'Inspects one window by its id (from window.list) and reports its current title, owning process, bounds and ' +
    'state. A window that has closed is reported honestly as not found — never fabricated.'
  readonly permission: ToolPermission = 'read_only'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: { window_id: { type: 'string', description: 'Window id from window.list.' } },
    required: ['window_id'],
  }

  canRun(query: string): boolean {
    return /\b(status|is.*(open|visible|minimized|maximized|running)|check|who)\b/i.test(query) &&
      /\b(window|desktop)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const raw = paramStr(input, 'window_id')
    if (!raw) return { ok: false, message: 'Status for which window? Provide window_id.', data: { kind: 'invalid_input' } }
    const parsed = normalizeWindowId(raw)
    if ('error' in parsed) return { ok: false, message: parsed.error, data: { kind: 'invalid_input' } }
    try {
      const status = await this.provider.getWindowStatus(parsed.id)
      const state = [
        status.visible ? 'visible' : 'hidden',
        status.minimized ? 'minimized' : status.maximized ? 'maximized' : 'restored',
      ].join(', ')
      return { ok: true, message: `Window ${status.windowId} ("${status.title.slice(0, 80)}"): ${state}.`, data: status }
    } catch (error) {
      return obsFailure(error)
    }
  }

  verify(input: ToolInput): Promise<ToolVerification> {
    const raw = paramStr(input, 'window_id')
    const parsed = raw ? normalizeWindowId(raw) : undefined
    const id = parsed && 'id' in parsed ? parsed.id : undefined
    if (!id) {
      return Promise.resolve({ ok: false, message: 'No valid window_id to verify.' })
    }
    return this.provider
      .getWindowStatus(id)
      .then((status) =>
        status.exists
          ? { ok: true, message: `Confirmed window ${status.windowId} still exists.`, checks: ['window exists'] }
          : { ok: false, message: `Verification failed: window ${id} no longer exists.` },
      )
      .catch((error) => ({
        ok: false,
        message: `Verification failed: ${error instanceof Error ? error.message : 'unknown reason.'}`,
      }))
  }
}

/* -------------------------------------------------------------- screenshot */

export class DesktopScreenshotTool extends ObservationTool {
  readonly id = 'desktop.screenshot'
  readonly name = 'Screenshot the desktop'
  readonly description =
    'Captures the ENTIRE primary screen as a bounded PNG. Privacy-sensitive (it can show private messages and ' +
    'personal data), so this tool always asks for explicit approval first. The image is never saved to disk, never ' +
    'uploaded and never logged — it exists only transiently in the current conversation.'
  readonly permission: ToolPermission = 'user_confirmation'
  readonly requiresPermission = true
  readonly verifiable = true
  readonly timeoutMs = 10_000
  readonly inputSchema: ToolInputSchema = { type: 'object', properties: {}, required: [] }

  canRun(query: string): boolean {
    return /\b(screenshot|screen( shot|shot)?|capture|snapshot|see (the )?(desktop|screen)|look at)\b/i.test(query)
  }

  async execute(): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    try {
      const shot = await this.provider.captureScreenshot()
      const dataUrl = `data:image/png;base64,${shot.bytes}`
      return {
        ok: true,
        message: `Captured the desktop as a ${shot.width}x${shot.height} PNG (${shot.bytesLength} bytes).`,
        data: {
          width: shot.width,
          height: shot.height,
          format: shot.format,
          bytesLength: shot.bytesLength,
          dataUrl,
          availableForVision: false,
        },
      }
    } catch (error) {
      return obsFailure(error)
    }
  }

  verify(input: ToolInput, result: ToolResult): Promise<ToolVerification> {
    void input
    const shot = result.data as ScreenshotResult | undefined
    if (!shot || typeof shot.width !== 'number' || typeof shot.height !== 'number' || typeof shot.bytes !== 'string') {
      return Promise.resolve({ ok: false, message: 'The screenshot produced no verifiable payload.' })
    }
    // TRANSPORT-LEVEL verification: prove the payload is a structurally valid
    // PNG with the claimed geometry. It never claims to depict the screen.
    return verifyPngEnvelope(shot.width, shot.height, shot.bytes).then((outcome) =>
      outcome.ok
        ? {
            ok: true,
            message: `Verified a well-formed ${outcome.width}x${outcome.height} PNG (${outcome.bytes} bytes).`,
            checks: ['png signature', 'ihdr geometry', 'chunk crc', 'inflate size'],
          }
        : { ok: false, message: `Verification failed: ${outcome.reason}` },
    )
  }
}

/** All observation tools bound to one provider (empty when none supplied). */
export function createObservationTools(provider: ObservationProvider | undefined): Tool[] {
  if (!provider) return []
  return [new WindowListTool(provider), new WindowStatusTool(provider), new DesktopScreenshotTool(provider)]
}