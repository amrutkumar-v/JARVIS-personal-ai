/**
 * Obtain the backend's HttpOnly browser session before privileged API calls.
 * The session identifier is held only in a SameSite, HttpOnly cookie; no
 * server bearer token or JavaScript-readable secret is sent to the browser.
 */
const sessions = new WeakMap<typeof fetch, Map<string, Promise<void>>>()

/** Hard bound on the session handshake (ms). */
const SESSION_TIMEOUT_MS = 15_000

/**
 * Node-side callers (acceptance tests / headless verification) cannot rely on
 * a browser cookie jar, so the session cookie is captured from the response
 * and replayed explicitly. Browser callers never reach this path.
 */
let nodeSessionCookie: string | null = null

export function getNodeSessionCookie(): string | null {
  return nodeSessionCookie
}

export function setNodeSessionCookie(cookie: string | null): void {
  nodeSessionCookie = cookie
}

export function ensureBackendSession(baseUrl: string, fetchImpl: typeof fetch, timeoutMs = SESSION_TIMEOUT_MS): Promise<void> {
  // Browsers manage this cookie automatically. In Node the explicit helper
  // below is used instead: a fetch here would leak a session attempt into
  // unrelated provider calls and ignore the injected fetch implementation.
  if (typeof window === 'undefined' || typeof window.document === 'undefined') return Promise.resolve()

  let byBase = sessions.get(fetchImpl)
  if (!byBase) {
    byBase = new Map<string, Promise<void>>()
    sessions.set(fetchImpl, byBase)
  }
  const cached = byBase.get(baseUrl)
  if (cached) return cached

  const pending = fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/session`, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    // Without a bound a wedged backend would cache a pending promise
    // FOREVER, and every later call would reuse it.
    signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined,
  }).then((response) => {
    if (!response.ok) throw new Error(`Backend session unavailable (${response.status}).`)
  }).catch((error: unknown) => {
    byBase?.delete(baseUrl)
    throw error
  })
  byBase.set(baseUrl, pending)
  return pending
}

/**
 * Node-only session handshake used by the headless acceptance path.
 * Captures the `jarvis_session` cookie so dev tool calls can authenticate.
 */
export async function ensureNodeBackendSession(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs = SESSION_TIMEOUT_MS,
): Promise<void> {
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') return
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/session`, {
    method: 'GET',
    cache: 'no-store',
    signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined,
  })
  if (!response.ok) throw new Error(`Backend session unavailable (${response.status}).`)
  const setCookie = response.headers?.get?.('set-cookie')
  if (setCookie) {
    const match = setCookie.match(/jarvis_session=[^;]+/)
    if (match) nodeSessionCookie = match[0]
  }
}

export function resetBackendSession(baseUrl: string, fetchImpl: typeof fetch): void {
  sessions.get(fetchImpl)?.delete(baseUrl)
}
