import { describe, expect, it } from 'vitest'
import {
  assertPublicHttpUrl,
  assertPublicHost,
  detectFreshnessQuery,
  extractHtmlText,
  parseDdgResults,
  RealWebBackend,
  WEB_LIMITS,
} from './web.js'
import type { LookupResult } from './web.js'
import { isNativeError } from './errors.js'

const PUBLIC = [{ address: '8.8.8.8', family: 4 }]
const _PUBLIC6 = [{ address: '2001:4860:4860::8888', family: 6 }]

function lookup(hosts: Array<[string, string, number]>): (host: string) => Promise<LookupResult[]> {
  const table = new Map<string, LookupResult[]>()
  for (const [host, address, family] of hosts) {
    const list = table.get(host) ?? []
    list.push({ address, family })
    table.set(host, list)
  }
  return async (host: string) => table.get(host) ?? PUBLIC
}

function fakeFetch(pages: Array<{ match?: (url: string) => boolean; status: number; contentType?: string; body: string; location?: string }>) {
  return (async (input: string | URL, _init?: RequestInit) => {
    const url = String(input)
    const page = pages.find((p) => !p.match || p.match(url))
    if (!page) return new Response('not found', { status: 404 })
    return new Response(page.body, {
      status: page.status,
      headers: {
        'content-type': page.contentType ?? 'text/html',
        ...(page.location ? { location: page.location } : {}),
      },
    })
  }) as unknown as typeof fetch
}

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn()
  } catch (error) {
    if (isNativeError(error)) return error.code
    throw error
  }
  return 'no-error'
}

describe('SSRF gate', () => {
  const noNet = async (_host: string): Promise<LookupResult[]> => PUBLIC

  it('blocks loopback and every private/reserved IPv4 range by literal', async () => {
    for (const url of [
      'http://127.0.0.1/x',
      'http://127.0.0.2/x',
      'http://0.0.0.0/x',
      'http://10.0.0.1/x',
      'http://100.64.1.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://172.16.0.1/x',
      'http://172.31.255.255/x',
      'http://192.168.1.1/x',
      'http://192.0.2.1/x',
      'http://198.51.100.1/x',
      'http://203.0.113.1/x',
      'http://224.0.0.5/x',
      'http://255.255.255.255/x',
    ]) {
      await expect(codeOf(() => assertPublicHttpUrl(url, noNet))).resolves.toBe('permission_denied')
    }
  })

  it('allows public IPv4 and IPv6 targets', async () => {
    await expect(assertPublicHttpUrl('http://8.8.8.8/x', noNet)).resolves.toBeUndefined()
    await expect(assertPublicHttpUrl('http://1.1.1.1/x', noNet)).resolves.toBeUndefined()
    await expect(assertPublicHttpUrl('http://[2606:4700:4700::1111]/x', noNet)).resolves.toBeUndefined()
  })

  it('blocks hostnames that RESOLVE to internal addresses (rebinding defense)', async () => {
    const resolving = lookup([
      ['internal.example', '10.0.0.4', 4],
      ['meta.example', '169.254.169.254', 4],
    ])
    await expect(codeOf(() => assertPublicHost('internal.example', resolving))).resolves.toBe('permission_denied')
    await expect(codeOf(() => assertPublicHost('meta.example', resolving))).resolves.toBe('permission_denied')
  })

  it('allows hostnames that resolve only to public addresses', async () => {
    const resolving = lookup([
      ['public.example', '1.2.3.4', 4],
      ['v6.example', '2001:4860:4860::1', 6],
    ])
    await expect(assertPublicHost('public.example', resolving)).resolves.toBeUndefined()
    await expect(assertPublicHost('v6.example', resolving)).resolves.toBeUndefined()
    // Multiple addresses: a single private one poisons the whole set.
    const mixed = lookup([
      ['mixed.example', '10.0.0.9', 4],
      ['mixed.example', '8.8.8.8', 4],
    ])
    await expect(codeOf(() => assertPublicHost('mixed.example', mixed))).resolves.toBe('permission_denied')
  })

  it('blocks IPv4-mapped IPv6 literals as IPv4', async () => {
    const mapped = lookup([['mapped.example', '::ffff:127.0.0.1', 6]])
    await expect(codeOf(() => assertPublicHost('mapped.example', mapped))).resolves.toBe('permission_denied')
    // Debug: trace what the URL parser gives us
    const testUrl = new URL('http://[::ffff:169.254.169.254]/x')
    console.log('parsed hostname:', testUrl.hostname, 'port:', testUrl.port, 'protocol:', testUrl.protocol)
    const result = await codeOf(() => assertPublicHttpUrl('http://[::ffff:169.254.169.254]/x', noNet))
    console.log('mapped literal test result:', result)
    expect(result).toBe('permission_denied')
  })

  it('blocks IPv6 loopback/ULA/link-local/multicast literals', async () => {
    for (const host of ['[::1]', '[fc00:1::2]', '[fe80::1]', '[ff02::1]', '[::]']) {
      // noNet never resolves, so these must trip the literal branch, not DNS.
      void noNet
      await expect(codeOf(() => assertPublicHttpUrl(`http://${host}/x`, noNet))).resolves.toBe('permission_denied')
    }
  })

  it('blocks dangerous schemes, credentials, empty hosts and bad resolution', async () => {
    await expect(codeOf(() => assertPublicHttpUrl('ftp://host/x', noNet))).resolves.toBe('invalid_argument')
    await expect(codeOf(() => assertPublicHttpUrl('file:///etc/passwd', noNet))).resolves.toBe('invalid_argument')
    await expect(codeOf(() => assertPublicHttpUrl('http://user:pw@host/x', noNet))).resolves.toBe('invalid_argument')
    await expect(codeOf(() => assertPublicHttpUrl('not-a-url', noNet))).resolves.toBe('invalid_argument')
    await expect(codeOf(() => assertPublicHost('unresolvable.invalid', async () => []))).resolves.toBe('io_error')
    await expect(codeOf(() => assertPublicHost('unresolvable.invalid', async () => Promise.reject(new Error('ENOTFOUND'))))).resolves.toBe('io_error')
  })

  it('rejects non-http partial boundaries like localhost names', async () => {
    await expect(codeOf(() => assertPublicHost('localhost', noNet))).resolves.toBe('permission_denied')
    await expect(codeOf(() => assertPublicHost('printer.local', noNet))).resolves.toBe('permission_denied')
  })
})

describe('html extraction (deterministic)', () => {
  it('strips scripts/styles and builds readable text', () => {
    const html =
      '<html><head><title>  My Page & Co </title><script>alert(1)</script></head>' +
      '<body><div><h1>Hello</h1><p>First <b>line</b>.</p></div><ul><li>One</li><li>Two</li></ul><style>.x{}</style></body></html>'
    const text = extractHtmlText(html)
    expect(text).toContain('Hello')
    expect(text).toContain('First line.')
    expect(text).toContain('One')
    expect(text).toContain('Two')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('<')
  })

  it('decodes common entities', () => {
    expect(extractHtmlText('<p>a & b < c > d " e &nbsp; f</p>')).toContain('a & b d " e f')
  })
})

describe('DDG results parsing (deterministic)', () => {
  it('parses titles, urls and snippets and decodes redirect urls', () => {
    const html = [
      '<div class="result results_links results_links_deep web-result">',
      '<h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=' +
        encodeURIComponent('https://example.com/news?a=1&b=2') +
        '&rut=abc">Latest <b>news</b></a></h2>',
      '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=' + encodeURIComponent('https://example.com/news') + '">A snippet about news</a>',
      '</div>',
      '<div class="result">',
      '<h2><a class="result__a" href="https://plain.example/">No snippet</a></h2>',
      '</div>',
    ].join('')
    const results = parseDdgResults(html, 10)
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ title: 'Latest news', url: 'https://example.com/news?a=1&b=2', snippet: 'A snippet about news' })
    expect(results[1].url).toBe('https://plain.example/')
    expect(results[1].snippet).toBe('')
  })

  it('respects the result limit', () => {
    const item = (n: number) =>
      `<div class="result"><h2><a class="result__a" href="https://x.example/${n}">T${n}</a></h2>` +
      `<a class="result__snippet" href="https://x.example/${n}">S${n}</a></div>`
    const html = Array.from({ length: 10 }, (_, i) => item(i + 1)).join('')
    expect(parseDdgResults(html, 3)).toHaveLength(3)
  })
})

describe('freshness detection', () => {
  it('flags time-sensitive queries and leaves others alone', () => {
    expect(detectFreshnessQuery('what is the latest news today')).toBe(true)
    expect(detectFreshnessQuery('current weather in London')).toBe(true)
    expect(detectFreshnessQuery('2026 F1 results now')).toBe(true)
    expect(detectFreshnessQuery('ruby vs python syntax')).toBe(false)
    expect(detectFreshnessQuery('how to tie a tie')).toBe(false)
  })
})

describe('RealWebBackend.search', () => {
  it('returns parsed results with honest provider/freshness metadata', async () => {
    const ddgHtml =
      '<div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=' +
      encodeURIComponent('https://news.example/1') +
      '">Item one</a></h2><a class="result__snippet" href="//duckduckgo.com/l/?uddg=' +
      encodeURIComponent('https://news.example/1') +
      '">The first snippet</a></div>'
    const backend = new RealWebBackend({
      fetchImpl: fakeFetch([{ match: (u) => u.includes('html.duckduckgo.com'), status: 200, body: ddgHtml }]),
      lookupImpl: lookup([['html.duckduckgo.com', '1.2.3.4', 4]]),
    })
    const result = await backend.search('latest news today')
    expect(result.provider).toBe('duckduckgo')
    expect(result.query).toBe('latest news today')
    expect(result.results).toHaveLength(1)
    expect(result.results[0].url).toBe('https://news.example/1')
    expect(result.freshness.detectable).toBe(false)
    expect(result.freshness.note).toMatch(/timestamps/)
  })

  it('reports honest failures when the search provider errors', async () => {
    const backend = new RealWebBackend({
      fetchImpl: fakeFetch([{ match: () => true, status: 503, body: 'busy' }]),
      lookupImpl: lookup([]),
    })
    await expect(codeOf(() => backend.search('anything'))).resolves.toBe('io_error')
    const broken = new RealWebBackend({
      fetchImpl: (async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch,
      lookupImpl: lookup([]),
    })
    await expect(codeOf(() => broken.search('anything'))).resolves.toBe('io_error')
  })
})

describe('RealWebBackend.fetchDocument', () => {
  const page = (body: string, contentType = 'text/html') =>
    fakeFetch([{ match: () => true, status: 200, contentType, body }])

  it('extracts title + readable text from an html page', async () => {
    const backend = new RealWebBackend({ fetchImpl: page('<html><head><title>Doc title</title></head><body><p>Hello world</p></body></html>'), lookupImpl: lookup([]) })
    const doc = await backend.fetchDocument('https://example.com/a')
    expect(doc.title).toBe('Doc title')
    expect(doc.text).toContain('Hello world')
    expect(doc.contentType).toBe('text/html')
    expect(doc.finalUrl).toBe('https://example.com/a')
    expect(doc.status).toBe(200)
  })

  it('returns plain text bodies verbatim', async () => {
    const backend = new RealWebBackend({
      fetchImpl: fakeFetch([{ match: () => true, status: 200, contentType: 'text/plain', body: 'just some raw text\nsecond line' }]),
      lookupImpl: lookup([]),
    })
    const doc = await backend.fetchDocument('https://example.com/raw.txt')
    expect(doc.contentType).toBe('text/plain')
    expect(doc.text).toContain('second line')
    expect(doc.title).toBeUndefined()
  })

  it('caps the byte stream and reports truncation in text', async () => {
    const big = '<html><body>' + '<p>'.repeat(20_000) + 'x</p>'.repeat(20_000) + '</body></html>'
    const backend = new RealWebBackend({
      fetchImpl: fakeFetch([{ match: () => true, status: 200, body: big }]),
      lookupImpl: lookup([]),
    })
    const doc = await backend.fetchDocument('https://example.com/big', { maxBytes: 64 * 1024 })
    expect(doc.bytes).toBeLessThanOrEqual(64 * 1024)
    expect(doc.text.length).toBeLessThanOrEqual(WEB_LIMITS.MAX_FETCH_TEXT_CHARS)
  })

  it('follows redirects but revalidates every hop against SSRF policy', async () => {
    const calls: string[] = []
    const backend = new RealWebBackend({
      fetchImpl: (async (input: string | URL) => {
        const url = String(input)
        calls.push(url)
        if (url === 'https://example.com/start') {
          return new Response('', { status: 302, headers: { location: 'https://evil.example/a', 'content-type': 'text/html' } })
        }
        return new Response('<html><body><p>fini</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      }) as unknown as typeof fetch,
      lookupImpl: lookup([['evil.example', '10.1.1.1', 4]]),
    })
    await expect(codeOf(() => backend.fetchDocument('https://example.com/start'))).resolves.toBe('permission_denied')
    expect(calls).toHaveLength(1)
  })

  it('allows redirects to public endpoints', async () => {
    let hop = 0
    const backend = new RealWebBackend({
      fetchImpl: (async (input: string | URL) => {
        const url = String(input)
        if (url === 'https://example.com/start') {
          return new Response('', { status: 301, headers: { location: 'https://example.com/final', 'content-type': 'text/html' } })
        }
        hop += 1
        return new Response('<html><body><p>final body</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      }) as unknown as typeof fetch,
      lookupImpl: lookup([]),
    })
    const doc = await backend.fetchDocument('https://example.com/start')
    expect(hop).toBe(1)
    expect(doc.finalUrl).toBe('https://example.com/final')
    expect(doc.text).toContain('final body')
  })
})

describe('RealWebBackend.download', () => {
  it('returns bounded text content for text-like payloads', async () => {
    const backend = new RealWebBackend({
      fetchImpl: fakeFetch([{ match: () => true, status: 200, contentType: 'text/plain', body: 'the content' }]),
      lookupImpl: lookup([]),
    })
    const d = await backend.download('https://example.com/notes.txt')
    expect(d.content).toBe('the content')
    expect(d.contentType).toBe('text/plain')
    expect(d.size).toBe(11)
    expect(d.truncated).toBe(false)
  })

  it('refuses non-text content', async () => {
    const backend = new RealWebBackend({
      fetchImpl: fakeFetch([{ match: () => true, status: 200, contentType: 'application/octet-stream', body: 'blob' }]),
      lookupImpl: lookup([]),
    })
    await expect(codeOf(() => backend.download('https://example.com/app.exe'))).resolves.toBe('unsupported')
  })

  it('refuses oversized payloads and error statuses', async () => {
    const huge = new RealWebBackend({
      fetchImpl: fakeFetch([{ match: () => true, status: 200, contentType: 'text/plain', body: 'x'.repeat(WEB_LIMITS.MAX_DOWNLOAD_MAX_BYTES + 100) }]),
      lookupImpl: lookup([]),
    })
    await expect(codeOf(() => huge.download('https://example.com/huge'))).resolves.toBe('too_large')
    const missing = new RealWebBackend({
      fetchImpl: fakeFetch([{ match: () => true, status: 404, contentType: 'text/html', body: 'nope' }]),
      lookupImpl: lookup([]),
    })
    await expect(codeOf(() => missing.download('https://example.com/nope'))).resolves.toBe('io_error')
  })
})