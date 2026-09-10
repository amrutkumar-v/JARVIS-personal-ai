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
    ...overrides,
  }
}

describe('createBrowserTools', () => {
  it('returns empty array when provider is undefined', () => {
    expect(createBrowserTools(undefined)).toEqual([])
  })

  it('returns all tools when provider is provided', () => {
    const tools = createBrowserTools(createMockBrowserProvider())
    expect(tools).toHaveLength(11)
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
        ops: { open: false, navigate: false, back: false, forward: false, refresh: false, click: false, type: false, readPage: false, search: false, screenshot: false, close: false },
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
