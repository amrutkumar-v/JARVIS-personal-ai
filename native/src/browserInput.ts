import { nativeError } from './errors.js'
import { lookup } from 'node:dns/promises'
import { assertPublicHost } from './web.js'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { resolve, normalize, dirname } from 'node:path'
import type {
  BrowserBackend,
  BrowserClickResult,
  BrowserNavigationResult,
  BrowserReadPageResult,
  BrowserScreenshotResult,
  BrowserSearchResult,
  BrowserTypeResult,
  BrowserTabInfo,
  BrowserListTabsResult,
  BrowserNewTabResult,
  BrowserSwitchTabResult,
  BrowserCloseTabResult,
  BrowserFillFormResult,
  BrowserExtractContentResult,
  BrowserDownloadResult,
  BrowserExtractedTable,
  BrowserExtractedLink,
} from './browser.js'
import { BROWSER_LIMITS } from './browser.js'

async function dnsLookup(host: string) {
  const entries = await lookup(host, { all: true })
  return entries.map((e) => ({ address: e.address, family: e.family }))
}

/** Validate URL format and strictly guard against SSRF (private/loopback/link-local addresses). */
async function validateBrowserUrl(urlStr: string): Promise<void> {
  const trimmed = urlStr.trim()
  if (trimmed === 'about:blank' || !trimmed) return
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw nativeError('invalid_argument', 'Invalid URL format.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw nativeError('invalid_argument', 'Only http:// and https:// URLs are allowed.')
  }
  if (parsed.username || parsed.password) {
    throw nativeError('invalid_argument', 'URLs with credentials are not allowed.')
  }
  await assertPublicHost(parsed.hostname, dnsLookup)
}

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
  bringToFront?(): Promise<void>
}

interface PwContext {
  newPage(): Promise<PwPage>
  pages?(): PwPage[]
  close(): Promise<void>
}

interface PwBrowser {
  newContext(): Promise<PwContext>
  close(): Promise<void>
}

let pw: any = null
let pwFailure: Error | null = null
let browser: PwBrowser | null = null
let browserContext: PwContext | null = null
let pages: PwPage[] = []
let activePageIndex = 0

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
  if (pages.length > 0 && activePageIndex < pages.length) {
    const current = pages[activePageIndex]
    try {
      await current.title()
      return current
    } catch {
      // The page crashed or was detached (common when the Chromium window
      // lives on a flaky desktop session). Reset the whole browser so the
      // next operation starts clean instead of leaking contexts.
      await resetBrowserState()
    }
  }

  const p = await loadPlaywright()
  if (!browser) {
    const isExplicitHeadless = process.env.JARVIS_BROWSER_HEADLESS === 'true' || process.env.CI === 'true'
    try {
      browser = await p.chromium.launch({
        headless: isExplicitHeadless,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      })
    } catch (error) {
      // Fallback to headless if headed window launch fails (e.g. headless CI or detached desktop session)
      try {
        browser = await p.chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        })
      } catch (innerError) {
        throw nativeError(
          'native_unavailable',
          `Could not launch Chromium: ${innerError instanceof Error ? innerError.message : String(innerError)}. Install with: npx playwright install chromium`,
        )
      }
    }
  }

  if (!browserContext) {
    browserContext = await (browser as any).newContext()
    pages = []
  }
  const page = await browserContext!.newPage()
  pages.push(page)
  activePageIndex = pages.length - 1
  return page
}

/** Close the shared browser and all its contexts/pages (cleans up leaks). */
async function resetBrowserState(): Promise<void> {
  pages = []
  activePageIndex = 0
  if (browserContext) {
    try {
      await browserContext.close()
    } catch {
      /* ignore */
    }
    browserContext = null
  }
  if (browser) {
    const b = browser
    browser = null
    try {
      await b.close()
    } catch {
      /* already gone — ignore */
    }
  }
}

/** True when Playwright lost the page because the renderer died/detached. */
function isLostFrameError(message: string): boolean {
  return /closed|detached|crash|destroyed|Target page, context or browser has been closed|Execution context was destroyed/i.test(message)
}

/**
 * Run a browser operation with one honest retry when the renderer crashed
 * mid-operation: the browser is relaunched and the operation re-run for real.
 */
async function withCrashRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isLostFrameError(message)) {
      await resetBrowserState()
      return await run()
    }
    throw error
  }
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
    if (url) {
      await validateBrowserUrl(url)
    }
    return withCrashRetry(async () => {
      const page = await ensureBrowser()
      if (url && url !== 'about:blank') {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_LIMITS.DEFAULT_TIMEOUT_MS })
      }
      return { success: true, url: page.url() }
    })
  }

  async navigate(url: string): Promise<BrowserNavigationResult> {
    await validateBrowserUrl(url)
    return withCrashRetry(async () => {
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
    })
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
    return withCrashRetry(async () => {
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
    })
  }

  async search(query: string): Promise<BrowserSearchResult> {
    return withCrashRetry(async () => {
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
    })
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
      for (const p of pages) {
        await p.close().catch(() => {})
      }
      pages = []
      activePageIndex = 0
      if (browserContext) {
        await browserContext.close().catch(() => {})
        browserContext = null
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

  async listTabs(): Promise<BrowserListTabsResult> {
    return withCrashRetry(async () => {
      await ensureBrowser()
      const tabs: BrowserTabInfo[] = []
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i]
        let title = ''
        try {
          title = await p.title()
        } catch {
          title = 'Untitled'
        }
        tabs.push({
          index: i,
          url: p.url ? p.url() : 'about:blank',
          title,
          active: i === activePageIndex,
        })
      }
      return { success: true, tabs }
    })
  }

  async newTab(url?: string): Promise<BrowserNewTabResult> {
    if (url) {
      await validateBrowserUrl(url)
    }
    return withCrashRetry(async () => {
      await ensureBrowser()
      if (!browserContext) {
        throw nativeError('native_unavailable', 'Browser context is unavailable.')
      }
      const page = await browserContext.newPage()
      pages.push(page)
      activePageIndex = pages.length - 1
      if (url && url !== 'about:blank') {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_LIMITS.DEFAULT_TIMEOUT_MS })
      }
      let title = ''
      try {
        title = await page.title()
      } catch {
        title = 'New Tab'
      }
      return { success: true, index: activePageIndex, url: page.url(), title }
    })
  }

  async switchTab(index: number): Promise<BrowserSwitchTabResult> {
    return withCrashRetry(async () => {
      await ensureBrowser()
      if (!Number.isFinite(index) || index < 0 || index >= pages.length) {
        throw nativeError('invalid_argument', `Tab index ${index} out of range (0..${pages.length - 1}).`)
      }
      activePageIndex = Math.floor(index)
      const page = pages[activePageIndex]
      if (typeof page.bringToFront === 'function') {
        await page.bringToFront().catch(() => {})
      }
      let title = ''
      try {
        title = await page.title()
      } catch {
        title = ''
      }
      return { success: true, index: activePageIndex, url: page.url(), title }
    })
  }

  async closeTab(index?: number): Promise<BrowserCloseTabResult> {
    return withCrashRetry(async () => {
      await ensureBrowser()
      const target = index !== undefined ? Math.floor(Number(index)) : activePageIndex
      if (!Number.isFinite(target) || target < 0 || target >= pages.length) {
        throw nativeError('invalid_argument', `Tab index ${target} out of range (0..${pages.length - 1}).`)
      }
      const pageToClose = pages[target]
      await pageToClose.close().catch(() => {})
      pages.splice(target, 1)
      if (pages.length === 0) {
        const page = await browserContext!.newPage()
        pages.push(page)
        activePageIndex = 0
      } else {
        if (activePageIndex >= pages.length) {
          activePageIndex = pages.length - 1
        }
      }
      return { success: true, remainingCount: pages.length }
    })
  }

  async fillForm(fields: Record<string, string>): Promise<BrowserFillFormResult> {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw nativeError('invalid_argument', 'fields must be a non-null object of key-value pairs.')
    }
    return withCrashRetry(async () => {
      const page = await ensureBrowser()
      const script = `
        ((data) => {
          const filled = [];
          const failed = [];
          function escape(s) { return s.replace(/["\\\\]/g, '\\\\$&'); }
          function find(key) {
            let el = document.getElementById(key);
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return el;
            if (key.startsWith('#') || key.startsWith('.') || key.includes('[')) {
              try { el = document.querySelector(key); if (el) return el; } catch (_) {}
            }
            const esc = escape(key);
            el = document.querySelector('input[name="' + esc + '"], textarea[name="' + esc + '"], select[name="' + esc + '"]');
            if (el) return el;
            el = document.querySelector('input[placeholder*="' + esc + '" i], textarea[placeholder*="' + esc + '" i]');
            if (el) return el;
            el = document.querySelector('[aria-label*="' + esc + '" i]');
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return el;
            el = document.querySelector('[data-testid*="' + esc + '" i], input[name*="' + esc + '" i]');
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return el;
            const labels = Array.from(document.querySelectorAll('label'));
            for (const lbl of labels) {
              const txt = (lbl.innerText || lbl.textContent || '').trim().toLowerCase();
              if (txt.includes(key.toLowerCase())) {
                if (lbl.htmlFor) {
                  const t = document.getElementById(lbl.htmlFor);
                  if (t) return t;
                }
                const ch = lbl.querySelector('input, textarea, select');
                if (ch) return ch;
              }
            }
            return null;
          }
          for (const [k, v] of Object.entries(data)) {
            const el = find(k);
            if (!el) { failed.push(k); continue; }
            try {
              const strVal = String(v);
              if (el.tagName === 'SELECT') {
                let optFound = false;
                for (let i = 0; i < el.options.length; i++) {
                  if (el.options[i].value === strVal || el.options[i].text.toLowerCase() === strVal.toLowerCase()) {
                    el.selectedIndex = i;
                    optFound = true;
                    break;
                  }
                }
                if (!optFound && el.options.length > 0) el.value = strVal;
              } else if (el.type === 'checkbox' || el.type === 'radio') {
                el.checked = strVal === 'true' || strVal === '1' || strVal === 'yes' || strVal === 'checked';
              } else {
                el.value = strVal;
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              filled.push(k);
            } catch (err) {
              failed.push(k);
            }
          }
          return { filled, failed };
        })(${JSON.stringify(fields)})
      `
      const res = await page.evaluate(script)
      return {
        success: res.filled.length > 0,
        filled: res.filled,
        failed: res.failed,
      }
    })
  }

  async extractContent(opts: { includeTables?: boolean; includeLinks?: boolean } = {}): Promise<BrowserExtractContentResult> {
    return withCrashRetry(async () => {
      const page = await ensureBrowser()
      const script = `
        ((opts) => {
          const title = document.title || '';
          const url = window.location.href || '';
          const headings = [];
          const headingEls = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
          for (const h of headingEls.slice(0, 50)) {
            const lvl = parseInt(h.tagName.substring(1), 10) || 1;
            const txt = (h.innerText || h.textContent || '').trim();
            if (txt) headings.push({ level: lvl, text: txt });
          }

          const bodyEl = document.body;
          const rawText = bodyEl ? (bodyEl.innerText || bodyEl.textContent || '') : '';
          const text = rawText.trim().slice(0, ${BROWSER_LIMITS.MAX_PAGE_TEXT_CHARS});

          const tables = [];
          if (opts.includeTables) {
            const tableEls = Array.from(document.querySelectorAll('table')).slice(0, 10);
            for (const tbl of tableEls) {
              const headers = [];
              const rows = [];
              const thEls = Array.from(tbl.querySelectorAll('th'));
              for (const th of thEls) {
                headers.push((th.innerText || th.textContent || '').trim());
              }
              const trEls = Array.from(tbl.querySelectorAll('tr'));
              for (const tr of trEls.slice(0, 50)) {
                const tdEls = Array.from(tr.querySelectorAll('td'));
                if (tdEls.length > 0) {
                  rows.push(tdEls.map(td => (td.innerText || td.textContent || '').trim()));
                }
              }
              tables.push({ headers, rows });
            }
          }

          const links = [];
          if (opts.includeLinks) {
            const aEls = Array.from(document.querySelectorAll('a[href]')).slice(0, 100);
            for (const a of aEls) {
              const txt = (a.innerText || a.textContent || '').trim();
              const href = a.href || '';
              if (txt && href && !href.startsWith('javascript:')) {
                links.push({ text: txt.slice(0, 120), href });
              }
            }
          }

          return { title, url, headings, text, tables, links };
        })(${JSON.stringify({ includeTables: Boolean(opts.includeTables), includeLinks: Boolean(opts.includeLinks) })})
      `
      const extracted = await page.evaluate(script)
      return {
        success: true,
        title: extracted.title,
        url: extracted.url,
        headings: extracted.headings || [],
        text: extracted.text || '',
        tables: extracted.tables || [],
        links: extracted.links || [],
      }
    })
  }

  async download(url: string, destinationPath: string, allowedRoots?: string[]): Promise<BrowserDownloadResult> {
    if (!url || !destinationPath) {
      throw nativeError('invalid_argument', 'Both "url" and "destinationPath" are required.')
    }
    await validateBrowserUrl(url)

    const normalizedDest = normalize(resolve(destinationPath))
    if (normalizedDest.includes('\0')) {
      throw nativeError('invalid_argument', 'Destination path contains null byte.')
    }

    if (allowedRoots && allowedRoots.length > 0) {
      const isContained = allowedRoots.some((r) => {
        const normRoot = normalize(resolve(r))
        return normalizedDest.toLowerCase().startsWith(normRoot.toLowerCase())
      })
      if (!isContained) {
        throw nativeError('permission_denied', `Destination "${destinationPath}" is outside allowed roots.`)
      }
    }

    try {
      const dir = dirname(normalizedDest)
      await fs.mkdir(dir, { recursive: true })

      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(BROWSER_LIMITS.DEFAULT_TIMEOUT_MS),
      })

      if (!res.ok) {
        throw nativeError('io_error', `HTTP ${res.status} ${res.statusText} while downloading ${url}`)
      }

      const arrayBuf = await res.arrayBuffer()
      const buf = Buffer.from(arrayBuf)
      const sha256 = createHash('sha256').update(buf).digest('hex')
      await fs.writeFile(normalizedDest, buf)

      return {
        success: true,
        path: normalizedDest,
        size: buf.length,
        sha256,
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw nativeError('io_error', `Download failed: ${message}`)
    }
  }
}

/**
 * In-memory Browser Backend for testing without launching Playwright Chromium.
 */
export class FakeBrowserBackend implements BrowserBackend {
  readonly id = 'fake-browser'
  readonly testsOnly = true
  tabs: Array<{ url: string; title: string }> = [{ url: 'about:blank', title: 'New Tab' }]
  activeTab = 0
  pageText = 'Default test page content.'
  headings: Array<{ level: number; text: string }> = [{ level: 1, text: 'Test Page Heading' }]
  tables: BrowserExtractedTable[] = [{ headers: ['Col1', 'Col2'], rows: [['A', 'B'], ['C', 'D']] }]
  links: BrowserExtractedLink[] = [{ text: 'Example Link', href: 'https://example.com' }]
  formValues: Record<string, string> = {}

  async open(url?: string): Promise<{ success: boolean; url: string }> {
    const targetUrl = url || 'about:blank'
    this.tabs[this.activeTab] = { url: targetUrl, title: 'Test Web Page' }
    return { success: true, url: targetUrl }
  }

  async navigate(url: string): Promise<BrowserNavigationResult> {
    await validateBrowserUrl(url)
    this.tabs[this.activeTab] = { url, title: 'Navigated Page' }
    return { success: true, url, title: 'Navigated Page', verified: true }
  }

  async back(): Promise<{ success: boolean; url: string }> {
    return { success: true, url: this.tabs[this.activeTab]?.url || 'about:blank' }
  }

  async forward(): Promise<{ success: boolean; url: string }> {
    return { success: true, url: this.tabs[this.activeTab]?.url || 'about:blank' }
  }

  async refresh(): Promise<{ success: boolean; url: string }> {
    return { success: true, url: this.tabs[this.activeTab]?.url || 'about:blank' }
  }

  async click(selector: string): Promise<BrowserClickResult> {
    return { success: true, url: this.tabs[this.activeTab]?.url || 'about:blank', title: `Clicked ${selector}` }
  }

  async type(selector: string, text: string): Promise<BrowserTypeResult> {
    this.formValues[selector] = text
    return { success: true, verified: true }
  }

  async readPage(): Promise<BrowserReadPageResult> {
    const tab = this.tabs[this.activeTab] || { url: 'about:blank', title: 'Test Web Page' }
    return { success: true, title: tab.title, url: tab.url, text: this.pageText }
  }

  async search(query: string): Promise<BrowserSearchResult> {
    return {
      success: true,
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      title: 'Search Results',
      results: [{ title: `Result for ${query}`, url: 'https://example.com/res', snippet: `Snippet for ${query}` }],
    }
  }

  async screenshot(): Promise<BrowserScreenshotResult> {
    return {
      success: true,
      width: 1280,
      height: 720,
      format: 'png',
      bytes: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    }
  }

  async close(): Promise<{ success: boolean }> {
    this.tabs = [{ url: 'about:blank', title: 'New Tab' }]
    this.activeTab = 0
    return { success: true }
  }

  async listTabs(): Promise<BrowserListTabsResult> {
    return {
      success: true,
      tabs: this.tabs.map((t, idx) => ({
        index: idx,
        url: t.url,
        title: t.title,
        active: idx === this.activeTab,
      })),
    }
  }

  async newTab(url?: string): Promise<BrowserNewTabResult> {
    if (url) await validateBrowserUrl(url)
    const targetUrl = url || 'about:blank'
    this.tabs.push({ url: targetUrl, title: 'New Tab' })
    this.activeTab = this.tabs.length - 1
    return { success: true, index: this.activeTab, url: targetUrl, title: 'New Tab' }
  }

  async switchTab(index: number): Promise<BrowserSwitchTabResult> {
    if (index < 0 || index >= this.tabs.length) {
      throw nativeError('invalid_argument', `Tab index ${index} out of range (0..${this.tabs.length - 1}).`)
    }
    this.activeTab = index
    const tab = this.tabs[this.activeTab]
    return { success: true, index: this.activeTab, url: tab.url, title: tab.title }
  }

  async closeTab(index?: number): Promise<BrowserCloseTabResult> {
    const target = index !== undefined ? index : this.activeTab
    if (target < 0 || target >= this.tabs.length) {
      throw nativeError('invalid_argument', `Tab index ${target} out of range.`)
    }
    this.tabs.splice(target, 1)
    if (this.tabs.length === 0) {
      this.tabs.push({ url: 'about:blank', title: 'New Tab' })
      this.activeTab = 0
    } else {
      this.activeTab = Math.min(this.activeTab, this.tabs.length - 1)
    }
    return { success: true, remainingCount: this.tabs.length }
  }

  async fillForm(fields: Record<string, string>): Promise<BrowserFillFormResult> {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw nativeError('invalid_argument', 'fields must be an object of key-value pairs.')
    }
    const filled: string[] = []
    for (const [k, v] of Object.entries(fields)) {
      this.formValues[k] = v
      filled.push(k)
    }
    return { success: true, filled, failed: [] }
  }

  async extractContent(opts?: { includeTables?: boolean; includeLinks?: boolean }): Promise<BrowserExtractContentResult> {
    const tab = this.tabs[this.activeTab] || { url: 'about:blank', title: 'Test Web Page' }
    return {
      success: true,
      title: tab.title,
      url: tab.url,
      headings: this.headings,
      text: this.pageText,
      tables: opts?.includeTables ? this.tables : [],
      links: opts?.includeLinks ? this.links : [],
    }
  }

  async download(url: string, destinationPath: string, allowedRoots?: string[]): Promise<BrowserDownloadResult> {
    await validateBrowserUrl(url)
    if (!destinationPath) throw nativeError('invalid_argument', 'destinationPath is required.')
    if (allowedRoots && allowedRoots.length > 0) {
      const normDest = normalize(resolve(destinationPath))
      const contained = allowedRoots.some(r => normDest.toLowerCase().startsWith(normalize(resolve(r)).toLowerCase()))
      if (!contained) {
        throw nativeError('permission_denied', `Destination "${destinationPath}" is outside allowed roots.`)
      }
    }
    return {
      success: true,
      path: destinationPath,
      size: 1024,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    }
  }
}
