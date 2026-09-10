import { nativeError } from './errors.js'
import type {
  BrowserBackend,
  BrowserClickResult,
  BrowserNavigationResult,
  BrowserReadPageResult,
  BrowserScreenshotResult,
  BrowserSearchResult,
  BrowserTypeResult,
} from './browser.js'
import { BROWSER_LIMITS } from './browser.js'

/**
 * Native Windows Agent — Playwright browser backend (Phase 4.0).
 *
 * Uses Playwright to control a real Chromium browser. Every operation
 * genuinely interacts with a live browser instance. The browser is lazily
 * launched on first use and maintained across operations.
 *
 * The Playwright import is dynamic to avoid hard-failing when Playwright
 * is not installed. When unavailable, the backend reports honestly.
 *
 * NOTE: This file intentionally uses `any` for Playwright page evaluate
 * callbacks because the native agent tsconfig has no DOM lib types.
 * The evaluate functions run IN THE BROWSER context where document/window
 * ARE available — the TypeScript limitation is a build-environment concern,
 * not a runtime one.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

interface PwPage {
  url(): string
  title(): Promise<string>
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void>
  goBack(opts?: { timeout?: number }): Promise<void>
  goForward(opts?: { timeout?: number }): Promise<void>
  reload(opts?: { timeout?: number }): Promise<void>
  click(selector: string, opts?: { timeout?: number }): Promise<void>
  fill(selector: string, text: string, opts?: { timeout?: number }): Promise<void>
  inputValue(selector: string, opts?: { timeout?: number }): Promise<string>
  evaluate(fn: any, ...args: any[]): Promise<any>
  screenshot(opts?: { type?: string }): Promise<Buffer>
  close(): Promise<void>
  waitForLoadState(state: string, opts?: { timeout?: number }): Promise<void>
  viewportSize(): { width: number; height: number } | null
}

interface PwBrowser {
  newContext(): Promise<{ newPage(): Promise<PwPage> }>
  close(): Promise<void>
}

let pw: any = null
let pwFailure: Error | null = null
let browser: PwBrowser | null = null
let currentPage: PwPage | null = null

async function loadPlaywright(): Promise<any> {
  if (pw) return pw
  if (pwFailure) throw pwFailure
  try {
    // Dynamic import — playwright is optional; loaded on first use
    pw = await import('playwright')
    return pw
  } catch (error) {
    pwFailure = nativeError(
      'native_unavailable',
      `Playwright is not installed: ${error instanceof Error ? error.message : String(error)}. Install it with: npx playwright install chromium`,
    )
    throw pwFailure
  }
}

async function ensureBrowser(): Promise<PwPage> {
  if (currentPage) {
    try {
      await currentPage.title()
      return currentPage
    } catch {
      currentPage = null
    }
  }

  const p = await loadPlaywright()
  if (!browser) {
    try {
      browser = await p.chromium.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      })
    } catch (error) {
      throw nativeError(
        'native_unavailable',
        `Could not launch Chromium: ${error instanceof Error ? error.message : String(error)}. Install with: npx playwright install chromium`,
      )
    }
  }

  const ctx = await (browser as PwBrowser).newContext()
  currentPage = await ctx.newPage()
  return currentPage
}

/**
 * Real Playwright browser backend (Phase 4.0).
 *
 * Every operation genuinely interacts with a live Chromium browser:
 *  - Navigation actually loads web pages;
 *  - Click actually interacts with DOM elements;
 *  - Type actually fills input fields;
 *  - ReadPage actually extracts page content;
 *  - Search actually performs web searches.
 *
 * The browser instance persists across operations until explicitly closed.
 */
export class RealBrowserBackend implements BrowserBackend {
  readonly id = 'real-browser'
  readonly testsOnly = false

  async open(url?: string): Promise<{ success: boolean; url: string }> {
    const page = await ensureBrowser()
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_LIMITS.DEFAULT_TIMEOUT_MS })
    }
    return { success: true, url: page.url() }
  }

  async navigate(url: string): Promise<BrowserNavigationResult> {
    const page = await ensureBrowser()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_LIMITS.DEFAULT_TIMEOUT_MS })
      return {
        success: true,
        url: page.url(),
        title: await page.title(),
        verified: true,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw nativeError('io_error', `Navigation failed: ${message}`)
    }
  }

  async back(): Promise<{ success: boolean; url: string }> {
    const page = await ensureBrowser()
    try {
      await page.goBack({ timeout: BROWSER_LIMITS.DEFAULT_TIMEOUT_MS })
      return { success: true, url: page.url() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw nativeError('io_error', `Back navigation failed: ${message}`)
    }
  }

  async forward(): Promise<{ success: boolean; url: string }> {
    const page = await ensureBrowser()
    try {
      await page.goForward({ timeout: BROWSER_LIMITS.DEFAULT_TIMEOUT_MS })
      return { success: true, url: page.url() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw nativeError('io_error', `Forward navigation failed: ${message}`)
    }
  }

  async refresh(): Promise<{ success: boolean; url: string }> {
    const page = await ensureBrowser()
    try {
      await page.reload({ timeout: BROWSER_LIMITS.DEFAULT_TIMEOUT_MS })
      return { success: true, url: page.url() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw nativeError('io_error', `Refresh failed: ${message}`)
    }
  }

  async click(selector: string): Promise<BrowserClickResult> {
    const page = await ensureBrowser()
    if (selector.length > BROWSER_LIMITS.MAX_SELECTOR_LENGTH) {
      throw nativeError('invalid_argument', 'Selector too long.')
    }
    try {
      await page.click(selector, { timeout: BROWSER_LIMITS.DEFAULT_TIMEOUT_MS })
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
      return {
        success: true,
        url: page.url(),
        title: await page.title(),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('Timeout') || message.includes('timeout')) {
        throw nativeError('timeout', `Click timed out: the element "${selector}" was not found or not clickable.`)
      }
      throw nativeError('io_error', `Click failed: ${message}`)
    }
  }

  async type(selector: string, text: string): Promise<BrowserTypeResult> {
    const page = await ensureBrowser()
    if (selector.length > BROWSER_LIMITS.MAX_SELECTOR_LENGTH) {
      throw nativeError('invalid_argument', 'Selector too long.')
    }
    if (text.length > BROWSER_LIMITS.MAX_TYPE_LENGTH) {
      throw nativeError('too_large', 'Text too long for type operation.')
    }
    try {
      await page.fill(selector, text, { timeout: BROWSER_LIMITS.DEFAULT_TIMEOUT_MS })
      let verified = false
      try {
        const value = await page.inputValue(selector, { timeout: 2000 })
        verified = value === text
      } catch {
        verified = false
      }
      return { success: true, verified }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('Timeout') || message.includes('timeout')) {
        throw nativeError('timeout', `Type timed out: the element "${selector}" was not found.`)
      }
      throw nativeError('io_error', `Type failed: ${message}`)
    }
  }

  async readPage(): Promise<BrowserReadPageResult> {
    const page = await ensureBrowser()
    try {
      const title = await page.title()
      const url = page.url()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const text: string = await page.evaluate(
        "(() => { const el = document.body; if (!el) return ''; return el.innerText || el.textContent || ''; })()",
      )
      const bounded = (typeof text === 'string' ? text : '').slice(0, BROWSER_LIMITS.MAX_PAGE_TEXT_CHARS)
      return { success: true, title, url, text: bounded }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw nativeError('io_error', `Read page failed: ${message}`)
    }
  }

  async search(query: string): Promise<BrowserSearchResult> {
    const page = await ensureBrowser()
    try {
      const encoded = encodeURIComponent(query)
      // DuckDuckGo HTML endpoint: returns real results without CAPTCHA to
      // automated browsers, unlike Google which blocks Playwright traffic.
      await page.goto(`https://html.duckduckgo.com/html/?q=${encoded}`, {
        waitUntil: 'domcontentloaded',
        timeout: BROWSER_LIMITS.DEFAULT_TIMEOUT_MS,
      })

      // Use string-based evaluate to avoid DOM type issues in native tsconfig
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const results: Array<{ title: string; url: string; snippet: string }> = await page.evaluate(
        `(() => { const max = ${BROWSER_LIMITS.MAX_SEARCH_RESULTS}; const items = []; const nodes = document.querySelectorAll('.result'); const arr = Array.from(nodes).slice(0, max); for (const node of arr) { const a = node.querySelector('.result__a'); if (!a) continue; const href = a.getAttribute('href') || ''; const uddg = a.getAttribute('uddg') || ''; const url = uddg ? uddg : href; const title = a.textContent ? a.textContent.trim() : ''; const snip = node.querySelector('.result__snippet'); const snippet = snip && snip.textContent ? snip.textContent.trim() : ''; if (title && url) items.push({ title: title, url: url, snippet: snippet.slice(0, 600) }); } return items; })()`,
      )

      return {
        success: true,
        url: page.url(),
        title: await page.title(),
        results,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw nativeError('io_error', `Search failed: ${message}`)
    }
  }

  async screenshot(): Promise<BrowserScreenshotResult> {
    const page = await ensureBrowser()
    try {
      const buffer = await page.screenshot({ type: 'png' })
      return {
        success: true,
        width: page.viewportSize()?.width ?? 1280,
        height: page.viewportSize()?.height ?? 720,
        bytes: buffer.toString('base64'),
        format: 'png',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw nativeError('io_error', `Screenshot failed: ${message}`)
    }
  }

  async close(): Promise<{ success: boolean }> {
    try {
      if (currentPage) {
        await currentPage.close().catch(() => {})
        currentPage = null
      }
      if (browser) {
        await browser.close().catch(() => {})
        browser = null
      }
      return { success: true }
    } catch {
      return { success: false }
    }
  }
}
