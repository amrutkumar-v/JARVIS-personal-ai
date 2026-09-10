/**
 * Web capability seam (Phase 2.9).
 *
 * The engine talks to the public web (search, fetch, download) exclusively
 * through this OPTIONAL provider. When the native Windows agent is unreachable
 * the provider reports `available: false` and no web.* tools are registered —
 * the model can never claim internet access it does not have.
 *
 * All content returned from the web is UNTRUSTED DATA. The Web bridge and
 * engine frame it as such: never as instructions, never executable.
 */

export interface WebCapabilities {
  available: boolean
  reason?: string
  search: boolean
  fetch: boolean
  download: boolean
}

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchResponse {
  query: string
  provider: string
  servedAt: number
  results: WebSearchResult[]
  freshness: { detectable: boolean; note: string }
}

export interface WebDocument {
  url: string
  finalUrl: string
  status: number
  contentType?: string
  title?: string
  text: string
  truncatedChars: number
  bytes: number
  fetchedAt: number
}

export interface WebDownloadResult {
  url: string
  finalUrl: string
  status: number
  contentType?: string
  content: string
  truncated: boolean
  size: number
  fetchedAt: number
}

export interface WebSearchOptions {
  maxResults?: number
  timeoutMs?: number
}

export interface WebFetchOptions {
  maxBytes?: number
  timeoutMs?: number
}

export type WebDownloadOptions = WebFetchOptions

export interface WebProvider {
  readonly id: string
  capabilities(): WebCapabilities
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResponse>
  fetchDocument(url: string, options?: WebFetchOptions): Promise<WebDocument>
  download(url: string, options?: WebDownloadOptions): Promise<WebDownloadResult>
}