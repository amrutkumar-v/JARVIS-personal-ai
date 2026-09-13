/**
 * Native Windows Agent — browser automation backend seam (Phase 4.0).
 *
 * The agent performs genuine browser automation exclusively through this narrow
 * interface. A real backend uses Playwright to control a Chromium browser;
 * a tests-only memory backend drives protocol tests deterministically.
 *
 * Every operation:
 *  - is time-bounded;
 *  - returns honest verification of what was observed;
 *  - treats ALL web content as untrusted DATA;
 *  - never navigates to private/loopback/link-local addresses (SSRF gate).
 */

export type BrowserNavigationResult = {
  success: boolean
  url: string
  title: string
  /** True when the navigation was verified by observing the URL. */
  verified: boolean
}

export type BrowserClickResult = {
  success: boolean
  /** What was observed after the click. */
  url: string
  title: string
}

export type BrowserTypeResult = {
  success: boolean
  /** Whether the text was found in the input after typing. */
  verified: boolean
}

export type BrowserReadPageResult = {
  success: boolean
  title: string
  url: string
  /** Extracted text content (bounded). */
  text: string
}

export type BrowserSearchResult = {
  success: boolean
  url: string
  title: string
  results: Array<{ title: string; url: string; snippet: string }>
}

export type BrowserScreenshotResult = {
  success: boolean
  width: number
  height: number
  bytes: string
  format: 'png'
}

export interface BrowserBackend {
  id: string
  testsOnly?: boolean

  /** Open a new browser page/tab. */
  open(url?: string): Promise<{ success: boolean; url: string }>

  /** Navigate to a URL. */
  navigate(url: string): Promise<BrowserNavigationResult>

  /** Go back in browser history. */
  back(): Promise<{ success: boolean; url: string }>

  /** Go forward in browser history. */
  forward(): Promise<{ success: boolean; url: string }>

  /** Refresh the current page. */
  refresh(): Promise<{ success: boolean; url: string }>

  /** Click an element by CSS selector. */
  click(selector: string): Promise<BrowserClickResult>

  /** Type text into an input element. */
  type(selector: string, text: string): Promise<BrowserTypeResult>

  /** Read the current page's text content. */
  readPage(): Promise<BrowserReadPageResult>

  /** Search the web and return results from the current browser. */
  search(query: string): Promise<BrowserSearchResult>

  /** Capture a screenshot of the current page. */
  screenshot(): Promise<BrowserScreenshotResult>

  /** Close the browser. */
  close(): Promise<{ success: boolean }>
}

export const BROWSER_LIMITS = {
  /** Maximum characters in page text read. */
  MAX_PAGE_TEXT_CHARS: 100_000,
  /** Default navigation timeout (ms). */
  DEFAULT_TIMEOUT_MS: 30_000,
  /** Maximum search results returned. */
  MAX_SEARCH_RESULTS: 10,
  /** Maximum selector length. */
  MAX_SELECTOR_LENGTH: 500,
  /** Maximum text length for type operations. */
  MAX_TYPE_LENGTH: 10_000,
} as const
