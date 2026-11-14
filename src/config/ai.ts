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
  /** Providers a REAL probe proved reachable (empty when nothing was probed). */
  healthyProviders?: string[]
  /** Healthy fallback selected for an unpinned request when the primary is down. */
  fallbackProvider?: string
  capabilities?: string[]
  providersProbed?: boolean
  providers?: AiProviderHealthSummary[]
}

/**
 * An injected REAL model-discovery probe. Returns the model ids an upstream
 * engine genuinely listed for this process, or `[]` when nothing could be
 * verified. Callers MUST NOT read `[]` as "zero models" (see checkAiHealth).
 */
export type AiModelDiscoveryProbe = () => Promise<string[]>

export interface AiProviderHealthSummary {
  id: string
  name: string
  enabled: boolean
  configured: boolean
  /** Usable right now: configured, or a real probe found the local models. */
  available: boolean
  capabilities: string[]
  model: string
  status: string
  /** A real probe reached this provider in this process. */
  discovered?: boolean
  /** Models the provider really reports (local engines). */
  models?: string[]
  probedAt?: number
  lastError?: string
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

/**
 * Check upstream AI health and distinguish connection status.
 *
 * @param probeModels optional real model-discovery probe (injected, e.g. from
 *   <code>RemoteProvider.listModels</code>). It is called AT MOST ONCE per
 *   health calculation, and only on the keyless DIRECT transport (a proxy
 *   cannot be enumerated client-side). Honest MODEL_UNAVAILABLE is only ever
 *   emitted when the discoverer positively confirmed the configured model is
 *   absent from a SUCCESSFUL non-empty discovery. An empty result, a rejected
 *   probe, or a proxy are all "not verified" and must never downgrade health.
 */
export async function checkAiHealth(
  probeModels?: AiModelDiscoveryProbe,
  pinnedProvider?: string | null,
): Promise<AiHealthCheckResult> {
  const cfg = getAiConfig()
  if (cfg.transport === 'none' || cfg.providerId === MOCK_PROVIDER_ID) {
    return {
      status: 'MISCONFIGURED',
      code: 'MISCONFIGURED',
      message: 'No real AI endpoint and model are configured.',
    }
  }

  if (cfg.transport === 'direct') {
    return checkDirectAiHealth(cfg, probeModels)
  }

  const healthEndpoint = `${cfg.proxyUrl!.replace(/\/+$/, '')}/health`
  try {
    const res = await fetch(healthEndpoint, { method: 'GET' })
    if (res.ok) {
      const data = (await res.json()) as AiHealthCheckResult
      const refined = await refineWithModelAvailability(data, cfg, probeModels)
      return resolveEffectiveRouterHealth(refined, pinnedProvider)
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

/**
 * Resolve what the browser can really route to. Router `status` describes its
 * configured primary; with automatic routing, a real healthy fallback also
 * means JARVIS can answer. Keep the primary failure in `message` and expose
 * the fallback separately so the UI never claims the primary is healthy.
 */
export function resolveEffectiveRouterHealth(
  result: AiHealthCheckResult,
  pinnedProvider?: string | null,
): AiHealthCheckResult {
  const providers = result.providers ?? []
  const isHealthy = (id: string): AiProviderHealthSummary | undefined => {
    const provider = providers.find((candidate) => candidate.id === id)
    return provider && provider.available && provider.status === 'CONNECTED' && result.healthyProviders?.includes(id)
      ? provider
      : undefined
  }

  if (pinnedProvider) {
    const pinned = isHealthy(pinnedProvider)
    if (pinned) {
      return {
        ...result,
        status: 'CONNECTED',
        code: 'CONNECTED',
        provider: pinned.id,
        model: pinned.model || result.model,
        fallbackProvider: undefined,
        message: result.provider && result.provider !== pinned.id
          ? `Pinned provider ${pinned.name} is reachable.`
          : result.message,
      }
    }
    if (result.provider !== pinnedProvider) {
      const unavailable = providers.find((candidate) => candidate.id === pinnedProvider)
      return {
        ...result,
        status: 'DISCONNECTED',
        code: 'DISCONNECTED',
        provider: pinnedProvider,
        model: unavailable?.model || result.model,
        fallbackProvider: undefined,
        message: unavailable
          ? `Pinned provider ${unavailable.name} is not reachable (${unavailable.status}).`
          : `Pinned provider ${pinnedProvider} health could not be verified.`,
      }
    }
    return result
  }

  const active = (result.provider ? isHealthy(result.provider) : undefined)
    ?? (result.healthyProviders ?? []).map(isHealthy).find((provider) => provider !== undefined)
  if (!active) return result

  const primaryId = result.provider ?? result.primary
  const isFallback = result.status !== 'CONNECTED' && primaryId !== active.id
  const primary = providers.find((provider) => provider.id === primaryId)
  return {
    ...result,
    status: 'CONNECTED',
    code: 'CONNECTED',
    provider: active.id,
    model: active.model || result.model,
    fallbackProvider: isFallback ? active.id : undefined,
    message: isFallback
      ? `Primary ${primary?.name ?? primaryId ?? 'provider'} is unavailable; automatic routing can use ${active.name} (${active.model}) as a fallback.`
      : result.message,
  }
}

/** Check the configured direct provider itself; never route it through JARVIS' dev proxy. */
async function checkDirectAiHealth(
  cfg: AiConfig,
  probeModels?: AiModelDiscoveryProbe,
): Promise<AiHealthCheckResult> {
  if (!cfg.baseUrl || !cfg.model) {
    return { status: 'MISCONFIGURED', code: 'MISCONFIGURED', message: 'A direct AI endpoint and model are required.' }
  }

  const base = cfg.baseUrl.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/i, '')
  const root = base.replace(/\/v\d+$/i, '')
  const urls = [...new Set([`${root}/api/tags`, `${base}/models`])]
  let lastHttpStatus: number | undefined
  let hadTransportFailure = false

  for (const url of urls) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal })
      lastHttpStatus = res.status
      if (res.status === 401 || res.status === 403) {
        return { status: 'AUTHENTICATION_FAILED', code: 'AUTHENTICATION_FAILED', message: `Configured provider rejected the health request (HTTP ${res.status}).`, upstream: cfg.baseUrl }
      }
      if (res.status === 429) {
        return { status: 'RATE_LIMITED', code: 'RATE_LIMITED', message: 'Configured provider is rate-limited.', upstream: cfg.baseUrl }
      }
      if (res.ok) {
        return refineWithModelAvailability({
          status: 'CONNECTED',
          code: 'CONNECTED',
          model: cfg.model,
          upstream: cfg.baseUrl,
        }, cfg, probeModels)
      }
    } catch {
      hadTransportFailure = true
    } finally {
      clearTimeout(timer)
    }
  }

  if (hadTransportFailure && lastHttpStatus === undefined) {
    return { status: 'NETWORK_ERROR', code: 'NETWORK_ERROR', message: 'Cannot reach the configured direct AI provider.', upstream: cfg.baseUrl }
  }
  return {
    status: 'DISCONNECTED',
    code: 'DISCONNECTED',
    message: `Configured provider health routes did not respond successfully${lastHttpStatus ? ` (last HTTP ${lastHttpStatus})` : ''}.`,
    upstream: cfg.baseUrl,
  }
}

/**
 * Refine a reachable health result with real model discovery.
 *
 * Semantics (mirroring RemoteProvider.listModels'):
 *   - probe resolves to `[]`  => discovery NOT verified → keep status.
 *   - probe resolves to a non-empty list that omits the configured model
 *     => confirmed absent → MODEL_UNAVAILABLE.
 *   - probe resolves to a non-empty list that includes the configured model
 *     => confirmed usable → keep status.
 *   - probe rejects            => discovery NOT verified → keep status.
 * As v2 proxies/endpoints stay honest by themselves, only the keyless DIRECT
 * transport may be refined here.
 */
async function refineWithModelAvailability(
  result: AiHealthCheckResult,
  cfg: AiConfig,
  probeModels?: AiModelDiscoveryProbe,
): Promise<AiHealthCheckResult> {
  if (!probeModels) return result
  if (cfg.transport !== 'direct' || !cfg.model) return result
  let models: string[]
  try {
    models = await probeModels()
  } catch {
    return result
  }
  if (models.length === 0) return result
  if (models.includes(cfg.model)) return result
  return { ...result, status: 'MODEL_UNAVAILABLE', code: 'MODEL_UNAVAILABLE' }
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

/**
 * Provider ids the JARVIS AI router can route to (server side). The local
 * engines are pinnable too, so "use Ollama for this task" is a real request the
 * router honors (and honestly refuses when nothing is running).
 */
export const ROUTED_PROVIDER_IDS = ['gemini', 'openai', 'anthropic', 'openrouter', 'local', 'ollama', 'lmstudio', 'llamacpp'] as const
export type RoutedProviderId = (typeof ROUTED_PROVIDER_IDS)[number]
