/**
 * JARVIS 3.1 — Phase Three: Real Playwright Browser Automation Validation
 *
 * Exercises the genuine Playwright browser engine end-to-end against live/public targets:
 * - Launch headless Chromium via RealBrowserBackend
 * - Navigate to public web target (https://example.com)
 * - Verify page title and DOM text extraction
 * - Perform closed-loop visual screenshot (PNG base64)
 * - Multi-tab lifecycle: newTab, listTabs, switchTab, closeTab
 * - Strict SSRF enforcement: block 127.0.0.1, localhost, 169.254.169.254, 10.0.0.1
 * - Clean teardown and browser resource disposal
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { RealBrowserBackend } from '../../native/src/browserInput.js'

describe('Phase 3 — Real Playwright Browser Automation Validation', () => {
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

  it('navigates to public URL, extracts title and verified DOM text', async () => {
    const navResult = await backend.navigate('https://example.com')
    expect(navResult.success).toBe(true)
    expect(navResult.url).toContain('example.com')
    expect(navResult.title).toBe('Example Domain')
    expect(navResult.verified).toBe(true)

    const readResult = await backend.readPage()
    expect(readResult.success).toBe(true)
    expect(readResult.title).toBe('Example Domain')
    expect(readResult.text).toContain('documentation examples')
  }, 30_000)

  it('captures a verified screenshot with genuine dimensions and PNG format', async () => {
    const ss = await backend.screenshot()
    expect(ss.success).toBe(true)
    expect(ss.format).toBe('png')
    expect(ss.width).toBeGreaterThan(0)
    expect(ss.height).toBeGreaterThan(0)
    expect(typeof ss.bytes).toBe('string')
    expect(ss.bytes.length).toBeGreaterThan(100)
    // Verify base64 PNG magic header (iVBORw0KGgo...)
    expect(ss.bytes.startsWith('iVBORw0KGgo')).toBe(true)
  }, 15_000)

  it('manages multi-tab lifecycle: open tab, list tabs, switch tab, and close tab', async () => {
    const newTabRes = await backend.newTab('https://example.com')
    expect(newTabRes.success).toBe(true)
    expect(newTabRes.index).toBe(1)

    const listRes = await backend.listTabs()
    expect(listRes.success).toBe(true)
    expect(listRes.tabs.length).toBe(2)
    expect(listRes.tabs.find((t) => t.active)?.index).toBe(1)

    const switchRes = await backend.switchTab(0)
    expect(switchRes.success).toBe(true)
    expect(switchRes.index).toBe(0)

    const closeTabRes = await backend.closeTab(1)
    expect(closeTabRes.success).toBe(true)

    const finalList = await backend.listTabs()
    expect(finalList.tabs.length).toBe(1)
  }, 30_000)

  it('enforces strict SSRF protection: blocks loopback, private IPs, and metadata services', async () => {
    const blockedUrls = [
      'http://127.0.0.1:8787/api/tasks',
      'http://localhost:3000',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.1/admin',
      'http://192.168.1.1',
    ]

    for (const url of blockedUrls) {
      await expect(backend.navigate(url)).rejects.toThrow()
    }
  }, 20_000)

  it('disposes browser cleanly and frees resources', async () => {
    const closeRes = await backend.close()
    expect(closeRes.success).toBe(true)
  }, 10_000)
})
