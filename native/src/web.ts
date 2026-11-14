import { BlockList } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isNativeError, nativeError } from './errors.js'
import type {
  NativeDownloadResponse,
  NativeFetchResponse,
  NativeSearchResponse,
  NativeSearchResultItem,
  NativeWebCapabilitiesResult,
} from './protocol.js'

/**
 * Native Windows Agent — real web capability backend (Phase 2.9).
 *
 * This is the ONLY place outbound HTTP happens. The browser never fetches
 * arbitrary pages directly (CORS + it would skip every bound here). Every
 * operation:
 *
 *  - validates the target URL against an SSRF policy BEFORE any connect and
 *    AGAIN on every redirect hop (private/loopback/link-local/reserved
 *    ranges, credentials, non-http schemes);
 *  - is size-bounded (response bodies are streamed with a hard cap);
 *  - is time-bounded (caller-provided timeout, hard-capped);
 *  - never follows more than a bounded number of redirects;
 *  - treats EVERYTHING that comes back as untrusted DATA. Web content is
 *    never instructions; the Web bridge and engine frame it as such.
 *
 * `web.search` uses the keyless DuckDuckGo HTML endpoint (no API keys needed),
 * `web.fetch` returns extracted readable text, `web.download` returns bounded
 * raw text for saving via the normal filesystem rails.
 */

/* --------------------------------------------------------------- bounds */

export const WEB_LIMITS = {
  MAX_QUERY_LENGTH: 200,
  DEFAULT_SEARCH_RESULTS: 8,
  MAX_SEARCH_RESULTS: 20,
  /** Max bytes of the DDG results page we are willing to read. */
  SEARCH_PAGE_MAX_BYTES: 2 * 1024 * 1024,
  DEFAULT_FETCH_MAX_BYTES: 512 * 1024,
  MAX_FETCH_MAX_BYTES: 2 * 1024 * 1024,
  DEFAULT_DOWNLOAD_MAX_BYTES: 1024 * 1024,
  MAX_DOWNLOAD_MAX_BYTES: 8 * 1024 * 1024,
  DEFAULT_REQUEST_TIMEOUT_MS: 20_000,
  MAX_REQUEST_TIMEOUT_MS: 30_000,
  MAX_REDIRECTS: 5,
  /** Characters of extracted fetch text kept per document. */
  MAX_FETCH_TEXT_CHARS: 90_000,
  MAX_RESULT_TITLE_CHARS: 300,
  MAX_RESULT_SNIPPET_CHARS: 600,
  MAX_RESULT_CHARS: 1_200,
} as const

export const SEARCH_PROVIDER = 'duckduckgo'

/* ------------------------------------------------------------- SSRF gate */

/**
 * Everything an outbound request must never touch. `BlockList` keeps the
 * policy readable; we ALSO re-check IPv4-mapped IPv6 addresses explicitly
 * because mapped literals would otherwise slip through the v6 list.
 */
const PRIVATE_V4 = new BlockList()
PRIVATE_V4.addSubnet('0.0.0.0', 8)
PRIVATE_V4.addSubnet('10.0.0.0', 8)
PRIVATE_V4.addSubnet('100.64.0.0', 10)
PRIVATE_V4.addSubnet('127.0.0.0', 8)
PRIVATE_V4.addSubnet('169.254.0.0', 16)
PRIVATE_V4.addSubnet('172.16.0.0', 12)
PRIVATE_V4.addSubnet('192.0.0.0', 24)
PRIVATE_V4.addSubnet('192.0.2.0', 24)
PRIVATE_V4.addSubnet('192.168.0.0', 16)
PRIVATE_V4.addSubnet('198.18.0.0', 15)
PRIVATE_V4.addSubnet('198.51.100.0', 24)
PRIVATE_V4.addSubnet('203.0.113.0', 24)
PRIVATE_V4.addSubnet('224.0.0.0', 4)
PRIVATE_V4.addSubnet('240.0.0.0', 4)

const PRIVATE_V6 = new BlockList()
PRIVATE_V6.addSubnet('::1', 128, 'ipv6')
PRIVATE_V6.addSubnet('64:ff9b:1::', 48, 'ipv6')
PRIVATE_V6.addSubnet('100::', 64, 'ipv6')
PRIVATE_V6.addSubnet('2001:db8::', 32, 'ipv6')
PRIVATE_V6.addSubnet('fc00::', 7, 'ipv6')
PRIVATE_V6.addSubnet('fe80::', 10, 'ipv6')
PRIVATE_V6.addSubnet('ff00::', 8, 'ipv6')

/** Reject literal IPv4 / IPv6-mapped addresses that hit the block list. */
export function isBlockedAddress(address: string, family: number): boolean {
  if (family === 4) return PRIVATE_V4.check(address, 'ipv4')
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) must be judged as IPv4.
  const lower = address.toLowerCase()
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length)
    return PRIVATE_V4.check(mapped, 'ipv4') || PRIVATE_V6.check(address, 'ipv6')
  }
  // RFC 6052 Well-Known Prefix (64:ff9b::/96) IPv4/IPv6 translation: evaluate translated IPv4
  if (lower.startsWith('64:ff9b::')) {
    const suffix = lower.slice('64:ff9b::'.length)
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(suffix)) {
      return PRIVATE_V4.check(suffix, 'ipv4')
    }
    const parts = suffix.split(':')
    if (parts.length === 2) {
      const p1 = parseInt(parts[0], 16)
      const p2 = parseInt(parts[1], 16)
      if (!isNaN(p1) && !isNaN(p2)) {
        const ip4 = `${(p1 >> 8) & 0xff}.${p1 & 0xff}.${(p2 >> 8) & 0xff}.${p2 & 0xff}`
        return PRIVATE_V4.check(ip4, 'ipv4')
      }
    }
  }
  // Explicit literal checks for addresses BlockList may not cover with /128.
  if (lower === '::1') return true
  if (lower === '::') return true
  if (lower.startsWith('fe80:')) return true
  if (lower.startsWith('fc00:') || lower.startsWith('fd00:')) return true
  if (lower.startsWith('ff00:')) return true
  return PRIVATE_V6.check(address, 'ipv6')
}

const LOCAL_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip4-localhost'])

export function isLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (LOCAL_HOSTNAMES.has(lower)) return true
  // mDNS names can only resolve to link-local addresses on this host.
  return lower.endsWith('.local')
}

/* ------------------------------------------------------------ URL guard */

export interface LookupResult {
  address: string
  family: number
}

/** Resolve a hostname to every address; throws a structured error when it
 * is unresolvable or ANY resolved address is blocked. */
export async function assertPublicHost(
  hostname: string,
  lookup: (host: string) => Promise<LookupResult[]>,
): Promise<void> {
  const numeric = looksLikeIpLiteral(hostname)
  if (numeric) {
    if (isBlockedAddress(numeric.address, numeric.family)) {
      throw nativeError('permission_denied', `The URL targets an internal/private address (${numeric.address}) and was refused.`)
    }
    return
  }
  if (isLocalHostname(hostname)) {
    throw nativeError('permission_denied', 'The URL targets a local/internal hostname and was refused.')
  }
  let addresses: LookupResult[]
  try {
    addresses = await lookup(hostname)
  } catch {
    throw nativeError('io_error', 'The URL hostname could not be resolved.')
  }
  if (addresses.length === 0) {
    throw nativeError('io_error', 'The URL hostname could not be resolved.')
  }
  for (const { address, family } of addresses) {
    if (isBlockedAddress(address, family)) {
      throw nativeError('permission_denied', `The URL resolves to an internal/private address (${address}) and was refused.`)
    }
  }
}

/** Detect a literal IPv4 / IPv6 host in a URL host. */
export function looksLikeIpLiteral(host: string): { address: string; family: number } | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const ok = host.split('.').every((octet) => Number(octet) <= 255)
    if (ok) return { address: host, family: 4 }
  }
  // Bracketed IPv6 host nodes carry the brackets (new URL keeps them in `host`).
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  // IPv4-mapped IPv6: ::ffff:a.b.c.d OR ::ffff:xxxx:xxxx (hex)
  const mappedMatch = /^::ffff:((?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-fA-F]{1,4}:){1,2}[0-9a-fA-F]{1,4})$/.exec(bare)
  if (mappedMatch) {
    const mapped = mappedMatch[1]
    if (mapped.includes('.')) {
      const ok = mapped.split('.').every((octet) => Number(octet) <= 255)
      if (ok) return { address: mapped, family: 4 }
    } else {
      // hex form: convert last 4 bytes to dotted decimal
      const parts = mapped.split(':')
      if (parts.length >= 2) {
        const high = parts[parts.length - 2].padStart(4, '0')
        const low = parts[parts.length - 1].padStart(4, '0')
        const b1 = parseInt(high.slice(0, 2), 16)
        const b2 = parseInt(high.slice(2, 4), 16)
        const b3 = parseInt(low.slice(0, 2), 16)
        const b4 = parseInt(low.slice(2, 4), 16)
        if ([b1, b2, b3, b4].every((b) => Number.isFinite(b) && b <= 255)) {
          return { address: `${b1}.${b2}.${b3}.${b4}`, family: 4 }
        }
      }
    }
    return null // malformed mapped
  }
  if (bare.includes(':') && /^[0-9a-fA-F:%.]+$/.test(bare)) return { address: bare, family: 6 }
  return null
}

/** Full SSRF gate for one absolute URL (scheme, credentials, host, port). */
export async function assertPublicHttpUrl(url: string, lookup: (host: string) => Promise<LookupResult[]>): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw nativeError('invalid_argument', 'The URL is malformed.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw nativeError('invalid_argument', 'Only http:// and https:// URLs are supported.')
  }
  if (parsed.username || parsed.password) {
    throw nativeError('invalid_argument', 'URLs with embedded credentials are not allowed.')
  }
  if (!parsed.hostname) {
    throw nativeError('invalid_argument', 'The URL has no host.')
  }
  const port = parsed.port
  if (port && !/^(80|443|8080|8000|3000|4443)$/.test(port)) {
    throw nativeError('invalid_argument', 'The URL port is not on the allowed list.')
  }
  await assertPublicHost(parsed.hostname, lookup)
}

/* ----------------------------------------------------------- html tools */

const entityMap: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  hellip: '…',
  middot: '·',
  ndash: '–',
  mdash: '—',
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  ensp: ' ',
  emsp: ' ',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
}

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return entityMap[entity] ?? match
  })
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

function boundedText(raw: string, maxChars: number): { text: string; truncatedChars: number } {
  if (raw.length <= maxChars) return { text: raw, truncatedChars: 0 }
  return { text: raw.slice(0, maxChars), truncatedChars: raw.length - maxChars }
}

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!match) return undefined
  const title = decodeEntities(stripTags(match[1])).replace(/\s+/g, ' ').trim()
  return title.length > 0 ? boundedText(title, 300).text : undefined
}

/**
 * Deterministic HTML → readable text. Strips scripts/styles/etc, turns block
 * boundaries into newlines, decodes entities, collapses whitespace.
 */
export function extractHtmlText(html: string): string {
  let body = html
  body = body.replace(/<!--[\s\S]*?-->/g, ' ')
  body = body.replace(/<(head|script|style|noscript|template|svg|title)[\s\S]*?<\/\1>/gi, ' ')
  body = body.replace(/<\/?(p|div|li|ul|ol|section|article|aside|header|footer|nav|h[1-6]|table|tr|br|blockquote|pre)([^>]*)>/gi, '\n')
  body = body.replace(/<\/?(tr|td|th)([^>]*)>/gi, '\n')
  body = stripTags(body)
  body = decodeEntities(body)
  return body
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

/** Collect anchors with attributes + inner text (order preserved). */
function collectAnchors(html: string): Array<{ attrs: string; inner: string }> {
  const out: Array<{ attrs: string; inner: string }> = []
  let cursor = 0
  for (;;) {
    const start = html.indexOf('<a', cursor)
    if (start === -1) break
    const tagEnd = html.indexOf('>', start)
    if (tagEnd === -1) break
    const attrs = html.slice(start + 2, tagEnd)
    const close = html.indexOf('</a>', tagEnd)
    const inner = close === -1 ? html.slice(tagEnd + 1) : html.slice(tagEnd + 1, close)
    out.push({ attrs, inner })
    cursor = close === -1 ? html.length : close + 4
  }
  return out
}

function attrValue(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)
  return match ? match[1] : undefined
}

function cleanText(raw: string): string {
  return decodeEntities(stripTags(raw)).replace(/\s+/g, ' ').trim()
}

/** Decode a DDG redirect href (`//duckduckgo.com/l/?uddg=<enc>&rut=...`). */
function decodeDdgUrl(href: string): string | undefined {
  let absolute = href
  if (absolute.startsWith('//')) absolute = `https:${absolute}`
  try {
    const parsed = new URL(absolute)
    if (parsed.hostname === 'duckduckgo.com' && parsed.pathname.startsWith('/l/')) {
      const uddg = parsed.searchParams.get('uddg')
      if (uddg) {
        const decoded = decodeURIComponent(uddg)
        const target = new URL(decoded)
        if (target.protocol === 'http:' || target.protocol === 'https:') return target.toString()
      }
      return undefined
    }
    return parsed.toString()
  } catch {
    return undefined
  }
}

/** Parse a DuckDuckGo HTML results page into wire-safe items. */
export function parseDdgResults(html: string, limit: number): NativeSearchResultItem[] {
  const results: NativeSearchResultItem[] = []
  let pendingUrl: string | undefined
  let pendingTitle: string | undefined
  for (const anchor of collectAnchors(html)) {
    const cls = attrValue(anchor.attrs, 'class') ?? ''
    if (cls.includes('result__a')) {
      const href = attrValue(anchor.attrs, 'href')
      const url = href ? decodeDdgUrl(href) : undefined
      if (!url) continue
      pendingUrl = url
      pendingTitle = cleanText(anchor.inner)
      continue
    }
    if (cls.includes('result__snippet') && pendingUrl) {
      const snippet = cleanText(anchor.inner)
      const title = (pendingTitle ?? '').slice(0, WEB_LIMITS.MAX_RESULT_TITLE_CHARS)
      const pending = pendingUrl
      results.push({ title, url: pending, snippet: snippet.slice(0, WEB_LIMITS.MAX_RESULT_SNIPPET_CHARS) })
      pendingUrl = undefined
      pendingTitle = undefined
      if (results.length >= limit) break
    }
  }
  // A result anchor with no following snippet still counts as a hit.
  if (pendingUrl && results.length < limit) {
    results.push({
      title: (pendingTitle ?? '').slice(0, WEB_LIMITS.MAX_RESULT_TITLE_CHARS),
      url: pendingUrl,
      snippet: '',
    })
  }
  return results
}

/* ------------------------------------------------------ fresh queries */

const FRESHNESS_WORDS =
  /\b(latest|today|current|recent|now|breaking|news|yesterday|tonight|this (week|month|year)|update|2026|20[0-9]{2})\b/i

export function detectFreshnessQuery(query: string): boolean {
  return FRESHNESS_WORDS.test(query)
}

/* ------------------------------------------------------------- backend */

export interface WebBackendOptions {
  /** Injectable fetch (tests). Production uses Node's global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable DNS resolver returning every address (tests). */
  lookupImpl?: (host: string) => Promise<LookupResult[]>
}

export interface WebSearchOptions {
  maxResults?: number
  timeoutMs?: number
}

export interface WebFetchOptions {
  maxBytes?: number
  timeoutMs?: number
}

export type WebDownloadOptions = WebFetchOptions

export interface WebHttpResult {
  status: number
  contentType?: string
  finalUrl: string
  body: Buffer
  truncated: boolean
}

/**
 * The seam the agent talks to. Production wires `RealWebBackend`; tests
 * inject a deterministic one. All bounds and the SSRF gate are enforced here
 * AND again at the broker (defense in depth).
 */
export interface WebBackend {
  readonly id: string
  readonly testsOnly?: boolean
  capabilities(): NativeWebCapabilitiesResult
  search(query: string, options?: WebSearchOptions): Promise<NativeSearchResponse>
  fetchDocument(url: string, options?: WebFetchOptions): Promise<NativeFetchResponse>
  download(url: string, options?: WebDownloadOptions): Promise<NativeDownloadResponse>
}

export class RealWebBackend implements WebBackend {
  readonly id = 'real-public-web'
  private readonly fetchImpl: typeof fetch
  private readonly lookupImpl: (host: string) => Promise<LookupResult[]>

  constructor(options: WebBackendOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : (() => { throw nativeError('io_error', 'Fetch is not available in this runtime.') }) as typeof fetch)
    this.lookupImpl = options.lookupImpl ?? (async (host: string) => dnsLookup(host, { all: true }))
  }

  capabilities(): NativeWebCapabilitiesResult {
    return { search: true, fetch: true, download: true }
  }

  /* ------------------------------------------------------------ http */

  private bounded(ms: number): { controller: AbortController; timer: ReturnType<typeof setTimeout> } {
    const controller = new AbortController()
    const clamped = Math.min(Math.max(Math.floor(ms), 1), WEB_LIMITS.MAX_REQUEST_TIMEOUT_MS)
    const timer = setTimeout(() => controller.abort(), clamped)
    return { controller, timer }
  }

  private async streamBody(response: Response, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
    const reader = response.body?.getReader()
    if (!reader) {
      const array = new Uint8Array(await response.arrayBuffer())
      const truncated = array.byteLength > maxBytes
      return { body: Buffer.from(array.subarray(0, maxBytes)), truncated }
    }
    const chunks: Uint8Array[] = []
    let total = 0
    let truncated = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (total + value.length > maxBytes) {
        const need = Math.max(maxBytes - total, 0)
        if (need > 0) chunks.push(value.subarray(0, need))
        total = maxBytes
        truncated = true
        break
      }
      chunks.push(value)
      total += value.length
    }
    return { body: Buffer.concat(chunks), truncated }
  }

  /** One bounded, redirect-chasing GET. Every hop is SSRF-revalidated. */
  private async httpGet(url: string, options: { timeoutMs: number; maxBytes: number }): Promise<WebHttpResult> {
    const { controller, timer } = this.bounded(options.timeoutMs)
    try {
      await assertPublicHttpUrl(url, this.lookupImpl)
      let current = url
      for (let hop = 0; ; hop += 1) {
        let response: Response
        try {
          response = await this.fetchImpl(current, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: { accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5', 'user-agent': 'Mozilla/5.0 (JARVIS-web-access; personal assistant)' },
          })
        } catch (error) {
          if (controller.signal.aborted) throw nativeError('timeout', 'The web request timed out.')
          throw nativeError('io_error', error instanceof Error ? 'The web request could not be completed.' : 'The web request failed.')
        }
        const status = response.status
        const location = response.headers.get('location')
        if (status >= 300 && status < 400 && location) {
          if (hop >= WEB_LIMITS.MAX_REDIRECTS) {
            throw nativeError('timeout', 'The web request followed too many redirects.')
          }
          let next: URL
          try {
            next = new URL(location, current)
          } catch {
            throw nativeError('invalid_argument', 'A redirect target was malformed.')
          }
          current = next.toString()
          await assertPublicHttpUrl(current, this.lookupImpl)
          continue
        }
        const { body, truncated } = await this.streamBody(response, options.maxBytes)
        return {
          status,
          contentType: response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || undefined,
          finalUrl: current,
          body,
          truncated,
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /* ----------------------------------------------------------- methods */

  async search(query: string, options: WebSearchOptions = {}): Promise<NativeSearchResponse> {
    const maxResults = Math.min(
      Math.max(Number(options.maxResults) || WEB_LIMITS.DEFAULT_SEARCH_RESULTS, 1),
      WEB_LIMITS.MAX_SEARCH_RESULTS,
    )
    const timeoutMs = options.timeoutMs ?? WEB_LIMITS.DEFAULT_REQUEST_TIMEOUT_MS
    const servedAt = Date.now()
    const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    let page: WebHttpResult
    try {
      page = await this.httpGet(endpoint, { timeoutMs, maxBytes: WEB_LIMITS.SEARCH_PAGE_MAX_BYTES })
    } catch (error) {
      if (isNativeError(error)) throw error
      throw nativeError('io_error', 'The search provider could not be reached.')
    }
    if (page.status !== 200) {
      throw nativeError('io_error', `The search provider answered with HTTP ${page.status}.`)
    }
    const html = page.body.toString('utf8')
    const results = parseDdgResults(html, maxResults)
    const freshnessQuery = detectFreshnessQuery(query)
    return {
      query,
      provider: SEARCH_PROVIDER,
      servedAt,
      results,
      freshness: freshnessQuery
        ? {
            detectable: false,
            note: 'The search provider does not expose per-result timestamps. To verify freshness, fetch the primary source page and read its dates.',
          }
        : { detectable: false, note: 'No explicit freshness requirement was detected in the query.' },
    }
  }

  async fetchDocument(url: string, options: WebFetchOptions = {}): Promise<NativeFetchResponse> {
    const maxBytes = Math.min(Math.max(Number(options.maxBytes) || WEB_LIMITS.DEFAULT_FETCH_MAX_BYTES, 1), WEB_LIMITS.MAX_FETCH_MAX_BYTES)
    const timeoutMs = options.timeoutMs ?? WEB_LIMITS.DEFAULT_REQUEST_TIMEOUT_MS
    const page = await this.httpGet(url, { timeoutMs, maxBytes })
    const html = page.body.toString('utf8')
    const isHtml = page.contentType?.startsWith('text/html') === true
    const title = isHtml ? extractTitle(html) : undefined
    const rawText = isHtml ? extractHtmlText(html) : html.trim()
    const { text, truncatedChars } = boundedText(rawText, WEB_LIMITS.MAX_FETCH_TEXT_CHARS)
    return {
      url,
      finalUrl: page.finalUrl,
      status: page.status,
      contentType: page.contentType,
      title,
      text,
      truncatedChars,
      bytes: page.body.length,
      fetchedAt: Date.now(),
    }
  }

  async download(url: string, options: WebDownloadOptions = {}): Promise<NativeDownloadResponse> {
    const maxBytes = Math.min(Math.max(Number(options.maxBytes) || WEB_LIMITS.DEFAULT_DOWNLOAD_MAX_BYTES, 1), WEB_LIMITS.MAX_DOWNLOAD_MAX_BYTES)
    const timeoutMs = options.timeoutMs ?? WEB_LIMITS.DEFAULT_REQUEST_TIMEOUT_MS
    const result = await this.httpGet(url, { timeoutMs, maxBytes })
    if (result.status >= 400) {
      throw nativeError('io_error', `The URL answered with HTTP ${result.status} and was not downloaded.`)
    }
    if (result.truncated) {
      throw nativeError('too_large', 'The download exceeded the size limit and was refused as a bounded download.')
    }
    const contentType = result.contentType
    const textual =
      (contentType ?? '').startsWith('text/') ||
      contentType === 'application/json' ||
      contentType === 'application/xml' ||
      contentType === 'application/xhtml+xml'
    if (!textual) {
      throw nativeError('unsupported', `The URL returned ${contentType ?? 'an unknown content type'}; only text-like documents can be downloaded.`)
    }
    const content = result.body.toString('utf8')
    return {
      url,
      finalUrl: result.finalUrl,
      status: result.status,
      contentType,
      content,
      truncated: false,
      size: content.length,
      fetchedAt: Date.now(),
    }
  }
}