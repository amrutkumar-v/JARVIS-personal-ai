import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolContextId,
  ToolInput,
  ToolPermission,
  ToolResult,
  ToolVerification,
} from '../tools/Tool'
import type { ToolInputSchema } from '../engine/provider'
import type { ClipboardProvider } from './provider'

/**
 * Clipboard tools (Phase 4.0) — read and write the Windows clipboard.
 *
 *   clipboard.read    read_only   reads the current clipboard text (never echoed in logs)
 *   clipboard.write   low_risk    writes text to the clipboard (verifiable)
 *
 * The provider is OPTIONAL: when undefined (browser mode / no native agent)
 * no clipboard tools exist at all. Raw clipboard content is NEVER logged to
 * the task log — only operation metadata.
 */
function availabilityBlocker(provider: ClipboardProvider): ToolResult | null {
  const caps = provider.capabilities()
  if (caps.available) return null
  return {
    ok: false,
    message: `Clipboard access is not available right now: ${caps.reason ?? 'the provider is inactive.'}`,
    data: { available: false, reason: caps.reason },
  }
}

function paramStr(input: ToolInput, key: string): string | undefined {
  const value = input.params?.[key]
  return typeof value === 'string' ? value : undefined
}

abstract class ClipboardTool implements Tool {
  readonly category: ToolCategory = 'system'
  readonly verifiable: boolean = false
  readonly requiresPermission: boolean = false
  readonly contexts: ToolContextId[] = ['desktop', 'generic']
  protected readonly provider: ClipboardProvider

  constructor(provider: ClipboardProvider) {
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

/* ----------------------------------------------------------------- read */

export class ClipboardReadTool extends ClipboardTool {
  readonly id = 'clipboard.read'
  readonly name = 'Read clipboard'
  readonly description =
    'Reads the current text content of the Windows clipboard. The content is returned as text but is never logged to the task log.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = { type: 'object', properties: {}, required: [] }

  canRun(query: string): boolean {
    return /\b(clipboard|paste|copied)\b/i.test(query) && /\b(read|get|show|what|see|check|contents?)\b/i.test(query)
  }

  async execute(_input?: ToolInput, _ctx?: ToolContext): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    try {
      const result = await this.provider.read()
      if (!result.success) {
        return { ok: false, message: 'Could not read the clipboard.', data: result }
      }
      if (result.text.length === 0) {
        return { ok: true, message: 'The clipboard is empty or contains non-text data.', data: { empty: true } }
      }
      // Return text to the model but NOT to task log (handled by engine)
      return {
        ok: true,
        message: `Clipboard contains ${result.byteLength} bytes of text.`,
        data: { text: result.text, byteLength: result.byteLength, verified: result.verified },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown clipboard failure.'
      return { ok: false, message }
    }
  }
}

/* ---------------------------------------------------------------- write */

export class ClipboardWriteTool extends ClipboardTool {
  readonly id = 'clipboard.write'
  readonly name = 'Write to clipboard'
  readonly description =
    'Writes text to the Windows clipboard. The written text is verified by reading it back from the clipboard.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The text to write to the clipboard.' },
    },
    required: ['text'],
  }

  canRun(query: string): boolean {
    return /\b(clipboard|copy)\b/i.test(query) && /\b(write|set|put|copy|save|store)\b/i.test(query)
  }

  async execute(input: ToolInput, _ctx?: ToolContext): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const text = paramStr(input, 'text')
    if (!text) {
      return { ok: false, message: 'No text provided to write to the clipboard.', data: { kind: 'invalid_input' } }
    }
    try {
      const result = await this.provider.write(text)
      if (!result.success) {
        return { ok: false, message: 'Could not write to the clipboard.', data: result }
      }
      return {
        ok: true,
        message: `Wrote ${result.byteLength} bytes to the clipboard.${result.verified ? ' Verified by read-back.' : ' Could not verify by read-back.'}`,
        data: { byteLength: result.byteLength, verified: result.verified },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown clipboard failure.'
      return { ok: false, message }
    }
  }

  verify(_input?: ToolInput, _result?: ToolResult, _ctx?: ToolContext): Promise<ToolVerification> {
    // Verify by reading the clipboard back
    return this.provider
      .read()
      .then((result) =>
        result.success && result.text.length > 0
          ? { ok: true, message: 'Clipboard content confirmed present.', checks: ['clipboard_read_back'] }
          : { ok: false, message: 'Clipboard read-back did not confirm content.' },
      )
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Unknown verification failure.'
        return { ok: false, message: `Verification failed: ${message}` }
      })
  }
}

/** All clipboard tools bound to one provider (empty when none supplied). */
export function createClipboardTools(provider: ClipboardProvider | undefined): Tool[] {
  if (!provider) return []
  return [new ClipboardReadTool(provider), new ClipboardWriteTool(provider)]
}
