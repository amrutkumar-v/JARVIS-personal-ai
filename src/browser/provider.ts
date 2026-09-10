/**
 * Browser automation capability seam (Phase 4.0).
 *
 * The engine performs genuine browser automation exclusively through this
 * OPTIONAL provider. When Playwright is not installed or the native agent
 * is unreachable the provider reports `available: false` and no browser.*
 * tools are registered — the model can never claim browser access it does
 * not have.
 */

export type BrowserOp =
  | 'open'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'refresh'
  | 'click'
  | 'type'
  | 'readPage'
  | 'search'
  | 'screenshot'
  | 'close'

export interface BrowserCapabilities {
  /** False when the native agent is unreachable or Playwright is not installed. */
  available: boolean
  reason?: string
  ops: Record<BrowserOp, boolean>
}

export interface BrowserNavResult {
  success: boolean
  url: string
  title: string
  verified: boolean
}

export interface BrowserActionResult {
  success: boolean
  url: string
  title: string
}

export interface BrowserTypeResult {
  success: boolean
  verified: boolean
}

export interface BrowserReadPageResult {
  success: boolean
  title: string
  url: string
  text: string
}

export interface BrowserSearchResult {
  success: boolean
  url: string
  title: string
  results: Array<{ title: string; url: string; snippet: string }>
}

export interface BrowserScreenshotResult {
  success: boolean
  width: number
  height: number
  bytes: string
  format: 'png'
}

export interface BrowserProvider {
  readonly id: string
  capabilities(): BrowserCapabilities
  open(url?: string): Promise<{ success: boolean; url: string }>
  navigate(url: string): Promise<BrowserNavResult>
  back(): Promise<{ success: boolean; url: string }>
  forward(): Promise<{ success: boolean; url: string }>
  refresh(): Promise<{ success: boolean; url: string }>
  click(selector: string): Promise<BrowserActionResult>
  type(selector: string, text: string): Promise<BrowserTypeResult>
  readPage(): Promise<BrowserReadPageResult>
  search(query: string): Promise<BrowserSearchResult>
  screenshot(): Promise<BrowserScreenshotResult>
  close(): Promise<{ success: boolean }>
}
