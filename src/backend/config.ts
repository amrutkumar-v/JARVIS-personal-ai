/**
 * Backend client configuration (Phase 2.8).
 *
 * The persistent JARVIS Core backend runs on the LAN and is discovered from
 * the current page origin: when the app is served by the backend itself
 * (http://<pc>:8787) the same origin is used, otherwise the browser falls back
 * to `VITE_JARVIS_BACKEND_URL` (or `http://<hostname>:8787`).
 */

export interface BackendConfig {
  baseUrl: string
  /** SSE reconnect attempts before giving up (then UI reports disconnected). */
  maxReconnectAttempts: number
  /** Base retry delay in ms before the first reconnect. */
  reconnectBaseMs: number
  /** Mirror throttle for assistant/state posts. */
  mirrorThrottleMs: number
  /**
   * Hard bound on a single HTTP request (ms). A backend that accepts the
   * connection but never answers must not leave a call pending forever.
   */
  requestTimeoutMs?: number
}

function envString(name: string): string | undefined {
  return (import.meta.env as Record<string, string | undefined>)?.[name]
}

function envNumber(name: string, fallback: number): number {
  const raw = envString(name)?.trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readConfig(): BackendConfig {
  const configured = envString('VITE_JARVIS_BACKEND_URL')?.trim()
  const fallbackHost = typeof window !== 'undefined' ? window.location?.hostname || '127.0.0.1' : '127.0.0.1'
  const baseUrl = configured ?? `http://${fallbackHost}:8787`
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    maxReconnectAttempts: envNumber('VITE_JARVIS_BACKEND_MAX_RECONNECT_ATTEMPTS', 6),
    reconnectBaseMs: envNumber('VITE_JARVIS_BACKEND_RECONNECT_BASE_MS', 700),
    mirrorThrottleMs: envNumber('VITE_JARVIS_BACKEND_MIRROR_THROTTLE_MS', 1500),
    requestTimeoutMs: envNumber('VITE_JARVIS_BACKEND_REQUEST_TIMEOUT_MS', 15_000),
  }
}

let cached: BackendConfig | null = null

export function getBackendConfig(): BackendConfig {
  if (!cached) cached = readConfig()
  return cached
}

export function resetBackendConfig(): void {
  cached = null
}
