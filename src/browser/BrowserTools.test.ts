import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  BrowserOpenTool,
  BrowserNavigateTool,
  BrowserBackTool,
  BrowserForwardTool,
  BrowserRefreshTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserReadPageTool,
  BrowserSearchTool,
  BrowserScreenshotTool,
  BrowserCloseTool,
  BrowserListTabsTool,
  BrowserNewTabTool,
  BrowserSwitchTabTool,
  BrowserCloseTabTool,
  BrowserFillFormTool,
  BrowserExtractContentTool,
  BrowserDownloadTool,
  createBrowserTools,
} from './BrowserTools'
import type { BrowserProvider } from './provider'

function createMockBrowserProvider(overrides?: Partial<BrowserProvider>): BrowserProvider {
  return {
    id: 'mock-browser',
    capabilities: () => ({
      available: true,
      ops: {
        open: true, navigate: true, back: true, forward: true, refresh: true,
        click: true, type: true, readPage: true, search: true, screenshot: true, close: true,
        listTabs: true, newTab: true, switchTab: true, closeTab: true,
        fillForm: true, extractContent: true, download: true,
      },
    }),
    open: vi.fn().mockResolvedValue({ success: true, url: 'about:blank' }),
    navigate: vi.fn().mockResolvedValue({ success: true, url: 'https://example.com', title: 'Example', verified: true }),
    back: vi.fn().mockResolvedValue({ success: true, url: 'https://prev.com' }),
    forward: vi.fn().mockResolvedValue({ success: true, url: 'https://next.com' }),
    refresh: vi.fn().mockResolvedValue({ success: true, url: 'https://example.com' }),
    click: vi.fn().mockResolvedValue({ success: true, url: 'https://example.com', title: 'Example' }),
    type: vi.fn().mockResolvedValue({ success: true, verified: true }),
    readPage: vi.fn().mockResolvedValue({ success: true, title: 'Example', url: 'https://example.com', text: 'Page content' }),
    search: vi.fn().mockResolvedValue({ success: true, url: 'https://google.com', title: 'Search', results: [] }),
    screenshot: vi.fn().mockResolvedValue({ success: true, width: 1280, height: 720, bytes: 'base64data', format: 'png' }),
    close: vi.fn().mockResolvedValue({ success: true }),
    listTabs: vi.fn().mockResolvedValue({ success: true, tabs: [{ index: 0, url: 'https://example.com', title: 'Example', active: true }] }),
    newTab: vi.fn().mockResolvedValue({ success: true, index: 1, url: 'about:blank', title: 'New Tab' }),
    switchTab: vi.fn().mockResolvedValue({ success: true, index: 0, url: 'https://example.com', title: 'Example' }),
    closeTab: vi.fn().mockResolvedValue({ success: true, remainingCount: 1 }),
    fillForm: vi.fn().mockResolvedValue({ success: true, filled: ['username'], failed: [] }),
    extractContent: vi.fn().mockResolvedValue({
      success: true,
      title: 'Example',
      url: 'https://example.com',
      headings: [{ level: 1, text: 'Heading' }],
      text: 'Content',
      tables: [],
      links: [],
    }),
    download: vi.fn().mockResolvedValue({
      success: true,
      path: '/path/file.pdf',
      size: 1024,
      sha256: 'abc123hash',
    }),
    ...overrides,
  }
}

describe('createBrowserTools', () => {
  it('returns empty array when provider is undefined', () => {
    expect(createBrowserTools(undefined)).toEqual([])
  })

  it('returns all tools when provider is provided', () => {
    const tools = createBrowserTools(createMockBrowserProvider())
    expect(tools).toHaveLength(18)
    const ids = tools.map((t) => t.id)
    expect(ids).toContain('browser.open')
    expect(ids).toContain('browser.navigate')
    expect(ids).toContain('browser.back')
    expect(ids).toContain('browser.forward')
    expect(ids).toContain('browser.refresh')
    expect(ids).toContain('browser.click')
    expect(ids).toContain('browser.type')
    expect(ids).toContain('browser.readPage')
    expect(ids).toContain('browser.search')
    expect(ids).toContain('browser.screenshot')
    expect(ids).toContain('browser.close')
    expect(ids).toContain('browser.listTabs')
    expect(ids).toContain('browser.newTab')
    expect(ids).toContain('browser.switchTab')
    expect(ids).toContain('browser.closeTab')
    expect(ids).toContain('browser.fillForm')
    expect(ids).toContain('browser.extractContent')
    expect(ids).toContain('browser.download')
  })
})

describe('Browser tools metadata', () => {
  it('readPage is read_only', () => {
    const tool = new BrowserReadPageTool(createMockBrowserProvider())
    expect(tool.permission).toBe('read_only')
  })

  it('navigate is low_risk', () => {
    const tool = new BrowserNavigateTool(createMockBrowserProvider())
    expect(tool.permission).toBe('low_risk')
  })

  it('click is low_risk', () => {
    const tool = new BrowserClickTool(createMockBrowserProvider())
    expect(tool.permission).toBe('low_risk')
  })

  it('type is low_risk and verifiable', () => {
    const tool = new BrowserTypeTool(createMockBrowserProvider())
    expect(tool.permission).toBe('low_risk')
    expect(tool.verifiable).toBe(true)
  })

  it('state-changing navigation tools are verifiable (actual page state)', () => {
    const provider = createMockBrowserProvider()
    for (const T of [BrowserOpenTool, BrowserNavigateTool, BrowserBackTool, BrowserForwardTool, BrowserRefreshTool, BrowserClickTool, BrowserCloseTool]) {
      const tool = new T(provider)
      expect(tool.verifiable).toBe(true)
      expect(typeof tool.verify).toBe('function')
    }
  })

  it('close is low_risk', () => {
    const tool = new BrowserCloseTool(createMockBrowserProvider())
    expect(tool.permission).toBe('low_risk')
  })
})

describe('Browser tool execution', () => {
  let provider: BrowserProvider

  beforeEach(() => {
    provider = createMockBrowserProvider()
  })

  it('opens browser', async () => {
    const tool = new BrowserOpenTool(provider)
    const result = await tool.execute({ query: 'open browser', params: {} }, { requestId: 'test' })
    expect(result.ok).toBe(true)
    expect(provider.open).toHaveBeenCalled()
  })

  it('navigates to URL', async () => {
    const tool = new BrowserNavigateTool(provider)
    const result = await tool.execute({ query: 'go to example.com', params: { url: 'https://example.com' } }, { requestId: 'test' })
    expect(result.ok).toBe(true)
    expect(provider.navigate).toHaveBeenCalledWith('https://example.com')
  })

  it('navigates requires URL', async () => {
    const tool = new BrowserNavigateTool(provider)
    const result = await tool.execute({ query: 'go to example.com', params: {} }, { requestId: 'test' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('No URL')
  })

  it('goes back', async () => {
    const tool = new BrowserBackTool(provider)
    const result = await tool.execute({ query: 'go back', params: {} }, { requestId: 'test' })
    expect(result.ok).toBe(true)
    expect(provider.back).toHaveBeenCalled()
  })

  it('goes forward', async () => {
    const tool = new BrowserForwardTool(provider)
    const result = await tool.execute({ query: 'go forward', params: {} }, { requestId: 'test' })
    expect(result.ok).toBe(true)
    expect(provider.forward).toHaveBeenCalled()
  })

  it('refreshes page', async () => {
    const tool = new BrowserRefreshTool(provider)
    const result = await tool.execute({ query: 'refresh page', params: {} }, { requestId: 'test' })
    expect(result.ok).toBe(true)
    expect(provider.refresh).toHaveBeenCalled()
  })

  it('clicks element', async () => {
    const tool = new BrowserClickTool(provider)
    const result = await tool.execute({ query: 'click button', params: { selector: '#btn' } }, { requestId: 'test' })
    expect(result.ok).toBe(true)
    expect(provider.click).toHaveBeenCalledWith('#btn')
  })

  it('click requires selector', async () => {
    const tool = new BrowserClickTool(provider)
    const result = await tool.execute({ query: 'click button', params: {} }, { requestId: 'test' })
    expect(result.ok).toBe(false)
  })

  it('types into input', async () => {
    const tool = new BrowserTypeTool(provider)
    const result = await tool.execute({ query: 'type hello', params: { selector: '#input', text: 'hello' } }, { requestId: 'test' })
    expect(result.ok).toBe(true)
    expect(provider.type).toHaveBeenCalledWith('#input', 'hello')
  })

  it('readPage returns page content', async () => {
    const tool = new BrowserReadPageTool(provider)
    const result = await tool.execute({ query: 'read page', params: {} }, { requestId: 'test' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('untrusted')
  })

  it('search returns results', async () => {
    provider = createMockBrowserProvider({
      search: vi.fn().mockResolvedValue({
        success: true,
        url: 'https://google.com',
        title: 'Google',
        results: [
          { title: 'Result 1', url: 'https://r1.com', snippet: 'Snippet 1' },
          { title: 'Result 2', url: 'https://r2.com', snippet: 'Snippet 2' },
        ],
      }),
    })
    const tool = new BrowserSearchTool(provider)
    const result = await tool.execute({ query: 'search for tests', params: { query: 'tests' } }, { requestId: 'test' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('2 results')
  })

  it('screenshot captures page', async () => {
    const tool = new BrowserScreenshotTool(provider)
    const result = await tool.execute({ query: 'take screenshot', params: {} }, { requestId: 'test' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('1280x720')
  })

  it('close closes browser', async () => {
    const tool = new BrowserCloseTool(provider)
    const result = await tool.execute({ query: 'close browser', params: {} }, { requestId: 'test' })
    expect(result.ok).toBe(true)
    expect(provider.close).toHaveBeenCalled()
  })

  it('handles unavailable provider', async () => {
    provider = createMockBrowserProvider({
      capabilities: () => ({
        available: false,
        reason: 'Playwright not installed',
        ops: {
          open: false, navigate: false, back: false, forward: false, refresh: false,
          click: false, type: false, readPage: false, search: false, screenshot: false, close: false,
          listTabs: false, newTab: false, switchTab: false, closeTab: false,
          fillForm: false, extractContent: false, download: false,
        },
      }),
    })
    const tool = new BrowserNavigateTool(provider)
    const result = await tool.execute({ query: 'go to example.com', params: { url: 'https://example.com' } }, { requestId: 'test' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('not available')
  })

  it('handles navigation failure', async () => {
    provider = createMockBrowserProvider({
      navigate: vi.fn().mockRejectedValue(new Error('Navigation timeout')),
    })
    const tool = new BrowserNavigateTool(provider)
    const result = await tool.execute({ query: 'go to example.com', params: { url: 'https://example.com' } }, { requestId: 'test' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Navigation timeout')
  })
})

describe('Browser tool verification (actual page state, not handler claims)', () => {
  let provider: BrowserProvider

  beforeEach(() => {
    provider = createMockBrowserProvider()
  })

  it('navigate verifies when the LIVE page confirms the requested URL', async () => {
    provider = createMockBrowserProvider({
      readPage: vi.fn().mockResolvedValue({ success: true, title: 'Example', url: 'https://example.com', text: 'Hi' }),
    })
    const tool = new BrowserNavigateTool(provider)
    const v = await tool.verify!({ query: 'go', params: { url: 'https://example.com' } }, {} as never, { requestId: 'v' })
    expect(v.ok).toBe(true)
    expect(v.checks).toContain('url_matches_requested')
  })

  it('navigate refutes when the actual URL differs from the requested one', async () => {
    provider = createMockBrowserProvider({
      navigate: vi.fn().mockResolvedValue({ success: true, url: 'https://evil.example', title: 'Evil', verified: true }),
      readPage: vi.fn().mockResolvedValue({ success: true, title: 'Evil', url: 'https://evil.example', text: '' }),
    })
    const tool = new BrowserNavigateTool(provider)
    const v = await tool.verify!({ query: 'go', params: { url: 'https://example.com' } }, {} as never, { requestId: 'v' })
    expect(v.ok).toBe(false)
  })

  it('navigate degrades to not-confirmed (never verified) when the page is unreachable', async () => {
    provider = createMockBrowserProvider({
      readPage: vi.fn().mockResolvedValue({ success: false, title: '', url: '', text: '' }),
    })
    const tool = new BrowserNavigateTool(provider)
    const v = await tool.verify!({ query: 'go', params: { url: 'https://example.com' } }, {} as never, { requestId: 'v' })
    expect(v.ok).toBe(false)
    expect(v.message).toMatch(/could not be reached/i)
  })

  it('open verifies via the actual page when no URL was requested', async () => {
    const tool = new BrowserOpenTool(provider)
    const v = await tool.verify!({ query: 'open browser', params: {} }, {} as never, { requestId: 'v' })
    expect(v.ok).toBe(true)
    expect(v.message).toContain('confirmed open')
  })

  it('open refutes when the requested URL did not land', async () => {
    const tool = new BrowserOpenTool(provider)
    const v = await tool.verify!({ query: 'open', params: { url: 'https://wanted.com' } }, {} as never, { requestId: 'v' })
    expect(v.ok).toBe(false)
    expect(v.message).toContain('not the requested')
  })

  it('back/forward/refresh confirm through a live reachable page', async () => {
    const back = await new BrowserBackTool(provider).verify!({ query: '', params: {} }, {} as never, { requestId: 'v' })
    const forward = await new BrowserForwardTool(provider).verify!({ query: '', params: {} }, {} as never, { requestId: 'v' })
    const refresh = await new BrowserRefreshTool(provider).verify!({ query: '', params: {} }, {} as never, { requestId: 'v' })
    expect(back.ok).toBe(true)
    expect(forward.ok).toBe(true)
    expect(refresh.ok).toBe(true)
    expect(provider.readPage).toHaveBeenCalled()
  })

  it('click confirms the session survived the click', async () => {
    const tool = new BrowserClickTool(provider)
    const v = await tool.verify!({ query: 'click', params: {} }, {} as never, { requestId: 'v' })
    expect(v.ok).toBe(true)
  })

  it('type confirms the page stayed live after typing', async () => {
    const tool = new BrowserTypeTool(provider)
    const v = await tool.verify!({ query: 'type', params: {} }, {} as never, { requestId: 'v' })
    expect(v.ok).toBe(true)
  })

  it('close verifies when the provider reports unavailable after closing', async () => {
    provider = createMockBrowserProvider({
      capabilities: () => ({
        available: false,
        reason: 'browser closed',
        ops: {
          open: false, navigate: false, back: false, forward: false, refresh: false,
          click: false, type: false, readPage: false, search: false, screenshot: false, close: false,
          listTabs: false, newTab: false, switchTab: false, closeTab: false,
          fillForm: false, extractContent: false, download: false,
        },
      }),
    })
    const tool = new BrowserCloseTool(provider)
    const v = await tool.verify!({ query: 'close', params: {} }, {} as never, { requestId: 'v' })
    expect(v.ok).toBe(true)
    expect(v.message).toContain('confirmed closed')
  })

  it('close refutes when the browser is still reachable', async () => {
    const tool = new BrowserCloseTool(provider)
    const v = await tool.verify!({ query: 'close', params: {} }, {} as never, { requestId: 'v' })
    expect(v.ok).toBe(false)
    expect(v.message).toMatch(/still reachable/i)
  })
})

describe('Advanced Browser Intelligence Tools (Phase 8)', () => {
  let provider: BrowserProvider

  beforeEach(() => {
    provider = createMockBrowserProvider()
  })

  it('BrowserListTabsTool lists open tabs', async () => {
    const tool = new BrowserListTabsTool(provider)
    expect(tool.permission).toBe('read_only')
    expect(tool.canRun('list open tabs in browser')).toBe(true)

    const res = await tool.execute({ query: 'list tabs', params: {} }, { requestId: 'test' })
    expect(res.ok).toBe(true)
    expect(res.data).toBeDefined()
    expect(provider.listTabs).toHaveBeenCalled()
  })

  it('BrowserNewTabTool opens a new tab and verifies active', async () => {
    const tool = new BrowserNewTabTool(provider)
    expect(tool.permission).toBe('low_risk')
    expect(tool.verifiable).toBe(true)
    expect(tool.canRun('open a new tab')).toBe(true)

    const res = await tool.execute({ query: 'new tab', params: { url: 'https://example.com' } }, { requestId: 'test' })
    expect(res.ok).toBe(true)
    expect(provider.newTab).toHaveBeenCalledWith('https://example.com')

    const v = await tool.verify!({ query: 'new tab', params: {} }, res, { requestId: 'test' })
    expect(v.ok).toBe(true)
  })

  it('BrowserSwitchTabTool switches active tab index', async () => {
    const tool = new BrowserSwitchTabTool(provider)
    expect(tool.permission).toBe('low_risk')
    expect(tool.canRun('switch tab to 1')).toBe(true)

    const res = await tool.execute({ query: 'switch tab', params: { index: 0 } }, { requestId: 'test' })
    expect(res.ok).toBe(true)
    expect(provider.switchTab).toHaveBeenCalledWith(0)
  })

  it('BrowserCloseTabTool closes tab and reports remaining count', async () => {
    const tool = new BrowserCloseTabTool(provider)
    expect(tool.permission).toBe('low_risk')
    expect(tool.canRun('close tab')).toBe(true)

    const res = await tool.execute({ query: 'close tab', params: { index: 0 } }, { requestId: 'test' })
    expect(res.ok).toBe(true)
    expect(provider.closeTab).toHaveBeenCalledWith(0)
  })

  it('BrowserFillFormTool semantically populates inputs and verifies', async () => {
    const tool = new BrowserFillFormTool(provider)
    expect(tool.permission).toBe('low_risk')
    expect(tool.verifiable).toBe(true)
    expect(tool.canRun('fill form with username and password')).toBe(true)

    const res = await tool.execute({ query: 'fill form', params: { fields: { username: 'testuser' } } }, { requestId: 'test' })
    expect(res.ok).toBe(true)
    expect(provider.fillForm).toHaveBeenCalledWith({ username: 'testuser' })

    const v = await tool.verify!({ query: 'fill form', params: {} }, res, { requestId: 'test' })
    expect(v.ok).toBe(true)
  })

  it('BrowserExtractContentTool returns structured headings, tables, links', async () => {
    const tool = new BrowserExtractContentTool(provider)
    expect(tool.permission).toBe('read_only')
    expect(tool.canRun('extract content and tables from page')).toBe(true)

    const res = await tool.execute({ query: 'extract content', params: { includeTables: true, includeLinks: true } }, { requestId: 'test' })
    expect(res.ok).toBe(true)
    expect(provider.extractContent).toHaveBeenCalledWith({ includeTables: true, includeLinks: true })
    expect(res.message).toContain('Extracted 1 heading(s)')
  })

  it('BrowserDownloadTool downloads file and confirms SHA-256 integrity', async () => {
    const tool = new BrowserDownloadTool(provider)
    expect(tool.permission).toBe('low_risk')
    expect(tool.verifiable).toBe(true)
    expect(tool.canRun('download file from url')).toBe(true)

    const res = await tool.execute({ query: 'download file', params: { url: 'https://example.com/test.pdf', destinationPath: 'D:/test.pdf' } }, { requestId: 'test' })
    expect(res.ok).toBe(true)
    expect(provider.download).toHaveBeenCalledWith('https://example.com/test.pdf', 'D:/test.pdf')

    const v = await tool.verify!({ query: 'download file', params: {} }, res, { requestId: 'test' })
    expect(v.ok).toBe(true)
    expect(v.checks).toContain('file_integrity')
  })
})

describe('Browser tool canRun', () => {
  it('open detects open browser queries', () => {
    const tool = new BrowserOpenTool(createMockBrowserProvider())
    expect(tool.canRun('open browser')).toBe(true)
    expect(tool.canRun('launch chrome')).toBe(true)
  })

  it('navigate detects navigation queries', () => {
    const tool = new BrowserNavigateTool(createMockBrowserProvider())
    expect(tool.canRun('go to example.com')).toBe(true)
    expect(tool.canRun('navigate to https://google.com')).toBe(true)
  })

  it('readPage detects reading queries', () => {
    const tool = new BrowserReadPageTool(createMockBrowserProvider())
    expect(tool.canRun('read the page')).toBe(true)
    expect(tool.canRun('what does the page say')).toBe(true)
  })

  it('search detects search queries', () => {
    const tool = new BrowserSearchTool(createMockBrowserProvider())
    expect(tool.canRun('search for cats')).toBe(true)
    expect(tool.canRun('google something')).toBe(true)
  })
})
