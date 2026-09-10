import type { WebCapabilities, WebDocument, WebDownloadResult, WebFetchOptions, WebProvider, WebSearchOptions, WebSearchResponse } from '../web/provider'
import { NativeAgentRpc } from './nativeRpc'
import type { NativeBridgeOptions } from './nativeRpc'

/**
 * Native Windows bridge provider for web access (Phase 2.9).
 *
 * Delegates all transport and connectivity state to the shared `NativeAgentRpc`.
 * When the native agent is reachable, every operation hits the REAL bounded
 * public-web backend (`RealWebBackend` in `native/src/web.ts`) — nothing is
 * simulated. When the agent is unreachable the provider says so honestly.
 */
export class NativeWindowsWebProvider implements WebProvider {
  readonly id = 'native-windows-web'
  private readonly rpc: NativeAgentRpc

  constructor(options: NativeBridgeOptions = {}, rpc?: NativeAgentRpc) {
    this.rpc = rpc ?? new NativeAgentRpc(options)
    // Kick off a bounded connectivity probe; capabilities() reflects its result.
    void this.rpc.probe()
  }

  capabilities(): WebCapabilities {
    const connected = this.rpc.knownStatus.connected
    if (!connected) {
      const known = this.rpc.knownStatus
      return {
        available: false,
        reason: known.reason ?? 'The native Windows agent is not available.',
        search: false,
        fetch: false,
        download: false,
      }
    }
    return { available: true, search: true, fetch: true, download: true }
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.rpc.call<T>(method, params)
  }

  async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResponse> {
    const result = await this.call<WebSearchResponse>('web.search', {
      query,
      maxResults: options.maxResults,
      timeoutMs: options.timeoutMs,
    })
    return result
  }

  async fetchDocument(url: string, options: WebFetchOptions = {}): Promise<WebDocument> {
    const result = await this.call<WebDocument>('web.fetch', {
      url,
      maxBytes: options.maxBytes,
      timeoutMs: options.timeoutMs,
    })
    return result
  }

  async download(url: string, options: WebDownloadOptions = {}): Promise<WebDownloadResult> {
    const result = await this.call<WebDownloadResult>('web.download', {
      url,
      maxBytes: options.maxBytes,
      timeoutMs: options.timeoutMs,
    })
    return result
  }
}

export type WebDownloadOptions = WebFetchOptions