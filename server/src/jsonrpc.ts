/**
 * Minimal JSON-RPC client used ONLY to probe the native agent
 * (Phase 2.8). The browser already speaks the full RPC transport; the
 * backend needs just `system.ping` + `system.identity` for its health
 * endpoint and supervision.
 */

export interface ProbeResult {
  ok: boolean
  connected: boolean
  reachable: boolean
  protocol?: string
  version?: string
  platform?: string
  error?: string
}

export interface ProbeOptions {
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export type RpcResult =
  | { kind: 'response'; envelope: unknown }
  | { kind: 'http_error'; status: number; body: string }

/**
 * POST one JSON-RPC call to the native agent root and read the envelope.
 * Transport failures (host down, refused, DNS, timeout) reject; HTTP-level
 * responses are returned so the probe can classify them honestly.
 */
export async function rpcCall(
  baseUrl: string,
  token: string,
  method: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<RpcResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { kind: 'http_error', status: res.status, body: text.slice(0, 160) }
    }
    return { kind: 'response', envelope: (await res.json()) as unknown }
  } finally {
    clearTimeout(timer)
  }
}

/** Probe the native agent and classify the result honestly. */
export async function probeNativeAgent(
  baseUrl: string,
  token: string,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 4000
  try {
    const result = await rpcCall(baseUrl, token, 'system.identity', fetchImpl, timeoutMs)
    if (result.kind === 'http_error') {
      return {
        ok: false,
        connected: false,
        reachable: true,
        error: `HTTP ${result.status}${result.body ? `: ${result.body}` : ''}`,
      }
    }
    const envelope = result.envelope as {
      result?: { protocol?: string; version?: string; platform?: string; connected?: boolean }
      error?: { code?: string; message?: string }
    }
    const identity = envelope?.result
    if (!identity || identity.connected !== true) {
      return {
        ok: false,
        connected: false,
        reachable: true,
        error: envelope?.error?.message ?? 'Native agent did not report a connected identity.',
      }
    }
    return {
      ok: true,
      connected: true,
      reachable: true,
      protocol: identity.protocol,
      version: identity.version,
      platform: identity.platform,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      connected: false,
      reachable: false,
      error: message || 'native agent unreachable',
    }
  }
}