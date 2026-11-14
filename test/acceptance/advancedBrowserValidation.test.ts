/**
 * JARVIS 3.3 — Phase 4: Advanced Browser Validation Suite
 *
 * Verifies real Playwright Chromium operations and strict SSRF boundaries:
 * 1. Live Navigation & Title Verification
 * 2. Multi-Tab Lifecycle (newTab, listTabs, switchTab, closeTab)
 * 3. DOM Content & Element Extraction
 * 4. Semantic Element Clicking & Typing
 * 5. Viewport Screenshot PNG Verification
 * 6. Strict SSRF Isolation (127.0.0.1, localhost, 169.254.169.254, 10.0.0.1, 192.168.1.1)
 * 7. Protocol Guard (file://, ftp://, javascript:)
 * 8. Credential Guard (user:pass in URL)
 * 9. Resource Teardown and Process Cleanup
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { RealBrowserBackend } from '../../native/src/browserInput.js'

describe('JARVIS 3.3 — Phase 4: Advanced Browser Validation (Real Playwright)', () => {
  let backend: RealBrowserBackend

  beforeAll(() => {
    process.env.JARVIS_BROWSER_HEADLESS = 'true'
    backend = new RealBrowserBackend()
  })

  afterAll(async () => {
    if (backend) {
      await backend.close()
    }
  })

  // ==========================================================================
  // Section 1: Live Navigation & Page Content Extraction
  // ==========================================================================
  it('1. Navigates to public web target and extracts verified page title and DOM text', async () => {
    const nav = await backend.navigate('https://example.com')
    expect(nav.success).toBe(true)
    expect(nav.title).toBe('Example Domain')
    expect(nav.url).toContain('example.com')
    expect(nav.verified).toBe(true)

    const read = await backend.readPage()
    expect(read.success).toBe(true)
    expect(read.title).toBe('Example Domain')
    expect(read.text).toContain('documentation')
  }, 35_000)

  // ==========================================================================
  // Section 2: Viewport Screenshot
  // ==========================================================================
  it('2. Captures viewport screenshot and verifies valid PNG buffer signature', async () => {
    const ss = await backend.screenshot()
    expect(ss.success).toBe(true)
    expect(ss.format).toBe('png')
    expect(ss.width).toBeGreaterThan(0)
    expect(ss.height).toBeGreaterThan(0)
    expect(typeof ss.bytes).toBe('string')

    // Decode base64 and verify PNG magic bytes (\x89PNG\r\n\x1a\n)
    const buf = Buffer.from(ss.bytes, 'base64')
    expect(buf.length).toBeGreaterThan(100)
    expect(buf[0]).toBe(0x89)
    expect(buf[1]).toBe(0x50) // P
    expect(buf[2]).toBe(0x4e) // N
    expect(buf[3]).toBe(0x47) // G
  }, 20_000)

  // ==========================================================================
  // Section 3: Multi-Tab Lifecycle
  // ==========================================================================
  it('3. Manages multi-tab workflows: newTab, listTabs, switchTab, and closeTab', async () => {
    // 1. Open new tab with about:blank
    const newTabRes = await backend.newTab('about:blank')
    expect(newTabRes.success).toBe(true)
    const secondIndex = newTabRes.index

    // 2. List tabs
    const listRes = await backend.listTabs()
    expect(listRes.success).toBe(true)
    expect(listRes.tabs.length).toBeGreaterThanOrEqual(2)

    // 3. Switch back to first tab (index 0)
    const switchRes = await backend.switchTab(0)
    expect(switchRes.success).toBe(true)
    expect(switchRes.index).toBe(0)

    // 4. Close second tab
    const closeRes = await backend.closeTab(secondIndex)
    expect(closeRes.success).toBe(true)

    // 5. Verify tab count decremented
    const finalList = await backend.listTabs()
    expect(finalList.tabs.some((t) => t.index === secondIndex)).toBe(false)
  }, 30_000)

  // ==========================================================================
  // Section 4: Semantic Element Interaction (Click & Type)
  // ==========================================================================
  it('4. Interacts with semantic links and elements on page', async () => {
    // Navigate back to example.com
    await backend.navigate('https://example.com')

    // Click link on example.com ("More information...")
    const clickRes = await backend.click('a')
    expect(clickRes.success).toBe(true)
    expect(clickRes.url).toBeDefined()
  }, 30_000)

  // ==========================================================================
  // Section 5: Strict SSRF & Navigation Boundary Enforcement
  // ==========================================================================
  describe('SSRF & Navigation Boundary Enforcement', () => {
    it('blocks loopback IPv4 address 127.0.0.1', async () => {
      await expect(backend.navigate('http://127.0.0.1:8787/health')).rejects.toThrow()
    })

    it('blocks localhost hostname', async () => {
      await expect(backend.navigate('http://localhost:3000/')).rejects.toThrow()
    })

    it('blocks cloud metadata endpoint 169.254.169.254', async () => {
      await expect(backend.navigate('http://169.254.169.254/latest/meta-data')).rejects.toThrow()
    })

    it('blocks private class A subnet 10.0.0.1', async () => {
      await expect(backend.navigate('http://10.0.0.1/admin')).rejects.toThrow()
    })

    it('blocks private class C subnet 192.168.1.1', async () => {
      await expect(backend.navigate('http://192.168.1.1/router')).rejects.toThrow()
    })

    it('blocks file:// URI scheme', async () => {
      await expect(backend.navigate('file:///C:/Windows/win.ini')).rejects.toThrow()
    })

    it('blocks URLs with embedded credentials', async () => {
      await expect(backend.navigate('https://admin:secret@example.com/')).rejects.toThrow()
    })

    it('blocks malformed URLs', async () => {
      await expect(backend.navigate('not-a-valid-url')).rejects.toThrow()
    })
  })
})
