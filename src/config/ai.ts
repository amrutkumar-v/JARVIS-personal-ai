/**
 * AI configuration — read from `VITE_*` environment variables at build time.
 *
 * SECURITY: a real API key NEVER reaches the browser. Vite only exposes
 * `VITE_*`-prefixed variables to `import.meta.env`, so `JARVIS_API_KEY`
 * (from `.env.local`, git-ignored) is only visible to the Vite dev server and
 * the Node backend — never to the browser bundle. The client therefore talks
 * to the AI endpoint either:
 *
 *   - directly, when the endpoint needs no key (keyless local models like
 *     Ollama / LM Studio), or
 *   - through a same-origin proxy (`VITE_JARVIS_AI_PROXY_URL`) where the key
 *     is injected server-side (Vite dev proxy, or the JARVIS Core backend in
 *     production).
 *
 * This module is the single deterministic source of truth for provider
 * selection: `providerId` is 'remote' only when a workable endpoint + model
 * exist, 'mock' otherwise. The dev mock is therefore only ever selected when
 * no real AI configuration is genuinely available.
 */

export type AiTransport = 'proxy' | 'direct' | 'none'

export type AiConnectionStatus =
  | 'CONNECTED'
  | 'MISCONFIGURED'
  | 'AUTHENTICATION_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'DISCONNECTED'

export interface AiHealthCheckResult {
  status: AiConnectionStatus
  code: AiConnectionStatus
  message?: string
  model?: string
  upstream?: string
  /** Router fields (present when the endpoint is the JARVIS AI provider router). */
  provider?: string
  primary?: string
  pinned?: string | null
  configuredProviders?: string[]
  availableProviders?: string[]
  capabilities?: string[]
  providersProbed?: string[]
  providers?: AiProviderHealthSummary[]
}

export interface AiProviderHealthSummary {
  id: string
  name: string
  enabled: boolean
  configured: boolean
  available: boolean
  capabilities: string[]
  model: string
  status: string
}

export interface AiConfig {
  /** Configured provider id ('remote') or 'mock' when none is set up. */
  providerId: string
  /** OpenAI-compatible base URL (no trailing slash normally). Direct mode. */
  baseUrl: string | null
  /** Same-origin proxy path (e.g. '/api/ai'). Proxy mode. */
  proxyUrl: string | null
  /** How the client reaches the endpoint: proxy / direct / none. */
  transport: AiTransport
  model: string | null
  /** Placeholder name for the API key field on import.meta.env. */
  apiKeyEnv: string
  temperature: number
  maxTokens: number
}

function envString(name: string): string | undefined {
  return (import.meta.env as Record<string, string | undefined>)?.[name]
}

function readConfig(): AiConfig {
  const baseUrl = envString('VITE_JARVIS_AI_BASE_URL')?.trim() || null
  const proxyUrl = envString('VITE_JARVIS_AI_PROXY_URL')?.trim() || null
  const model = envString('VITE_JARVIS_AI_MODEL')?.trim() || null
  let temperature = Number(envString('VITE_JARVIS_AI_TEMPERATURE'))
  if (!Number.isFinite(temperature)) temperature = 0.7
  let maxTokens = Number(envString('VITE_JARVIS_AI_MAX_TOKENS'))
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) maxTokens = 2048

  const apiKeyEnv = 'JARVIS_API_KEY'
  const transport: AiTransport = proxyUrl ? 'proxy' : baseUrl ? 'direct' : 'none'
  const configured = transport !== 'none' && Boolean(model)

  return {
    providerId: configured ? 'remote' : 'mock',
    baseUrl,
    proxyUrl,
    transport,
    model,
    apiKeyEnv,
    temperature,
    maxTokens,
  }
}

/** Check upstream AI health and distinguish connection status */
export async function checkAiHealth(): Promise<AiHealthCheckResult> {
  const cfg = getAiConfig()
  const healthEndpoint =
    cfg.transport === 'proxy' && cfg.proxyUrl
      ? `${cfg.proxyUrl.replace(/\/+$/, '')}/health`
      : '/api/ai/health'
  try {
    const res = await fetch(healthEndpoint, { method: 'GET' })
    if (res.ok) {
      const data = (await res.json()) as AiHealthCheckResult
      return data
    }
    return {
      status: 'DISCONNECTED',
      code: 'DISCONNECTED',
      message: `Health check endpoint returned status ${res.status}.`,
    }
  } catch (err: unknown) {
    return {
      status: 'NETWORK_ERROR',
      code: 'NETWORK_ERROR',
      message: err instanceof Error ? err.message : 'Cannot reach AI health endpoint.',
    }
  }
}

/** Cached singleton so providers and UI agree on the same configuration. */
let cached: AiConfig | null = null

export function getAiConfig(): AiConfig {
  if (!cached) cached = readConfig()
  return cached
}

/** Reset the cached config (tests only — must never be called by production). */
export function resetAiConfigCache(): void {
  cached = null
}

/** The placeholder name placed in `.env.example` (never a real key). */
export const REMOTE_PROVIDER_ID = 'remote'
export const MOCK_PROVIDER_ID = 'mock'

/** Provider ids the JARVIS AI router can route to (server side). */
export const ROUTED_PROVIDER_IDS = ['gemini', 'openai', 'anthropic', 'openrouter', 'local'] as const
export type RoutedProviderId = (typeof ROUTED_PROVIDER_IDS)[number]