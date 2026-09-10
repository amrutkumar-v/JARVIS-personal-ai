import type {
  BrowserCapabilities,
  BrowserProvider,
  BrowserNavResult,
  BrowserActionResult,
  BrowserTypeResult,
  BrowserReadPageResult,
  BrowserSearchResult,
  BrowserScreenshotResult,
} from '../browser/provider'
import { NativeAgentRpc } from './nativeRpc'
import type { NativeBridgeOptions } from './nativeRpc'

/**
 * Native Windows bridge provider for browser automation (Phase 4.0).
 *
 * Delegates all transport and connectivity state to the shared `NativeAgentRpc`.
 * When the native agent is reachable AND Playwright is installed, every
 * operation hits a REAL Chromium browser — nothing is simulated.
 * When the agent is unreachable or Playwright is missing the provider says so
 * honestly.
 */
export class NativeWindowsBrowserProvider implements BrowserProvider {
  readonly id = 'native-windows-browser'
  private readonly rpc: NativeAgentRpc

  constructor(options: NativeBridgeOptions = {}, rpc?: NativeAgentRpc) {
    this.rpc = rpc ?? new NativeAgentRpc(options)
    void this.rpc.probe()
  }

  capabilities(): BrowserCapabilities {
    const connected = this.rpc.knownStatus.connected
    const ops = Object.fromEntries(
      (['open', 'navigate', 'back', 'forward', 'refresh', 'click', 'type', 'readPage', 'search', 'screenshot', 'close'] as const).map((op) => [op, connected]),
    ) as Record<string, boolean>
    return {
      available: connected,
      reason: connected ? undefined : (this.rpc.knownStatus.reason ?? 'The native Windows agent is not available.'),
      ops: ops as Record<BrowserCapabilities['ops'] extends Record<infer K, boolean> ? K : never, boolean>,
    }
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.rpc.call<T>(method, params)
  }

  async open(url?: string): Promise<{ success: boolean; url: string }> {
    return this.call<{ success: boolean; url: string }>('browser.open', url ? { url } : {})
  }

  async navigate(url: string): Promise<BrowserNavResult> {
    return this.call<BrowserNavResult>('browser.navigate', { url })
  }

  async back(): Promise<{ success: boolean; url: string }> {
    return this.call<{ success: boolean; url: string }>('browser.back', {})
  }

  async forward(): Promise<{ success: boolean; url: string }> {
    return this.call<{ success: boolean; url: string }>('browser.forward', {})
  }

  async refresh(): Promise<{ success: boolean; url: string }> {
    return this.call<{ success: boolean; url: string }>('browser.refresh', {})
  }

  async click(selector: string): Promise<BrowserActionResult> {
    return this.call<BrowserActionResult>('browser.click', { selector })
  }

  async type(selector: string, text: string): Promise<BrowserTypeResult> {
    return this.call<BrowserTypeResult>('browser.type', { selector, text })
  }

  async readPage(): Promise<BrowserReadPageResult> {
    return this.call<BrowserReadPageResult>('browser.readPage', {})
  }

  async search(query: string): Promise<BrowserSearchResult> {
    return this.call<BrowserSearchResult>('browser.search', { query })
  }

  async screenshot(): Promise<BrowserScreenshotResult> {
    return this.call<BrowserScreenshotResult>('browser.screenshot', {})
  }

  async close(): Promise<{ success: boolean }> {
    return this.call<{ success: boolean }>('browser.close', {})
  }
}
