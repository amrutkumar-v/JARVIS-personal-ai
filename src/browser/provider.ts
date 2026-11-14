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
  | 'listTabs'
  | 'newTab'
  | 'switchTab'
  | 'closeTab'
  | 'fillForm'
  | 'extractContent'
  | 'download'

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

export interface BrowserTabInfo {
  index: number
  url: string
  title: string
  active: boolean
}

export interface BrowserListTabsResult {
  success: boolean
  tabs: BrowserTabInfo[]
}

export interface BrowserNewTabResult {
  success: boolean
  index: number
  url: string
  title: string
}

export interface BrowserSwitchTabResult {
  success: boolean
  index: number
  url: string
  title: string
}

export interface BrowserCloseTabResult {
  success: boolean
  remainingCount: number
}

export interface BrowserFillFormResult {
  success: boolean
  filled: string[]
  failed: string[]
}

export interface BrowserExtractedTable {
  headers: string[]
  rows: string[][]
}

export interface BrowserExtractedLink {
  text: string
  href: string
}

export interface BrowserExtractContentResult {
  success: boolean
  title: string
  url: string
  headings: Array<{ level: number; text: string }>
  text: string
  tables: BrowserExtractedTable[]
  links: BrowserExtractedLink[]
}

export interface BrowserDownloadResult {
  success: boolean
  path: string
  size: number
  sha256: string
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
  listTabs?(): Promise<BrowserListTabsResult>
  newTab?(url?: string): Promise<BrowserNewTabResult>
  switchTab?(index: number): Promise<BrowserSwitchTabResult>
  closeTab?(index?: number): Promise<BrowserCloseTabResult>
  fillForm?(fields: Record<string, string>): Promise<BrowserFillFormResult>
  extractContent?(opts?: { includeTables?: boolean; includeLinks?: boolean }): Promise<BrowserExtractContentResult>
  download?(url: string, destinationPath: string, allowedRoots?: string[]): Promise<BrowserDownloadResult>
}
