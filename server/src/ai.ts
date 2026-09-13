/**
 * Server-side AI proxy for the JARVIS Core backend (Work 1).
 *
 * The browser can never hold the AI API key (Vite exposes only `VITE_*` env),
 * so in production the client points at a same-origin proxy path
 * (`VITE_JARVIS_AI_PROXY_URL=/api/ai`) and this module forwards the
 * OpenAI-compatible request to the REAL upstream with the key injected
 * server-side. Exactly two allow-listed subpaths are proxied
 * (`/chat/completions` for text, `/embeddings` for semantic memory):
 * no arbitrary URL is ever forwarded.
 *
 * Security invariants:
 *   - the key is read from the server process env and NEVER logged;
 *   - the request body is bounded upstream by the HTTP layer's body limit;
 *   - the upstream call is time-bounded (AbortController);
 *   - bearer-token fencing (JARVIS_BACKEND_TOKEN) applies because the route
 *     lives under `/api/*` in http.ts.
 */

export interface AiProxyOptions {
  /** Upstream OpenAI-compatible base URL (server env `JARVIS_AI_BASE_URL`). */
  baseUrl: string
  /** Server-side API key (`JARVIS_API_KEY`). Optional for keyless upstreams. */
  key: string
  /** Per-request upstream timeout in ms (`JARVIS_AI_TIMEOUT_MS`). */
  timeoutMs: number
}

export type AiProxySubpath = '/chat/completions' | '/embeddings'

export const AI_PROXY_SUBPATHS: readonly AiProxySubpath[] = ['/chat/completions', '/embeddings']

export interface AiProxyResult {
  /** Upstream HTTP status — forwarded verbatim so the client maps it honestly. */
  status: number
  contentType: string
  body: Buffer
}

/**
 * Forward one OpenAI-compatible request upstream. The exact JSON body the
 * client produced is passed through; ONLY the Authorization header is added
 * here (when a key is configured). Throws on network failure / timeout —
 * callers map that to a 502/504 so the client sees an honest error.
 */
export async function proxyAiRequest(
  opts: AiProxyOptions,
  subpath: AiProxySubpath,
  body: Buffer,
): Promise<AiProxyResult> {
  if (!opts.baseUrl || !subpath.startsWith('/')) {
    throw new Error('ai_proxy_misconfigured')
  }
  const target = `${opts.baseUrl.replace(/\/+$/, '')}${subpath}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
      },
      body,
      signal: controller.signal,
    })
    const raw = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get('content-type') ?? 'application/json'
    return { status: res.status, contentType, body: raw }
  } finally {
    clearTimeout(timer)
  }
}