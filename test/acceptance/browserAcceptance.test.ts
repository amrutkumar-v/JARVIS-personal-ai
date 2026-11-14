/**
 * JARVIS Phase 4 / Workstream C: Browser Intelligence & Playwright Automation Acceptance Suite
 *
 * Verifies end-to-end browser automation:
 * 1. UniversalIntentRouter routes natural language browser requests (e.g. Test D:
 *    "Navigate to multiple web pages, extract text, compare sources, and take screenshots.")
 *    to BROWSER_WORKFLOW.
 * 2. All 11 browser tools (open, navigate, back, forward, refresh, click, type,
 *    readPage, search, screenshot, close) are registered and verified.
 * 3. Strict SSRF Protection: attempts to navigate to internal/loopback/private addresses
 *    are blocked before any browser network traffic occurs.
 * 4. Backend DesktopEngine executes browser RPC methods with honest verification.
 * 5. Persistent multi-step browser task DAG executes durably in TaskService with checkpoints.
 * 6. Closed-loop visual verification via browser.screenshot.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { UniversalIntentRouter } from '../../src/engine/orchestrator/UniversalIntentRouter'
import { AssistantEngine } from '../../src/engine/AssistantEngine'
import { DesktopEngine, verifyDesktopResult } from '../../server/src/desktop/DesktopEngine.js'
import { TaskService } from '../../server/src/taskService.js'
import { EventBus } from '../../server/src/events.js'
import { createLogger } from '../../server/src/log.js'
import { createBrowserTools } from '../../src/browser/BrowserTools'
import type { BrowserProvider } from '../../src/browser/provider'
import { RealBrowserBackend } from '../../native/src/browserInput.js'

function stubBrowserStorage(): void {
  const backing = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  ;(globalThis as Record<string, unknown>).window = {
    localStorage,
    setTimeout: (_fn: () => void) => 0,
    location: { hostname: '127.0.0.1', protocol: 'http:', port: '3000' },
  }
}

function createMockBrowserProvider(overrides?: Partial<BrowserProvider>): BrowserProvider {
  return {
    id: 'mock-browser-provider',
    capabilities: () => ({
      available: true,
      ops: {
        open: true,
        navigate: true,
        back: true,
        forward: true,
        refresh: true,
        click: true,
        type: true,
        readPage: true,
        search: true,
        screenshot: true,
        close: true,
        listTabs: true,
        newTab: true,
        switchTab: true,
        closeTab: true,
        fillForm: true,
        extractContent: true,
        download: true,
      },
    }),
    open: async (url?: string) => ({ success: true, url: url || 'about:blank' }),
    navigate: async (url: string) => ({ success: true, url, title: 'Test Web Page', verified: true }),
    back: async () => ({ success: true, url: 'https://example.com/back' }),
    forward: async () => ({ success: true, url: 'https://example.com/forward' }),
    refresh: async () => ({ success: true, url: 'https://example.com/refresh' }),
    click: async (selector: string) => ({ success: true, url: 'https://example.com/clicked', title: `Clicked ${selector}` }),
    type: async (_selector: string, _text: string) => ({ success: true, verified: true }),
    readPage: async () => ({
      success: true,
      title: 'Test Web Page',
      url: 'https://example.com',
      text: 'Extracted sample text from web page content for autonomous comparison.',
    }),
    search: async (query: string) => ({
      success: true,
      url: 'https://html.duckduckgo.com/html/?q=test',
      title: 'Search Results',
      results: [{ title: 'Result 1', url: 'https://example.com/1', snippet: `Snippet for ${query}` }],
    }),
    screenshot: async () => ({
      success: true,
      width: 1280,
      height: 720,
      format: 'png',
      bytes: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    }),
    close: async () => ({ success: true }),
    listTabs: async () => ({
      success: true,
      tabs: [{ index: 0, url: 'https://example.com', title: 'Example', active: true }],
    }),
    newTab: async (url?: string) => ({
      success: true,
      index: 1,
      url: url || 'about:blank',
      title: 'New Tab',
    }),
    switchTab: async (index: number) => ({
      success: true,
      index,
      url: 'https://example.com',
      title: 'Example',
    }),
    closeTab: async (_index?: number) => ({
      success: true,
      remainingCount: 1,
    }),
    fillForm: async (fields: Record<string, string>) => ({
      success: true,
      filled: Object.keys(fields),
      failed: [],
    }),
    extractContent: async () => ({
      success: true,
      title: 'Test Web Page',
      url: 'https://example.com',
      headings: [{ level: 1, text: 'Main Heading' }],
      text: 'Extracted text content from page.',
      tables: [{ headers: ['Header 1', 'Header 2'], rows: [['Val 1', 'Val 2']] }],
      links: [{ text: 'Link 1', href: 'https://example.com/page' }],
    }),
    download: async (_url: string, destinationPath: string) => ({
      success: true,
      path: destinationPath,
      size: 1024,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    }),
    ...overrides,
  }
}

describe('JARVIS 2.0 Browser Intelligence & Playwright Automation Acceptance Suite', () => {
  beforeEach(() => {
    stubBrowserStorage()
  })

  // --------------------------------------------------------------------------
  // Test 1: Intent Routing
  // --------------------------------------------------------------------------
  it('Test 1 — routes Test D natural language prompt to BROWSER_WORKFLOW', () => {
    const router = new UniversalIntentRouter()
    const decision = router.classify(
      'Navigate to multiple web pages, extract text, compare sources, and take screenshots.'
    )
    expect(decision.strategy).toBe('BROWSER_WORKFLOW')
    expect(decision.intent).toBe('multi_page_browser')
    expect(decision.suggestedCapabilities).toContain('browser.navigate')
    expect(decision.suggestedCapabilities).toContain('browser.readPage')
    expect(decision.suggestedCapabilities).toContain('browser.screenshot')
    expect(decision.entities.isMultiPage).toBe(true)
  })

  it('Test 1b — routes explicit URL navigation to BROWSER_WORKFLOW', () => {
    const router = new UniversalIntentRouter()
    const decision = router.classify('Open https://news.ycombinator.com and extract the headlines')
    expect(decision.strategy).toBe('BROWSER_WORKFLOW')
    expect(decision.entities.targetUrl).toBe('https://news.ycombinator.com')
  })

  // --------------------------------------------------------------------------
  // Test 2: Tool Registry & Capabilities
  // --------------------------------------------------------------------------
  it('Test 2 — creates all 18 browser tools with verified permission policies', () => {
    const provider = createMockBrowserProvider()
    const tools = createBrowserTools(provider)
    expect(tools.length).toBe(18)

    const toolIds = tools.map((t) => t.id)
    expect(toolIds).toContain('browser.open')
    expect(toolIds).toContain('browser.navigate')
    expect(toolIds).toContain('browser.back')
    expect(toolIds).toContain('browser.forward')
    expect(toolIds).toContain('browser.refresh')
    expect(toolIds).toContain('browser.click')
    expect(toolIds).toContain('browser.type')
    expect(toolIds).toContain('browser.readPage')
    expect(toolIds).toContain('browser.search')
    expect(toolIds).toContain('browser.screenshot')
    expect(toolIds).toContain('browser.close')
    expect(toolIds).toContain('browser.listTabs')
    expect(toolIds).toContain('browser.newTab')
    expect(toolIds).toContain('browser.switchTab')
    expect(toolIds).toContain('browser.closeTab')
    expect(toolIds).toContain('browser.fillForm')
    expect(toolIds).toContain('browser.extractContent')
    expect(toolIds).toContain('browser.download')

    // Read page and search must be read_only
    const readTool = tools.find((t) => t.id === 'browser.readPage')
    expect(readTool?.permission).toBe('read_only')

    const searchTool = tools.find((t) => t.id === 'browser.search')
    expect(searchTool?.permission).toBe('read_only')

    const listTabsTool = tools.find((t) => t.id === 'browser.listTabs')
    expect(listTabsTool?.permission).toBe('read_only')

    const extractContentTool = tools.find((t) => t.id === 'browser.extractContent')
    expect(extractContentTool?.permission).toBe('read_only')

    // State changing tools must be verifiable
    const navTool = tools.find((t) => t.id === 'browser.navigate')
    expect(navTool?.verifiable).toBe(true)

    const typeTool = tools.find((t) => t.id === 'browser.type')
    expect(typeTool?.verifiable).toBe(true)

    const newTabTool = tools.find((t) => t.id === 'browser.newTab')
    expect(newTabTool?.verifiable).toBe(true)

    const fillFormTool = tools.find((t) => t.id === 'browser.fillForm')
    expect(fillFormTool?.verifiable).toBe(true)

    const downloadTool = tools.find((t) => t.id === 'browser.download')
    expect(downloadTool?.verifiable).toBe(true)
  })

  // --------------------------------------------------------------------------
  // Test 3: SSRF Protection
  // --------------------------------------------------------------------------
  it('Test 3 — strictly blocks navigation to loopback and private IP addresses (SSRF gate)', async () => {
    const backend = new RealBrowserBackend()

    // 127.0.0.1
    await expect(backend.navigate('http://127.0.0.1:8787')).rejects.toThrow(/internal\/private address|refused|permission_denied/)

    // localhost
    await expect(backend.navigate('http://localhost:3000')).rejects.toThrow(/local\/internal hostname|internal\/private address|refused|permission_denied/)

    // Link-local AWS metadata 169.254.169.254
    await expect(backend.navigate('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/internal\/private address|refused|permission_denied/)

    // Invalid scheme (e.g. file:///)
    await expect(backend.navigate('file:///C:/Windows/System32/drivers/etc/hosts')).rejects.toThrow(/Only http:\/\/ and https:\/\/ URLs are allowed/)
  })

  // --------------------------------------------------------------------------
  // Test 4: Backend DesktopEngine & Result Verification
  // --------------------------------------------------------------------------
  it('Test 4 — verifyDesktopResult enforces honest evidence for browser operations', () => {
    // 1. Navigation verification
    expect(
      verifyDesktopResult('browser.navigate', {
        ok: true,
        message: 'Navigated',
        data: { url: 'https://example.com', verified: true },
      }).passed
    ).toBe(true)

    expect(
      verifyDesktopResult('browser.navigate', {
        ok: true,
        message: 'Navigated',
        data: { url: 'https://example.com', verified: false },
      }).passed
    ).toBe(false)

    // 2. Read page verification
    expect(
      verifyDesktopResult('browser.readPage', {
        ok: true,
        message: 'Read page',
        data: { text: 'Some content' },
      }).passed
    ).toBe(true)

    expect(
      verifyDesktopResult('browser.readPage', {
        ok: true,
        message: 'Read page',
        data: { text: undefined },
      }).passed
    ).toBe(false)

    // 3. Screenshot verification
    expect(
      verifyDesktopResult('browser.screenshot', {
        ok: true,
        message: 'Screenshot captured',
        data: { bytes: 'base64bytes' },
      }).passed
    ).toBe(true)

    expect(
      verifyDesktopResult('browser.screenshot', {
        ok: true,
        message: 'Screenshot captured',
        data: { bytes: '' },
      }).passed
    ).toBe(false)

    // 4. Content Extraction verification
    expect(
      verifyDesktopResult('browser.extractContent', {
        ok: true,
        message: 'Extracted content',
        data: { title: 'Test', headings: [], text: 'Extracted text' },
      }).passed
    ).toBe(true)

    expect(
      verifyDesktopResult('browser.extractContent', {
        ok: true,
        message: 'Failed extract',
        data: { text: undefined },
      }).passed
    ).toBe(false)

    // 5. Fill Form verification
    expect(
      verifyDesktopResult('browser.fillForm', {
        ok: true,
        message: 'Filled',
        data: { filled: ['username', 'email'] },
      }).passed
    ).toBe(true)

    expect(
      verifyDesktopResult('browser.fillForm', {
        ok: true,
        message: 'Filled none',
        data: { filled: [] },
      }).passed
    ).toBe(false)

    // 6. Download verification
    expect(
      verifyDesktopResult('browser.download', {
        ok: true,
        message: 'Downloaded',
        data: { path: 'D:/test.pdf', size: 1024, sha256: 'abc123' },
      }).passed
    ).toBe(true)

    expect(
      verifyDesktopResult('browser.download', {
        ok: true,
        message: 'Downloaded no hash',
        data: { path: 'D:/test.pdf', size: 1024 },
      }).passed
    ).toBe(false)
  })

  // --------------------------------------------------------------------------
  // Test 5: AssistantEngine Planning & Task Creation
  // --------------------------------------------------------------------------
  it('Test 5 — AssistantEngine plans and submits persistent browser automation task', async () => {
    let capturedReply = ''
    const engine = new AssistantEngine({
      browser: createMockBrowserProvider(),
    })

    engine.on((msg) => {
      if (msg.type === 'transcript' && msg.speaker === 'assistant') {
        capturedReply = msg.text
      }
    })

    await engine.process(
      'Navigate to multiple web pages, extract text, compare sources, and take screenshots.'
    )

    expect(capturedReply).toContain('Started persistent autonomous browser task')
    expect(capturedReply).toContain('Structured Playwright Execution Plan')
    expect(capturedReply).toContain('Navigate to primary source')
    expect(capturedReply).toContain('Navigate to secondary source')
    expect(capturedReply).toContain('Capture screenshot verification')

    const tasks = await engine.getPersistentTasks()
    expect(tasks.length).toBeGreaterThan(0)
    const browserTask = tasks[0]
    expect(browserTask.tags).toContain('browser')
    expect(browserTask.tags).toContain('playwright')
    expect(browserTask.subtasks.length).toBe(8)
    expect(browserTask.subtasks[0].capability).toBe('browser_open')
    expect(browserTask.subtasks[1].capability).toBe('browser_navigate')
    expect(browserTask.subtasks[2].capability).toBe('browser_read_page')
    expect(browserTask.subtasks[3].capability).toBe('browser_screenshot')
    expect(browserTask.subtasks[4].capability).toBe('browser_navigate')
    expect(browserTask.subtasks[5].capability).toBe('browser_read_page')
    expect(browserTask.subtasks[6].capability).toBe('browser_screenshot')
    expect(browserTask.subtasks[7].capability).toBe('browser_close')
  })

  // --------------------------------------------------------------------------
  // Test 6: TaskService Background Browser Task Execution
  // --------------------------------------------------------------------------
  it('Test 6 — TaskService executes multi-step browser task DAG durably with checkpoints', async () => {
    const bus = new EventBus()
    const log = createLogger({ write: () => {} })
    const service = new TaskService({
      bus,
      log,
      dataDir: 'server/data',
      useMemoryStorage: true,
    })

    // Custom executor mock that models native agent browser execution
    let pagesNavigated = 0
    let screenshotsTaken = 0
    let textsExtracted = 0

    const task = await service.createTask({
      title: 'Multi-Page Browser Workflow Acceptance Run',
      objective: 'Navigate to multiple web pages, extract text, compare sources, and take screenshots.',
      priority: 80,
      subtasks: [
        {
          title: 'Open browser',
          capability: 'browser_open',
          toolId: 'browser.open',
          payload: { url: 'about:blank' },
        },
        {
          title: 'Navigate to source 1',
          capability: 'browser_navigate',
          toolId: 'browser.navigate',
          payload: { url: 'https://news.ycombinator.com' },
          dependencies: ['step-1'],
        },
        {
          title: 'Extract text from source 1',
          capability: 'browser_read_page',
          toolId: 'browser.readPage',
          payload: {},
          dependencies: ['step-2'],
        },
        {
          title: 'Screenshot source 1',
          capability: 'browser_screenshot',
          toolId: 'browser.screenshot',
          payload: {},
          dependencies: ['step-3'],
        },
        {
          title: 'Navigate to source 2',
          capability: 'browser_navigate',
          toolId: 'browser.navigate',
          payload: { url: 'https://en.wikipedia.org/wiki/Artificial_intelligence' },
          dependencies: ['step-4'],
        },
        {
          title: 'Extract text from source 2',
          capability: 'browser_read_page',
          toolId: 'browser.readPage',
          payload: {},
          dependencies: ['step-5'],
        },
        {
          title: 'Screenshot source 2',
          capability: 'browser_screenshot',
          toolId: 'browser.screenshot',
          payload: {},
          dependencies: ['step-6'],
        },
        {
          title: 'Close browser',
          capability: 'browser_close',
          toolId: 'browser.close',
          payload: {},
          dependencies: ['step-7'],
        },
      ],
    })

    // Intercept orchestrator executor with simulated honest native responses for fast testing
    service.getOrchestrator().setExecutor(async (subtask) => {
      const cap = subtask.capability
      if (cap === 'browser_open') {
        return {
          success: true,
          output: { success: true, url: 'about:blank' },
          verification: { passed: true, evidence: 'Chromium browser session opened at about:blank.' },
        }
      }
      if (cap === 'browser_navigate') {
        pagesNavigated++
        return {
          success: true,
          output: { success: true, url: subtask.payload?.url, title: 'Web Page', verified: true },
          verification: { passed: true, evidence: `Navigated to ${subtask.payload?.url}` },
        }
      }
      if (cap === 'browser_read_page') {
        textsExtracted++
        return {
          success: true,
          output: { success: true, text: 'Extracted text content from web page for comparison.' },
          verification: { passed: true, evidence: 'Page text extracted (52 chars).' },
        }
      }
      if (cap === 'browser_screenshot') {
        screenshotsTaken++
        return {
          success: true,
          output: { success: true, bytes: 'base64bytes...', format: 'png' },
          verification: { passed: true, evidence: 'Screenshot captured.' },
        }
      }
      if (cap === 'browser_close') {
        return {
          success: true,
          output: { success: true },
          verification: { passed: true, evidence: 'Chromium browser session cleanly closed.' },
        }
      }
      return { success: false, error: 'Unknown subtask' }
    })

    // Run orchestrator tick
    await service.getOrchestrator().tick()

    const finalTask = await service.getTask(task.id)
    expect(finalTask?.state).toBe('COMPLETED')
    expect(pagesNavigated).toBe(2)
    expect(textsExtracted).toBe(2)
    expect(screenshotsTaken).toBe(2)
    expect(finalTask?.subtasks.every((s) => s.state === 'VERIFIED')).toBe(true)

    // Checkpoints verified
    expect(finalTask?.checkpoints.length).toBeGreaterThanOrEqual(8)
  })

  // --------------------------------------------------------------------------
  // Test 8: Advanced Browser Intelligence (Phase 8)
  // --------------------------------------------------------------------------
  it('Test 8 — advanced browser multi-tab, form filling, structured extraction, and safe download', async () => {
    const { FakeBrowserBackend } = await import('../../native/src/browserInput.js')
    const backend = new FakeBrowserBackend()

    // 1. Initial tabs state
    const tabs1 = await backend.listTabs()
    expect(tabs1.success).toBe(true)
    expect(tabs1.tabs).toHaveLength(1)
    expect(tabs1.tabs[0].active).toBe(true)

    // 2. Open new tab
    const newTabRes = await backend.newTab('https://example.com/research')
    expect(newTabRes.success).toBe(true)
    expect(newTabRes.index).toBe(1)
    expect(newTabRes.url).toBe('https://example.com/research')

    const tabs2 = await backend.listTabs()
    expect(tabs2.tabs).toHaveLength(2)
    expect(tabs2.tabs[1].active).toBe(true)

    // 3. Switch tab
    const switchRes = await backend.switchTab(0)
    expect(switchRes.success).toBe(true)
    expect(switchRes.index).toBe(0)

    const tabs3 = await backend.listTabs()
    expect(tabs3.tabs[0].active).toBe(true)

    // 4. Semantic form filling
    const fillRes = await backend.fillForm({
      username: 'alice',
      email: 'alice@example.com',
      newsletter: 'true',
    })
    expect(fillRes.success).toBe(true)
    expect(fillRes.filled).toEqual(['username', 'email', 'newsletter'])
    expect(backend.formValues['username']).toBe('alice')

    // 5. Structured content extraction
    const extractRes = await backend.extractContent({ includeTables: true, includeLinks: true })
    expect(extractRes.success).toBe(true)
    expect(extractRes.headings.length).toBeGreaterThan(0)
    expect(extractRes.tables.length).toBeGreaterThan(0)
    expect(extractRes.tables[0].headers).toEqual(['Col1', 'Col2'])
    expect(extractRes.links.length).toBeGreaterThan(0)
    expect(extractRes.links[0].href).toBe('https://example.com')

    // 6. Close tab
    const closeRes = await backend.closeTab(1)
    expect(closeRes.success).toBe(true)
    expect(closeRes.remainingCount).toBe(1)

    // 7. Safe download with allowed roots validation
    const allowedRoots = ['D:/JARVIS', 'D:/JARVIS/downloads']
    const dlRes = await backend.download('https://example.com/report.pdf', 'D:/JARVIS/downloads/report.pdf', allowedRoots)
    expect(dlRes.success).toBe(true)
    expect(dlRes.size).toBe(1024)
    expect(dlRes.sha256).toBeDefined()

    // 8. Block download outside allowed roots
    await expect(
      backend.download('https://example.com/malicious.exe', 'C:/Windows/System32/malicious.exe', allowedRoots)
    ).rejects.toThrow(/outside allowed roots|permission_denied/)
  })
})
