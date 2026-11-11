/**
 * Obtain the backend's HttpOnly browser session before privileged API calls.
 * The session identifier is held only in a SameSite, HttpOnly cookie; no
 * server bearer token or JavaScript-readable secret is sent to the browser.
 */
const sessions = new WeakMap<typeof fetch, Map<string, Promise<void>>>()

/** Hard bound on the session handshake (ms). */
const SESSION_TIMEOUT_MS = 15_000

export function ensureBackendSession(baseUrl: string, fetchImpl: typeof fetch, timeoutMs = SESSION_TIMEOUT_MS): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()

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

export function resetBackendSession(baseUrl: string, fetchImpl: typeof fetch): void {
  sessions.get(fetchImpl)?.delete(baseUrl)
}
