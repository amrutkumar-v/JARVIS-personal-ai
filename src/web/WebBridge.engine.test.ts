import { describe, expect, it } from 'vitest'
import { AssistantEngine } from '../engine'
import { createFileSystemProvider } from '../filesystem'
import type { FileSystemProvider } from '../filesystem'
import { WebSearchTool, WebFetchTool, WebDownloadTool } from '../web'
import type { WebProvider } from '../web/provider'

/**
 * Phase 2.9 — web capability seam through the real engine.
 *
 * These tests drive the REAL AssistantEngine with scripted/fake providers
 * to verify the web.* tools are registered, capabilities are cataloged,
 * and the engine correctly handles web operations including untrusted
 * content framing and cancellation.
 */

function makeEngine(overrides: { web?: WebProvider; fileSystem?: FileSystemProvider } = {}) {
  const fileSystem = overrides.fileSystem ?? createFileSystemProvider()
  const web = overrides.web
  return new AssistantEngine({ fileSystem, web })
}

/** Minimal fake web provider for deterministic tests. */
class FakeWebProvider implements WebProvider {
  readonly id = 'fake-web'
  private _results: Awaited<ReturnType<WebProvider['search']>> | null = null
  private _doc: Awaited<ReturnType<WebProvider['fetchDocument']>> | null = null
  private _download: Awaited<ReturnType<WebProvider['download']>> | null = null
  private _available = true

  setAvailable(v: boolean) { this._available = v }
  setSearch(r: Awaited<ReturnType<WebProvider['search']>>) { this._results = r }
  setFetch(r: Awaited<ReturnType<WebProvider['fetchDocument']>>) { this._doc = r }
  setDownload(r: Awaited<ReturnType<WebProvider['download']>>) { this._download = r }

  capabilities() { return { available: this._available, search: this._available, fetch: this._available, download: this._available } }
  async search() { if (!this._results) throw new Error('no search result configured'); return this._results }
  async fetchDocument() { if (!this._doc) throw new Error('no fetch result configured'); return this._doc }
  async download() { 
    if (!this._download) throw new Error('no download result configured')
    if (this._download.truncated) throw new Error('The download exceeded the size limit and was refused as a bounded download.')
    return this._download 
  }
}

describe('Phase 2.9 — web capability through the engine', () => {
  it('registers NO web tools when provider is absent', () => {
    const engine = makeEngine({ web: undefined })
    expect(engine.tools.get('web.search')).toBeUndefined()
    expect(engine.tools.get('web.fetch')).toBeUndefined()
    expect(engine.tools.get('web.download')).toBeUndefined()
  })

  it('registers web tools when provider is present', () => {
    const web = new FakeWebProvider()
    const engine = makeEngine({ web })
    expect(engine.tools.get('web.search')).toBeInstanceOf(WebSearchTool)
    expect(engine.tools.get('web.fetch')).toBeInstanceOf(WebFetchTool)
    expect(engine.tools.get('web.download')).toBeInstanceOf(WebDownloadTool)
  })

  it('catalogs web capabilities when tools are registered', () => {
    const web = new FakeWebProvider()
    const engine = makeEngine({ web })
    const caps = engine.capabilityCatalog().filter((c) => c.category === 'web')
    expect(caps).toHaveLength(3)
    expect(caps.map((c) => c.id).sort()).toEqual(['web_download', 'web_read_page', 'web_search'])
  })

  it('does NOT catalog web capabilities when provider is absent', () => {
    const engine = makeEngine({ web: undefined })
    const caps = engine.capabilityCatalog().filter((c) => c.category === 'web')
    expect(caps).toHaveLength(0)
  })

  it('execute web.search returns framed untrusted data', async () => {
    const web = new FakeWebProvider()
    web.setSearch({
      query: 'test query',
      provider: 'duckduckgo',
      servedAt: Date.now(),
      results: [{ title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet 1' }],
      freshness: { detectable: false, note: 'no freshness' },
    })
    const engine = makeEngine({ web })
    const tool = engine.tools.get('web.search')
    const result = await tool!.execute({ query: 'test', params: { query: 'test query' } }, { requestId: '1' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('untrusted data')
    expect(result.data).toHaveProperty('untrusted', true)
  })

  it('execute web.fetch returns framed untrusted data', async () => {
    const web = new FakeWebProvider()
    web.setFetch({
      url: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      status: 200,
      contentType: 'text/html',
      title: 'Test Page',
      text: 'Hello world',
      truncatedChars: 0,
      bytes: 11,
      fetchedAt: Date.now(),
    })
    const engine = makeEngine({ web })
    const tool = engine.tools.get('web.fetch')
    const result = await tool!.execute({ query: 'test', params: { url: 'https://example.com/a' } }, { requestId: '1' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('untrusted data')
    expect(result.data).toHaveProperty('untrusted', true)
  })

  it('execute web.download returns framed untrusted data', async () => {
    const web = new FakeWebProvider()
    web.setDownload({
      url: 'https://example.com/file.txt',
      finalUrl: 'https://example.com/file.txt',
      status: 200,
      contentType: 'text/plain',
      content: 'file content',
      truncated: false,
      size: 12,
      fetchedAt: Date.now(),
    })
    const engine = makeEngine({ web })
    const tool = engine.tools.get('web.download')
    const result = await tool!.execute({ query: 'test', params: { url: 'https://example.com/file.txt' } }, { requestId: '1' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('untrusted data')
    expect(result.data).toHaveProperty('untrusted', true)
  })

  it('honestly refuses when provider reports unavailable', async () => {
    const web = new FakeWebProvider()
    web.setAvailable(false)
    const engine = makeEngine({ web })
    const tool = engine.tools.get('web.search')
    const result = await tool!.execute({ query: 'test', params: { query: 'test' } }, { requestId: '1' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('unavailable')
  })

  it('web.download refuses oversized payloads (provider reports truncated)', async () => {
    const web = new FakeWebProvider()
    web.setDownload({
      url: 'https://example.com/big',
      finalUrl: 'https://example.com/big',
      status: 200,
      contentType: 'text/plain',
      content: 'x'.repeat(10_000_000),
      truncated: true,
      size: 10_000_000,
      fetchedAt: Date.now(),
    })
    const engine = makeEngine({ web })
    const tool = engine.tools.get('web.download')
    const result = await tool!.execute({ query: 'test', params: { url: 'https://example.com/big' } }, { requestId: '1' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('exceeded the size limit')
  })
})