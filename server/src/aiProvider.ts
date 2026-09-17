/**
 * JARVIS AI Provider Router (multi-provider, self-contained).
 *
 * The client always speaks OpenAI Chat-Completions to the same-origin `/api/ai`
 * proxy, so the agent engine stays decoupled from any single AI vendor. This
 * module turns that proxy into a real ROUTER:
 *
 *   - discovers and enables providers from server env only (keys never leave
 *     the server);
 *   - routes each request to the configured primary provider;
 *   - fails over to explicitly configured fallbacks ONLY on retryable
 *     failures (5xx, 429, network, timeout) — auth (401/403) and invalid
 *     request (400) errors are reported immediately, never retried;
 *   - NEVER silently switches when a provider is pinned (client
 *     `x-jarvis-provider` header or server `JARVIS_AI_PINNED_PROVIDER`);
 *   - routes by capability: `/chat/completions` bodies with image content go
 *     to vision-capable providers, `/embeddings` to embedding-capable
 *     providers (Anthropic has no embeddings API and is truthfully excluded);
 *   - translates Claude (Anthropic Messages API) into the OpenAI-compatible
 *     envelope the engine expects;
 *   - returns a rich, secret-free `/health` report.
 *
 * SELF-CONTAINED: no relative imports and no `node:*` imports, so the exact
 * same module is loaded by the production backend (`server/src/http.ts`,
 * compiled `./aiProvider.js`) and by the Vite dev proxy
 * (`vite.config.ts`, imported as `./server/src/aiProvider.ts`).
 *
 * Security invariants:
 *   - API keys are read from env and never included in any response, log or
 *     health report;
 *   - only two allow-listed subpaths are ever routed;
 *   - every upstream call is time-bounded (AbortController);
 *   - failure classification is conservative: never retry auth or 400.
 */

export type AiCapability = 'reasoning' | 'vision' | 'embeddings'

export type ProviderId = 'gemini' | 'openai' | 'anthropic' | 'openrouter' | 'local' | 'ollama' | 'lmstudio'

export type AiTransportId = ProviderId | 'legacy'

/** Client-compatible connection status (the overall /health status). */
export type AiConnectionStatus =
  | 'CONNECTED'
  | 'MISCONFIGURED'
  | 'AUTHENTICATION_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'DISCONNECTED'

/**
 * Per-provider health vocabulary (config + probe derived).
 *
 * Truthful by construction: `CONNECTED` is only ever reported after a REAL
 * upstream call (chat ping or model discovery) succeeded in this process.
 * `CONFIGURED` means "settings look complete but nothing has been verified" —
 * never a claim of reachability. `KEY_REQUIRED` means the provider needs a
 * credential that is not set, so the operator knows exactly what to add.
 */
export type AiProviderHealthStatus =
  | 'CONNECTED'
  | 'CONFIGURED'
  | 'KEY_REQUIRED'
  | 'DISABLED'
  | 'MISCONFIGURED'
  | 'UNAVAILABLE'
  | 'DEGRADED'
  | 'NOT_CONFIGURED'
  | 'MODEL_UNAVAILABLE'

/**
 * Primary selection: a named provider, `auto` (health-aware routing across all
 * usable providers) or `none` (nothing configured).
 */
export type AiPrimarySelection = AiTransportId | 'none' | 'auto'

/** Resolved provider registry snapshot (internal + public `registry()`). */
export interface AiRegistrySnapshot {
  explicitMode: boolean
  primary: AiPrimarySelection
  fallbacks: AiTransportId[]
  /** Providers explicitly disabled via `JARVIS_AI_DISABLED_PROVIDERS`. */
  disabled: AiTransportId[]
  pinned: AiTransportId | null
  providers: AiProviderDefinition[]
}

export type AiRouteErrorCode =
  | 'ai_not_configured'
  | 'provider_not_configured'
  | 'unsupported_capability'
  | 'ai_upstream_unreachable'
  | 'ai_upstream_timeout'
  | 'ai_upstream_rate_limited'
  | 'ai_upstream_error'
  | 'model_unavailable'
  | 'invalid_body'

export interface AiProviderDefinition {
  id: AiTransportId
  name: string
  /** Resolved upstream base URL. Empty when the provider cannot be enabled. */
  baseUrl: string
  /** Server-side key (may be empty for keyless local endpoints). */
  key: string
  /** Env var name that supplies the key (never printed). */
  apiKeyEnv: string
  /** Default chat model; '' means 'forward the request model' (legacy). */
  chatModel: string
  /** Default vision model; '' when the provider has no vision capability. */
  visionModel: string
  /** Default embedding model; '' when the provider has no embeddings API. */
  embeddingModel: string
  capabilities: AiCapability[]
  timeoutMs: number
  enabled: boolean
}

export interface AiProxyConfig {
  baseUrl: string
  key: string
  timeoutMs: number
}

export interface AiRouterCreateOptions {
  /** Env map to read provider settings from (defaults to `process.env`). */
  env?: Record<string, string | undefined>
  /** Legacy single-upstream override (the backend `options.ai`). */
  legacy?: AiProxyConfig
  /** Test seam — defaults to the current global fetch at call time. */
  fetchImpl?: typeof fetch
  now?: () => number
  /** Health probe cache TTL. Default 15000ms. */
  probeTtlMs?: number
  /** Disable live probing (health reported from config only). */
  probeHealth?: boolean
  /**
   * Extra attempts after a transient NETWORK failure on the SAME provider.
   * Default 1. Set 0 to disable. Business (400/401/403), rate-limit, upstream
   * 5xx and timeout outcomes are never retried by this mechanism.
   */
  transientRetryAttempts?: number
  /** Backoff between transient network retries, in ms. Default 200. */
  transientRetryDelayMs?: number
  /** Test seam for the transient retry backoff (defaults to a real timer). */
  sleep?: (ms: number) => Promise<void>
}

export interface AiRouter {
  /**
   * Route one OpenAI-compatible request body to a provider.
   * Only `/chat/completions` and `/embeddings` are valid subpaths.
   */
  route(req: AiRouteRequest): Promise<AiRouteResult>
  /** Rich, secret-free provider health report (keeps `status`/`code`/etc). */
  getHealth(): Promise<AiHealthReport>
  /** Snapshot of the generated provider registry (tests/UI). */
  registry(): AiProviderRegistrySnapshot
}

export interface AiRouteRequest {
  subpath: '/chat/completions' | '/embeddings'
  body: Uint8Array
  /** Pinned provider id (client `x-jarvis-provider` header or server pin). */
  pinned?: string | null
}

export interface AiRouteResult {
  /** HTTP status to return to the client. */
  status: number
  contentType: string
  body: Uint8Array
  /** Provider that actually served this request. */
  provider: AiTransportId | 'none'
  /** Effective model used; '' when the request model was passed through. */
  model: string
  capability: AiCapability | 'unknown'
  usedFallback: boolean
  errorCode?: AiRouteErrorCode
  errorMessage?: string
}

export interface AiProviderHealthEntry {
  id: AiTransportId
  name: string
  enabled: boolean
  configured: boolean
  available: boolean
  capabilities: AiCapability[]
  model: string
  status: AiProviderHealthStatus
  /**
   * Discovery-driven availability: a REAL endpoint probe (model listing or a
   * chat ping) proved this provider reachable in this process. `false` means
   * unverified, never "probably fine".
   */
  discovered?: boolean
  /** Discovered local models (ollama/lmstudio/local, when discovery succeeded). */
  models?: string[]
  /** When the provider was last probed (ms epoch, 0 = never). */
  probedAt?: number
  lastError?: string
}

export interface AiHealthReport {
  status: AiConnectionStatus
  code: AiConnectionStatus
  message?: string
  model?: string
  upstream?: string
  /** Active provider (the one that would serve a request). */
  provider: AiTransportId | 'none'
  primary: AiPrimarySelection
  pinned: AiTransportId | null
  configuredProviders: AiTransportId[]
  /** Configured providers that ALSO advertise the required capability. */
  availableProviders: AiTransportId[]
  /** Providers a real probe proved reachable (empty when nothing was probed). */
  healthyProviders: AiTransportId[]
  capabilities: AiCapability[]
  providersProbed: boolean
  providers: AiProviderHealthEntry[]
}

export type AiProviderRegistrySnapshot = AiRegistrySnapshot

const PROVIDER_IDS: readonly ProviderId[] = ['gemini', 'openai', 'anthropic', 'openrouter', 'local', 'ollama', 'lmstudio']

const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai'
const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1'
const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com/v1'
const DEFAULT_OPENROUTER_BASE = 'https://openrouter.ai/api/v1'
/**
 * Ollama's OpenAI-compatible API lives under `/v1` (its native API is `/api/*`).
 * Pointing the OpenAI client at the bare host returns "404 page not found", so
 * `/v1` is ensured here and stripped again for native discovery calls.
 */
const DEFAULT_OLLAMA_BASE = 'http://localhost:11434/v1'

function normalizeOllamaBase(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (!base) return base
  return /\/v\d+$/.test(base) ? base : `${base}/v1`
}
const DEFAULT_LMSTUDIO_BASE = 'http://localhost:1234/v1'

/** Max locally-discovered models kept in a health report (bounded payload). */
const MAX_DISCOVERED_MODELS = 50
/** Parallel provider probes per health report (keeps /api/ai/health snappy). */
const PROBE_CONCURRENCY = 4

const DEFAULT_CHAT_TIMEOUT_MS = 45_000
/**
 * Local engines load the model ON the request, so the first call to a cold
 * Ollama/LM Studio can take minutes. A hosted-provider timeout would report a
 * perfectly healthy local model as "timed out"; this budget is the honest one
 * for that regime (and every local provider still accepts its own
 * `<PROVIDER>_AI_TIMEOUT_MS` override).
 */
const LOCAL_CHAT_TIMEOUT_MS = 180_000
const DEFAULT_EMBED_TIMEOUT_MS = 60_000
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000
/**
 * Extra attempts after a TRANSIENT NETWORK failure on the SAME provider.
 *
 * A single dropped/reset socket (common with HTTP keep-alive pools and flaky
 * links) must not surface as a hard `502 ai_upstream_unreachable` when only one
 * provider is configured. The request body is a replayable byte array, so a
 * fresh attempt simply opens a new connection.
 */
const DEFAULT_TRANSIENT_RETRY_ATTEMPTS = 1
/** Backoff before a transient network retry (ms). Deliberately tiny: this
 *  recovers a released socket, it is not a rate-limit backoff. */
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 200
/**
 * Health-probe budget PER ATTEMPT.
 *
 * A verification issue, not a tuning guess: a measured COLD TLS handshake to
 * the Gemini endpoint took ~6.5-10.4s on a real Windows box (warm calls take
 * 0.3-2s), so the previous 6s budget aborted perfectly healthy-but-cold
 * connections and `/api/ai/health` reported a FALSE `NETWORK_ERROR` — making a
 * working AI layer look broken. This budget sits above observed cold-connect
 * latency; warm calls are unaffected because the probe returns as soon as the
 * upstream answers.
 */

const ANTHROPIC_VERSION = '2023-06-01'

type AnyRecord = Record<string, unknown>

function envString(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
}

function envInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const value = Number(env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function toText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function jsonBytes(value: unknown): Uint8Array {
  return toBytes(JSON.stringify(value))
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value)
}

/* ------------------------------ env → registry ---------------------------- */

function buildProvider(
  id: ProviderId,
  env: Record<string, string | undefined>,
  defaults: {
    baseUrl: string
    chatModel: string
    visionModel: string
    embeddingModel: string
    keyEnv: string
    baseUrlEnv: string
    chatEnv: string
    visionEnv?: string
    embeddingEnv?: string
    timeoutEnv: string
    requiresKey: boolean
    keylessBase?: string
    keylessChat?: string
  },
): AiProviderDefinition {
  const rawBaseUrl = envString(env, defaults.baseUrlEnv) || defaults.baseUrl
  const baseUrl = id === 'ollama' ? normalizeOllamaBase(rawBaseUrl) : rawBaseUrl
  const chatModel = envString(env, defaults.chatEnv) || defaults.chatModel
  const visionModel =
    envString(env, defaults.visionEnv ?? '') ||
    (defaults.visionModel ? defaults.visionModel : chatModel)
  const embeddingModel = envString(env, defaults.embeddingEnv ?? '') || defaults.embeddingModel
  const key = envString(env, defaults.keyEnv)
  const configuredTimeoutMs = envInt(env, defaults.timeoutEnv, 0)
  const isLocalEngine = id === 'local' || id === 'ollama' || id === 'lmstudio'
  const timeoutMs = configuredTimeoutMs || (isLocalEngine ? LOCAL_CHAT_TIMEOUT_MS : DEFAULT_CHAT_TIMEOUT_MS)

  let enabled = false
  if (id === 'local' || id === 'ollama' || id === 'lmstudio') {
    // Keyless local endpoints: enabled only when a base URL AND a chat model are
    // explicitly configured (never guessed — a defaulted localhost base URL on
    // its own is not evidence that the local engine is installed or running,
    // so it must never flip the provider to CONNECTED without a real probe).
    enabled = Boolean(baseUrl && chatModel && envString(env, defaults.baseUrlEnv) && envString(env, defaults.chatEnv))
    void defaults.requiresKey
  } else {
    enabled = Boolean(baseUrl && key)
  }

  const capabilities: AiCapability[] = ['reasoning']
  if (id !== 'anthropic') capabilities.push('vision')
  if (id === 'gemini' || id === 'openai' || id === 'local' || id === 'ollama' || id === 'lmstudio') {
    if (id === 'gemini' || id === 'openai' ? true : Boolean(embeddingModel)) capabilities.push('embeddings')
  }

  return {
    id,
    name: names[id],
    baseUrl,
    key,
    apiKeyEnv: defaults.keyEnv,
    chatModel,
    visionModel,
    embeddingModel,
    capabilities,
    timeoutMs,
    enabled,
  }
}

const names: Record<ProviderId, string> = {
  gemini: 'Gemini (Google)',
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  openrouter: 'OpenRouter',
  local: 'Local (Ollama / LM Studio)',
  ollama: 'Ollama (local)',
  lmstudio: 'LM Studio (local)',
}

function buildProviders(env: Record<string, string | undefined>, legacy?: AiProxyConfig): AiProviderDefinition[] {
  const explicitMode = envString(env, 'JARVIS_AI_PRIMARY_PROVIDER') !== ''

  if (!explicitMode) {
    // --- legacy single-provider mode (fully backward compatible) ---
    const baseUrl =
      legacy?.baseUrl?.trim() ||
      (envString(env, 'GEMINI_API_KEY') ? DEFAULT_GEMINI_BASE : '')
    const key =
      legacy?.key?.trim() ||
      envString(env, 'GEMINI_API_KEY') ||
      envString(env, 'JARVIS_API_KEY') ||
      envString(env, 'OPENAI_API_KEY')
    const timeoutMs = legacy?.timeoutMs || envInt(env, 'JARVIS_AI_TIMEOUT_MS', DEFAULT_CHAT_TIMEOUT_MS)
    const enabled = Boolean(baseUrl && key)
    const provider: AiProviderDefinition = {
      id: 'legacy',
      name: 'Configured OpenAI-compatible',
      baseUrl,
      key,
      apiKeyEnv: legacy ? 'JARVIS_API_KEY' : 'GEMINI_API_KEY',
      // '' means "forward the request model" — legacy endpoints stay honest
      // passthrough.
      chatModel: '',
      visionModel: '',
      embeddingModel: '',
      capabilities: ['reasoning', 'vision', 'embeddings'],
      timeoutMs,
      enabled,
    }
    return [provider]
  }

  // --- explicit provider-router mode ---
  return PROVIDER_IDS.map((id): AiProviderDefinition => {
    switch (id) {
      case 'gemini':
        return buildProvider('gemini', env, {
          baseUrl: DEFAULT_GEMINI_BASE,
          chatModel: 'gemini-3.6-flash',
          visionModel: 'gemini-3.6-flash',
          embeddingModel: envString(env, 'GEMINI_EMBEDDING_MODEL') || 'gemini-embedding-2-preview',
          keyEnv: 'GEMINI_API_KEY',
          baseUrlEnv: 'GEMINI_AI_BASE_URL',
          chatEnv: 'GEMINI_AI_MODEL',
          visionEnv: 'GEMINI_VISION_MODEL',
          embeddingEnv: 'GEMINI_EMBEDDING_MODEL',
          timeoutEnv: 'GEMINI_AI_TIMEOUT_MS',
          requiresKey: true,
        })
      case 'openai':
        return buildProvider('openai', env, {
          baseUrl: DEFAULT_OPENAI_BASE,
          chatModel: 'gpt-4o-mini',
          visionModel: 'gpt-4o-mini',
          embeddingModel: 'text-embedding-3-small',
          keyEnv: 'OPENAI_API_KEY',
          baseUrlEnv: 'OPENAI_BASE_URL',
          chatEnv: 'OPENAI_AI_MODEL',
          visionEnv: 'OPENAI_VISION_MODEL',
          embeddingEnv: 'OPENAI_EMBEDDING_MODEL',
          timeoutEnv: 'OPENAI_AI_TIMEOUT_MS',
          requiresKey: true,
        })
      case 'anthropic':
        return buildProvider('anthropic', env, {
          baseUrl: DEFAULT_ANTHROPIC_BASE,
          chatModel: 'claude-sonnet-4-5',
          visionModel: 'claude-sonnet-4-5',
          embeddingModel: '', // Anthropic has no embeddings API (truthful).
          keyEnv: 'ANTHROPIC_API_KEY',
          baseUrlEnv: 'ANTHROPIC_BASE_URL',
          chatEnv: 'ANTHROPIC_AI_MODEL',
          visionEnv: 'ANTHROPIC_VISION_MODEL',
          timeoutEnv: 'ANTHROPIC_AI_TIMEOUT_MS',
          requiresKey: true,
        })
      case 'openrouter':
        return buildProvider('openrouter', env, {
          baseUrl: DEFAULT_OPENROUTER_BASE,
          chatModel: 'openai/gpt-4o-mini',
          visionModel: 'openai/gpt-4o-mini',
          embeddingModel: '', // OpenRouter exposes no stable embeddings endpoint.
          keyEnv: 'OPENROUTER_API_KEY',
          baseUrlEnv: 'OPENROUTER_BASE_URL',
          chatEnv: 'OPENROUTER_AI_MODEL',
          visionEnv: 'OPENROUTER_VISION_MODEL',
          timeoutEnv: 'OPENROUTER_AI_TIMEOUT_MS',
          requiresKey: true,
        })
      case 'local':
        return buildProvider('local', env, {
          baseUrl: '',
          chatModel: '',
          visionModel: '',
          embeddingModel: '',
          keyEnv: 'JARVIS_LOCAL_AI_KEY',
          baseUrlEnv: 'JARVIS_LOCAL_AI_BASE_URL',
          chatEnv: 'JARVIS_LOCAL_AI_MODEL',
          visionEnv: 'JARVIS_LOCAL_AI_VISION_MODEL',
          embeddingEnv: 'JARVIS_LOCAL_AI_EMBEDDING_MODEL',
          timeoutEnv: 'JARVIS_LOCAL_AI_TIMEOUT_MS',
          requiresKey: false,
        })
      case 'ollama':
        return buildProvider('ollama', env, {
          baseUrl: DEFAULT_OLLAMA_BASE,
          chatModel: '',
          visionModel: '',
          embeddingModel: '',
          keyEnv: '',
          baseUrlEnv: 'OLLAMA_BASE_URL',
          chatEnv: 'OLLAMA_AI_MODEL',
          visionEnv: 'OLLAMA_VISION_MODEL',
          embeddingEnv: 'OLLAMA_EMBEDDING_MODEL',
          timeoutEnv: 'OLLAMA_AI_TIMEOUT_MS',
          requiresKey: false,
        })
      case 'lmstudio':
        return buildProvider('lmstudio', env, {
          baseUrl: DEFAULT_LMSTUDIO_BASE,
          chatModel: '',
          visionModel: '',
          embeddingModel: '',
          keyEnv: '',
          baseUrlEnv: 'LMSTUDIO_BASE_URL',
          chatEnv: 'LMSTUDIO_AI_MODEL',
          visionEnv: 'LMSTUDIO_VISION_MODEL',
          embeddingEnv: 'LMSTUDIO_EMBEDDING_MODEL',
          timeoutEnv: 'LMSTUDIO_AI_TIMEOUT_MS',
          requiresKey: false,
        })
    }
  })
}

/**
 * Parse `JARVIS_AI_DISABLED_PROVIDERS` (comma separated ids). A disabled
 * provider is never routed to and is reported as DISABLED — the operator's
 * intent stays visible instead of looking like a configuration mistake.
 */
function resolveDisabledProviders(env: Record<string, string | undefined>): AiTransportId[] {
  const raw = envString(env, 'JARVIS_AI_DISABLED_PROVIDERS')
  if (!raw) return []
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(isProviderId))]
}

function resolveRegistry(env: Record<string, string | undefined>, legacy?: AiProxyConfig): AiRegistrySnapshot {
  const disabled = resolveDisabledProviders(env)
  const providers = buildProviders(env, legacy).map((p) =>
    disabled.includes(p.id) ? { ...p, enabled: false } : p,
  )
  const explicitMode = envString(env, 'JARVIS_AI_PRIMARY_PROVIDER') !== ''

  let primary: AiPrimarySelection = 'none'
  let fallbacks: AiTransportId[] = []
  let pinned: AiTransportId | null = null

  if (!explicitMode) {
    primary = providers.some((p) => p.id === 'legacy' && p.enabled) ? 'legacy' : 'none'
  } else {
    const primaryRaw = envString(env, 'JARVIS_AI_PRIMARY_PROVIDER')
    // `auto` is a first-class selection: route across every usable provider and
    // order candidates by REAL observed health (see `routingCandidates`).
    if (primaryRaw === 'auto') primary = 'auto'
    else if (isProviderId(primaryRaw)) primary = primaryRaw
    fallbacks = envString(env, 'JARVIS_AI_FALLBACK_PROVIDERS')
      .split(',')
      .map((s) => s.trim())
      .filter(isProviderId)
  }

  const serverPin = envString(env, 'JARVIS_AI_PINNED_PROVIDER')
  if (isProviderId(serverPin)) pinned = serverPin
  else if (serverPin === 'legacy') pinned = 'legacy'

  return { explicitMode, primary, fallbacks, disabled, pinned, providers }
}

function findProvider(providers: AiProviderDefinition[], id: AiTransportId): AiProviderDefinition | undefined {
  return providers.find((p) => p.id === id)
}

/**
 * Per-provider observations from REAL traffic: model discovery, health probes
 * and the outcome of every routed request. Health-aware `auto` routing reads
 * these, so a provider that just failed is tried LAST on the next request
 * instead of first — and a provider is never reported CONNECTED without a
 * successful call in this process.
 */
interface ProbeRecord {
  at: number
  status: AiProviderHealthStatus
  connection: AiConnectionStatus
  /** A real probe proved this provider reachable. */
  discovered: boolean
  models?: string[]
  lastError?: string
}

/**
 * Ordered routing candidates honoring primary → fallbacks → remaining.
 *
 * `isUsable` decides candidacy: `enabled` (config-complete) by default, and in
 * the router a provider whose models were really discovered counts too — a
 * running Ollama is a usable provider even with no chat model pinned in env.
 */
function orderedCandidates(
  registry: AiRegistrySnapshot,
  isUsable: (provider: AiProviderDefinition) => boolean = (p) => p.enabled,
): AiProviderDefinition[] {
  if (!registry.explicitMode) {
    return registry.providers.filter((p) => p.id === 'legacy' && p.enabled)
  }
  const order: AiTransportId[] = []
  const push = (id: AiTransportId): void => {
    if (!order.includes(id)) order.push(id)
  }
  // `auto` contributes no fixed head — fallbacks first, then every remaining
  // usable provider (the health-aware ordering happens in `routingCandidates`).
  if (registry.primary !== 'none' && registry.primary !== 'auto') push(registry.primary)
  for (const id of registry.fallbacks) push(id)
  for (const p of registry.providers) if (isUsable(p)) push(p.id)
  return order.map((id) => findProvider(registry.providers, id)).filter((p): p is AiProviderDefinition => p !== undefined && isUsable(p))
}

function capabilityOfProvider(provider: AiProviderDefinition, capability: AiCapability): boolean {
  return provider.capabilities.includes(capability)
}

function modelFor(provider: AiProviderDefinition, capability: AiCapability): string {
  if (capability === 'vision' && provider.visionModel) return provider.visionModel
  if (capability === 'embeddings') return provider.embeddingModel
  return provider.chatModel
}

/* ------------------------------ body helpers ------------------------------ */

function parseBody(body: Uint8Array): { ok: true; value: AnyRecord } | { ok: false } {
  const text = toText(body)
  if (!text.trim()) return { ok: true, value: {} }
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as AnyRecord }
    }
    return { ok: false }
  } catch {
    return { ok: false }
  }
}

export function hasImageContent(body: AnyRecord): boolean {
  const messages = body.messages
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    const content = (message as AnyRecord)?.content
    if (Array.isArray(content)) {
      for (const part of content) {
        if ((part as AnyRecord)?.type === 'image_url') return true
      }
    }
  }
  return false
}

function detectCapability(subpath: '/chat/completions' | '/embeddings', body: AnyRecord): AiCapability {
  if (subpath === '/embeddings') return 'embeddings'
  return hasImageContent(body) ? 'vision' : 'reasoning'
}

/* ------------------------- Anthropic ↔ OpenAI bridge ---------------------- */

interface AnthropicToolUseBlock extends AnyRecord {
  id: string
  name: string
  input: AnyRecord
}

function toDataUrlMediaType(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,/.exec(url)
  if (!match) return null
  return { mediaType: match[1]!, data: url.slice(match[0].length) }
}

function openAiContentToAnthropic(content: unknown): AnyRecord[] {
  if (typeof content === 'string') {
    return content.trim().length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: AnyRecord[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as AnyRecord
    if (p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0) {
      blocks.push({ type: 'text', text: p.text })
      continue
    }
    if (p.type === 'image_url') {
      const url = (p.image_url as AnyRecord | undefined)?.url
      if (typeof url === 'string') {
        const decoded = toDataUrlMediaType(url)
        if (decoded) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: decoded.mediaType, data: decoded.data } })
        }
      }
      continue
    }
  }
  return blocks
}

/** Translate an OpenAI chat-completions body to the Anthropic Messages payload. */
export function openAiChatToAnthropic(body: AnyRecord, model: string): AnyRecord {
  const rawMessages = body.messages
  const messages: AnyRecord[] = Array.isArray(rawMessages) ? (rawMessages as AnyRecord[]) : []

  const system: string[] = []
  const anthropicMessages: AnyRecord[] = []
  let pendingToolResults: AnyRecord[] = []

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return
    anthropicMessages.push({ role: 'user', content: pendingToolResults })
    pendingToolResults = []
  }

  const pushUserMerge = (blocks: AnyRecord[]): void => {
    const last = anthropicMessages[anthropicMessages.length - 1]
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      ;(last.content as AnyRecord[]).push(...blocks)
      return
    }
    anthropicMessages.push({ role: 'user', content: blocks })
  }

  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as AnyRecord
    const role = typeof m.role === 'string' ? m.role : ''
    if (role === 'system') {
      if (typeof m.content === 'string' && m.content.trim().length > 0) system.push(m.content.trim())
      continue
    }
    if (role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: typeof m.tool_call_id === 'string' ? m.tool_call_id : '',
        content: typeof m.content === 'string' ? m.content : '',
      })
      continue
    }
    flushToolResults()
    if (role === 'user') {
      const blocks = openAiContentToAnthropic(m.content)
      if (blocks.length > 0) pushUserMerge(blocks)
      continue
    }
    if (role === 'assistant') {
      const blocks = openAiContentToAnthropic(m.content)
      const toolCalls = Array.isArray(m.tool_calls) ? (m.tool_calls as AnyRecord[]) : []
      for (const tc of toolCalls) {
        const fn = (tc.function as AnyRecord | undefined) ?? {}
        let input: AnyRecord = {}
        if (typeof fn.arguments === 'string' && fn.arguments.trim().length > 0) {
          try {
            const parsed = JSON.parse(fn.arguments) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as AnyRecord
          } catch {
            input = {}
          }
        }
        const block: AnthropicToolUseBlock = {
          type: 'tool_use',
          id: typeof tc.id === 'string' && tc.id ? tc.id : `toolu_${Date.now().toString(36)}`,
          name: typeof fn.name === 'string' ? fn.name : '',
          input,
        }
        if (block.name) blocks.push(block)
      }
      if (blocks.length === 0) continue
      anthropicMessages.push({ role: 'assistant', content: blocks })
    }
  }
  flushToolResults()

  const payload: AnyRecord = {
    model,
    max_tokens: typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : 2048,
    messages: anthropicMessages,
  }
  if (system.length > 0) payload.system = system.join('\n')
  if (typeof body.temperature === 'number') payload.temperature = body.temperature
  if (typeof body.top_p === 'number') payload.top_p = body.top_p
  if (Array.isArray(body.tools) && (body.tools as AnyRecord[]).length > 0) {
    const tools: AnyRecord[] = []
    for (const toolDef of body.tools as AnyRecord[]) {
      const fn = (toolDef.function as AnyRecord | undefined) ?? {}
      if (typeof fn.name !== 'string' || !fn.name) continue
      tools.push({
        name: fn.name,
        description: typeof fn.description === 'string' && fn.description ? fn.description : '',
        input_schema:
          fn.parameters && typeof fn.parameters === 'object' ? (fn.parameters as AnyRecord) : { type: 'object', properties: {} },
      })
    }
    if (tools.length > 0) {
      payload.tools = tools
      payload.tool_choice = { type: 'auto' }
    }
  }
  return payload
}

/** Translate an Anthropic Messages response into the OpenAI-compatible envelope. */
export function anthropicMessagesToOpenAi(response: unknown, requestModel: string, nowMs: number): AnyRecord {
  const data = (response && typeof response === 'object' ? (response as AnyRecord) : {}) as AnyRecord
  const content = Array.isArray(data.content) ? (data.content as AnyRecord[]) : []
  let text = ''
  const toolCalls: AnyRecord[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') text += block.text
    else if (block.type === 'tool_use' && typeof block.name === 'string') {
      toolCalls.push({
        id: typeof block.id === 'string' && block.id ? block.id : `toolu_${Date.now().toString(36)}`,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      })
    }
  }
  const stopReason = typeof data.stop_reason === 'string' && data.stop_reason === 'tool_use' ? 'tool_calls' : 'stop'
  const usage = (data.usage && typeof data.usage === 'object' ? (data.usage as AnyRecord) : {}) as AnyRecord
  const promptTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
  const completionTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2, 12)}`,
    object: 'chat.completion',
    created: Math.floor(nowMs / 1000),
    model: requestModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
        logprobs: null,
        finish_reason: stopReason,
      },
    ],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  }
}

/* ------------------------------- upstream call ---------------------------- */

export type AttemptOutcome =
  | { kind: 'ok'; status: number; contentType: string; body: Uint8Array }
  | { kind: 'business'; status: number; contentType: string; body: Uint8Array }
  | { kind: 'rate_limit' }
  | { kind: 'server'; status: number }
  | { kind: 'timeout' }
  | { kind: 'network' }

interface CallTarget {
  endpoint: string
  headers: Record<string, string>
  payload: Uint8Array
}

function callTargetFor(
  provider: AiProviderDefinition,
  subpath: '/chat/completions' | '/embeddings',
  rawBody: Uint8Array,
  modelOverride: string,
): CallTarget {
  const base = provider.baseUrl.replace(/\/+$/, '')

  if (provider.id === 'anthropic' && subpath === '/chat/completions') {
    const parsed = parseBody(rawBody)
    const payload = parsed.ok ? openAiChatToAnthropic(parsed.value, modelOverride) : openAiChatToAnthropic({}, modelOverride)
    return {
      endpoint: `${base}/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': provider.key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      payload: jsonBytes(payload),
    }
  }

  const suffix = subpath === '/embeddings' ? '/embeddings' : '/chat/completions'
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (provider.key) headers.authorization = `Bearer ${provider.key}`

  // For named providers the router overrides the model server-side so a
  // provider CANNOT receive another provider's model id. Legacy keeps the
  // request model (bedrock honesty: the exact body the client produced).
  if (modelOverride) {
    const parsed = parseBody(rawBody)
    if (parsed.ok) {
      return { endpoint: `${base}${suffix}`, headers, payload: jsonBytes({ ...parsed.value, model: modelOverride }) }
    }
    return { endpoint: `${base}${suffix}`, headers, payload: rawBody }
  }

  return { endpoint: `${base}${suffix}`, headers, payload: rawBody }
}

async function attemptCall(
  provider: AiProviderDefinition,
  subpath: '/chat/completions' | '/embeddings',
  rawBody: Uint8Array,
  modelOverride: string,
  fetchImpl: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>,
  overrideTimeoutMs?: number,
): Promise<AttemptOutcome> {
  const target = callTargetFor(provider, subpath, rawBody, modelOverride)
const controller = new AbortController()
    const timeoutMs = overrideTimeoutMs ?? (subpath === '/embeddings' ? DEFAULT_EMBED_TIMEOUT_MS : provider.timeoutMs)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(target.endpoint, {
        method: 'POST',
        headers: target.headers,
        body: target.payload as unknown as RequestInit['body'],
        signal: controller.signal,
      })
    const contentType = res.headers.get('content-type') ?? 'application/json'
    const body = new Uint8Array(await res.arrayBuffer())
    if (res.status === 400) return { kind: 'business', status: 400, contentType, body }
    if (res.status === 401 || res.status === 403) return { kind: 'business', status: res.status, contentType, body }
    if (res.status === 429) return { kind: 'rate_limit' }
    if (res.status >= 500) return { kind: 'server', status: res.status }
    if (!res.ok) return { kind: 'business', status: res.status, contentType, body }
    if (provider.id === 'anthropic' && subpath === '/chat/completions' && contentType.includes('json')) {
      let translated: Uint8Array
      try {
        const parsed = JSON.parse(toText(body)) as unknown
        translated = jsonBytes(anthropicMessagesToOpenAi(parsed, modelOverride, Date.now()))
      } catch {
        return { kind: 'business', status: 502, contentType: 'application/json', body: jsonBytes({ error: { message: 'Claude returned an unreadable response.', code: 'MALFORMED_UPSTREAM' } }) }
      }
      return { kind: 'ok', status: 200, contentType: 'application/json; charset=utf-8', body: translated }
    }
    return { kind: 'ok', status: res.status, contentType, body }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { kind: 'timeout' }
    return { kind: 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/* --------------------------------- router --------------------------------- */

function errorBody(code: AiRouteErrorCode, message: string): { status: number; body: Uint8Array } {
  // Each code maps to the status the CLIENT already knows how to interpret:
  // 429 → "rate limit reached, wait a moment", 504 → timeout, 502 → upstream
  // unreachable or upstream 5xx, 503 → local configuration problem.
  const status =
    code === 'ai_upstream_rate_limited'
      ? 429
      : code === 'ai_upstream_unreachable' || code === 'ai_upstream_error'
        ? 502
        : code === 'ai_upstream_timeout'
          ? 504
          : 503
  return { status, body: jsonBytes({ error: { message, code } }) }
}

function buildRouter(
  options: AiRouterCreateOptions,
): {
  registry: () => AiRegistrySnapshot
  route: (req: AiRouteRequest) => Promise<AiRouteResult>
  getHealth: () => Promise<AiHealthReport>
} {
  const env = options.env ?? process.env
  const now = options.now ?? (() => Date.now())
  const fetchImpl: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response> =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  const probeHealth = options.probeHealth ?? true
  const probeTtlMs = options.probeTtlMs ?? 15_000
  const transientRetryAttempts = Math.max(0, options.transientRetryAttempts ?? DEFAULT_TRANSIENT_RETRY_ATTEMPTS)
  const transientRetryDelayMs = Math.max(0, options.transientRetryDelayMs ?? DEFAULT_TRANSIENT_RETRY_DELAY_MS)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))

  /**
   * Run ONE provider attempt with a BOUNDED retry on transient network failure
   * only. Every other outcome is returned as-is so the caller's existing
   * classification (auth/business = report; 5xx/rate-limit = next candidate;
   * timeout = honest 504) stays exactly as before.
   */
  const attemptProvider = async (
    provider: AiProviderDefinition,
    subpath: '/chat/completions' | '/embeddings',
    body: Uint8Array,
    modelOverride: string,
    overrideTimeoutMs?: number,
  ): Promise<AttemptOutcome> => {
    let outcome = await attemptCall(provider, subpath, body, modelOverride, fetchImpl, overrideTimeoutMs)
    for (let retry = 0; retry < transientRetryAttempts && outcome.kind === 'network'; retry += 1) {
      await sleep(transientRetryDelayMs)
      outcome = await attemptCall(provider, subpath, body, modelOverride, fetchImpl, overrideTimeoutMs)
    }
    return outcome
  }

  const observations = new Map<AiTransportId, ProbeRecord>()

  /** An observation inside the TTL window; never a stale health claim. */
  const freshObservation = (id: AiTransportId): ProbeRecord | undefined => {
    const record = observations.get(id)
    if (!record) return undefined
    return now() - record.at < probeTtlMs ? record : undefined
  }

  /**
   * The LAST thing we really saw, regardless of TTL.
   *
   * Routing candidacy must not expire: a provider discovered a minute ago is
   * still worth attempting (and will be re-probed by the next health report).
   * Only health CLAIMS are TTL-gated, never routing availability — otherwise
   * "Ollama is running" would stop being true 15 seconds after we learned it.
   */
  const lastObservation = (id: AiTransportId): ProbeRecord | undefined => observations.get(id)

  const isLocalProvider = (id: AiTransportId): boolean => id === 'ollama' || id === 'lmstudio' || id === 'local'

  /**
   * A provider is usable when its config is complete, or when a real probe
   * found local models it can serve.
   */
  const isRoutable = (provider: AiProviderDefinition): boolean =>
    provider.enabled || (isLocalProvider(provider.id) && provider.baseUrl !== '' && lastObservation(provider.id)?.discovered === true)

  /**
   * Map a REAL connection outcome to the per-provider vocabulary. Auth failures
   * collapse to UNAVAILABLE (the provider exists but cannot serve us), while a
   * missing model stays MODEL_UNAVAILABLE because it is actionable.
   */
  const statusForConnection = (connection: AiConnectionStatus): AiProviderHealthStatus =>
    connection === 'CONNECTED'
      ? 'CONNECTED'
      : connection === 'MODEL_UNAVAILABLE'
        ? 'MODEL_UNAVAILABLE'
        : connection === 'MISCONFIGURED'
          ? 'MISCONFIGURED'
          : 'UNAVAILABLE'

  /** Record the outcome of ONE real routed request (never a guess). */
  const observeAttempt = (provider: AiProviderDefinition, outcome: AttemptOutcome): void => {
    const previous = observations.get(provider.id)
    if (outcome.kind === 'ok') {
      observations.set(provider.id, {
        at: now(),
        status: 'CONNECTED',
        connection: 'CONNECTED',
        discovered: true,
        models: previous?.models,
      })
      return
    }
    let connection: AiConnectionStatus
    let lastError: string
    if (outcome.kind === 'business') {
      // A 400 is a client payload problem: it says nothing about provider health
      // and must never demote a healthy provider in auto routing.
      if (outcome.status !== 401 && outcome.status !== 403 && outcome.status !== 404 && outcome.status !== 429) return
      connection = mapProbeStatus(outcome)
      lastError =
        outcome.status === 404
          ? 'The upstream rejected the configured model (HTTP 404).'
          : outcome.status === 429
            ? 'The upstream is rate limiting this key (HTTP 429).'
            : `The upstream rejected the credential (HTTP ${outcome.status}).`
    } else {
      connection = mapProbeStatus(outcome)
      lastError =
        outcome.kind === 'rate_limit'
          ? 'The upstream is rate limiting this key (HTTP 429).'
          : outcome.kind === 'timeout'
            ? 'The upstream did not answer before the timeout.'
            : outcome.kind === 'server'
              ? `The upstream returned HTTP ${outcome.status}.`
              : 'The upstream was unreachable.'
    }
    observations.set(provider.id, {
      at: now(),
      status: statusForConnection(connection),
      connection,
      discovered: false,
      models: previous?.models,
      lastError,
    })
  }

  const modelsEndpointFor = (provider: AiProviderDefinition): string => {
    const base = provider.baseUrl.replace(/\/+$/, '')
    // Ollama lists installed models on its NATIVE /api/tags route (not under the
    // /v1 OpenAI prefix); LM Studio and generic OpenAI-compatible local servers
    // expose the OpenAI /models route.
    return provider.id === 'ollama' ? `${base.replace(/\/v\d+$/, '')}/api/tags` : `${base}/models`
  }

  /** Parse the REAL model list out of an Ollama/LM Studio/OpenAI payload. */
  const parseModelIds = (payload: unknown): string[] => {
    if (!payload || typeof payload !== 'object') return []
    const record = payload as Record<string, unknown>
    const list = Array.isArray(record.models) ? record.models : Array.isArray(record.data) ? record.data : []
    const out: string[] = []
    for (const item of list) {
      if (typeof item === 'string') {
        if (item.trim()) out.push(item.trim())
        continue
      }
      if (!item || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      const name = entry.name ?? entry.id ?? entry.model
      if (typeof name === 'string' && name.trim()) out.push(name.trim())
    }
    return [...new Set(out)].slice(0, MAX_DISCOVERED_MODELS)
  }

  /**
   * REAL model discovery for local providers. Returns the installed models or a
   * truthful error — it never fabricates a model list.
   */
  const discoverModels = async (provider: AiProviderDefinition): Promise<{ models: string[]; error?: string }> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_HEALTH_TIMEOUT_MS)
    try {
      const headers: Record<string, string> = {}
      if (provider.key) headers.authorization = `Bearer ${provider.key}`
      const res = await fetchImpl(modelsEndpointFor(provider), { method: 'GET', headers, signal: controller.signal })
      if (!res.ok) return { models: [], error: `HTTP ${res.status}` }
      const payload = JSON.parse(toText(new Uint8Array(await res.arrayBuffer()))) as unknown
      return { models: parseModelIds(payload) }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return { models: [], error: aborted ? 'timeout' : 'unreachable' }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Probe ONE provider for real: local providers through model discovery (which
   * also yields their installed models), hosted providers through a 1-token
   * chat ping. TTL-cached so a health report cannot hammer an endpoint.
   */
  const probeProvider = async (provider: AiProviderDefinition): Promise<ProbeRecord> => {
    const cached = freshObservation(provider.id)
    if (cached) return cached

    if (isLocalProvider(provider.id)) {
      const discovery = await discoverModels(provider)
      const models = discovery.models
      const connection: AiConnectionStatus = discovery.error
        ? discovery.error === 'timeout'
          ? 'NETWORK_ERROR'
          : 'DISCONNECTED'
        : models.length > 0
          ? 'CONNECTED'
          : 'MODEL_UNAVAILABLE'
      const record: ProbeRecord = {
        at: now(),
        status: statusForConnection(connection),
        connection,
        discovered: connection === 'CONNECTED',
        models,
        lastError: discovery.error
          ? `Model discovery failed (${discovery.error}).`
          : models.length === 0
            ? 'The endpoint is reachable but has no models installed.'
            : undefined,
      }
      observations.set(provider.id, record)
      return record
    }

    const modelOverride = modelFor(provider, 'reasoning') || provider.chatModel || 'gemini-3.6-flash'
    const probeBody = toBytes(
      JSON.stringify({ model: modelOverride, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    )
    const outcome = await attemptProvider(provider, '/chat/completions', probeBody, modelOverride, DEFAULT_HEALTH_TIMEOUT_MS)
    observeAttempt(provider, outcome)
    return (
      observations.get(provider.id) ?? {
        at: now(),
        status: 'UNAVAILABLE',
        connection: 'DISCONNECTED',
        discovered: false,
      }
    )
  }

  /** Probe every target with bounded parallelism (cache-aware). */
  const probeAll = async (targets: AiProviderDefinition[]): Promise<void> => {
    const queue = [...targets]
    const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift()
        if (!next) return
        await probeProvider(next)
      }
    })
    await Promise.all(workers)
  }

  /**
   * The ONE routing order, shared by `route()` and `getHealth()` so the reported
   * active provider is always the provider that would actually serve a request.
   */
  const routingCandidates = (registry: AiRegistrySnapshot, pinned: AiTransportId | null): AiProviderDefinition[] => {
    if (pinned) {
      const pinnedProvider = findProvider(registry.providers, pinned)
      return pinnedProvider && isRoutable(pinnedProvider) ? [pinnedProvider] : []
    }
    const base = orderedCandidates(registry, isRoutable)
    if (registry.primary !== 'auto') return base
    // AUTO — order by the LAST REAL observation. Unknown providers keep their
    // declared position; known-bad ones are attempted last but still attempted,
    // so "every provider is down" is still reported honestly.
    return base
      .map((provider, index) => ({ provider, index, rank: (observations.get(provider.id)?.connection ?? 'CONNECTED') === 'CONNECTED' ? 0 : 2 }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.provider)
  }

  /** A discovered model is a real default when no chat model is configured. */
  const discoveredDefaultModel = (provider: AiProviderDefinition): string =>
    freshObservation(provider.id)?.models?.[0] ?? ''

  const reg = (): AiRegistrySnapshot => resolveRegistry(env, options.legacy)

  const effectivePinned = (reqPinned: string | null | undefined): AiTransportId | null => {
    const header = typeof reqPinned === 'string' && reqPinned.trim() ? reqPinned.trim() : ''
    if (isProviderId(header)) return header
    if (header === 'legacy') return 'legacy'
    return reg().pinned
  }

  const route = async (req: AiRouteRequest): Promise<AiRouteResult> => {
    const registry = reg()
    const pinned = effectivePinned(req.pinned)

    const parsed = parseBody(req.body)
    if (!parsed.ok) {
      return { status: 400, contentType: 'application/json; charset=utf-8', body: jsonBytes({ error: { message: 'Invalid JSON body.', code: 'INVALID_BODY' } }), provider: 'none', model: '', capability: 'unknown', usedFallback: false, errorCode: 'invalid_body', errorMessage: 'Invalid JSON body.' }
    }

    const capability = detectCapability(req.subpath, parsed.value)

    let candidates: AiProviderDefinition[]
    if (pinned) {
      const pinnedProvider = findProvider(registry.providers, pinned)
      if (!pinnedProvider || !isRoutable(pinnedProvider)) {
        return { status: 503, contentType: 'application/json; charset=utf-8', body: jsonBytes({ error: { message: `Pinned provider "${pinned}" is not configured on the server.`, code: 'PROVIDER_NOT_CONFIGURED' } }), provider: 'none', model: '', capability, usedFallback: false, errorCode: 'provider_not_configured', errorMessage: `Pinned provider "${pinned}" is not configured on the server.` }
      }
      candidates = [pinnedProvider]
    } else {
      // Health-aware: for `auto` a provider that just failed is tried last.
      candidates = routingCandidates(registry, null)
    }

    if (candidates.length === 0 && !pinned && registry.primary === 'auto') {
      // Cold start: nothing has been observed yet. Discover the local engines for
      // real (bounded + TTL-cached) so `auto` can use a running Ollama/LM Studio
      // without waiting for a separate health call.
      await probeAll(registry.providers.filter((p) => isLocalProvider(p.id) && p.baseUrl !== ''))
      candidates = routingCandidates(registry, null)
    }

    if (candidates.length === 0) {
      return { status: 503, contentType: 'application/json; charset=utf-8', body: jsonBytes({ error: { message: 'No AI provider is configured. Set JARVIS_AI_PRIMARY_PROVIDER (e.g. gemini/openai/anthropic/openrouter/local) plus its API key, or set JARVIS_AI_BASE_URL + JARVIS_API_KEY (or GEMINI_API_KEY) for the legacy single provider.', code: 'AI_NOT_CONFIGURED' } }), provider: 'none', model: '', capability, usedFallback: false, errorCode: 'ai_not_configured', errorMessage: 'No AI provider is configured.' }
    }

    candidates = candidates.filter((p) => capabilityOfProvider(p, capability))
    if (candidates.length === 0) {
      return { status: 503, contentType: 'application/json; charset=utf-8', body: jsonBytes({ error: { message: `No configured provider supports the "${capability}" capability. Configure one (or remove the request), or check provider keys.`, code: 'UNSUPPORTED_CAPABILITY' } }), provider: 'none', model: '', capability, usedFallback: false, errorCode: 'unsupported_capability', errorMessage: `No configured provider supports the "${capability}" capability.` }
    }

    let sawTimeout = false
    let sawNetwork = false
    let sawRateLimit = false
    let sawUpstreamError = false
    for (let i = 0; i < candidates.length; i += 1) {
      const provider = candidates[i]!
      // A really-discovered local model is the honest default when the operator
      // pinned none; otherwise the configured model is used.
      let modelOverride = modelFor(provider, capability) || discoveredDefaultModel(provider)
      if (!modelOverride && isLocalProvider(provider.id) && capability !== 'embeddings') {
        // Local engines are routinely run with no pinned chat model. Discover
        // the installed models for real (bounded + TTL-cached) instead of
        // forwarding another provider's model id to a server that has none.
        await probeProvider(provider)
        modelOverride = discoveredDefaultModel(provider)
      }
      const outcome = await attemptProvider(provider, req.subpath, req.body, modelOverride)
      // Feed the REAL result back into health/auto routing.
      observeAttempt(provider, outcome)
      switch (outcome.kind) {
        case 'ok':
          return {
            status: outcome.status,
            contentType: outcome.contentType,
            body: outcome.body,
            provider: provider.id,
            model: modelOverride,
            capability,
            usedFallback: i > 0,
          }
        case 'business':
          // 400/401/403 are never retried and never failed over: the request
          // payload or the credential is invalid, and reporting it honestly is
          // the only correct action.
          return {
            status: outcome.status,
            contentType: outcome.contentType,
            body: outcome.body,
            provider: provider.id,
            model: modelOverride,
            capability,
            usedFallback: i > 0,
            errorMessage: `Upstream provider "${provider.name}" rejected the request (HTTP ${outcome.status}).`,
          }
        case 'rate_limit':
          // Reachable but throttled → try the next candidate, and remember the
          // REAL reason so an honest 429 can be reported if none can serve it.
          sawRateLimit = true
          continue
        case 'server':
          // Upstream 5xx → next candidate; remember it for an honest report.
          sawUpstreamError = true
          continue
        case 'timeout':
          sawTimeout = true
          continue
        case 'network':
          sawNetwork = true
          continue
      }
    }

    const names = candidates.map((c) => c.name).join(', ')

    // Every candidate failed. Report the REAL reason instead of a blanket
    // "unreachable". A provider that answered 429 is REACHABLE and merely
    // throttled, and one that answered 5xx is also reachable: mislabeling
    // either as `ai_upstream_unreachable` (502) told the user "AI service
    // unreachable" while the provider was healthy, hiding an actionable rate
    // limit behind a network-sounding error.
    //
    // Precedence: a genuine transport failure outranks everything (we cannot
    // claim the provider is merely throttled if we never actually reached one),
    // then a timeout, then rate limiting, then an upstream 5xx.
    if (!sawNetwork && !sawTimeout && sawRateLimit) {
      const err = errorBody('ai_upstream_rate_limited', `All configured providers are rate limited (${names}). This is an upstream quota/throttle, not a JARVIS failure.`)
      return { status: err.status, contentType: 'application/json; charset=utf-8', body: err.body, provider: 'none', model: '', capability, usedFallback: false, errorCode: 'ai_upstream_rate_limited', errorMessage: 'All configured providers are rate limited.' }
    }
    if (!sawNetwork && !sawTimeout && sawUpstreamError) {
      const err = errorBody('ai_upstream_error', `All configured providers returned an upstream server error (${names}).`)
      return { status: err.status, contentType: 'application/json; charset=utf-8', body: err.body, provider: 'none', model: '', capability, usedFallback: false, errorCode: 'ai_upstream_error', errorMessage: 'All configured providers returned an upstream server error.' }
    }
    if (sawTimeout && !sawNetwork) {
      const err = errorBody('ai_upstream_timeout', `All configured providers timed out (${names}).`)
      return { status: err.status, contentType: 'application/json; charset=utf-8', body: err.body, provider: 'none', model: '', capability, usedFallback: false, errorCode: 'ai_upstream_timeout', errorMessage: 'All configured providers timed out.' }
    }
    const err = errorBody('ai_upstream_unreachable', `All configured providers were unreachable (${names}).`)
    return { status: err.status, contentType: 'application/json; charset=utf-8', body: err.body, provider: 'none', model: '', capability, usedFallback: false, errorCode: 'ai_upstream_unreachable', errorMessage: 'All configured providers were unreachable.' }
  }

  const getHealth = async (): Promise<AiHealthReport> => {
    const registry = reg()
    const definitions = registry.providers
    const pinned = effectivePinned(null)
    const configured = definitions.filter((p) => p.enabled)
    const configuredIds = configured.map((p) => p.id)

    // Probe EVERY configured provider (bounded + TTL-cached) so no provider is
    // ever reported CONNECTED without a real observation in this process. Local
    // providers are probed through model discovery even when they are not
    // `enabled` — that is how a running Ollama/LM Studio becomes visible at all.
    const probeTargets = definitions.filter((p) => p.enabled || (isLocalProvider(p.id) && p.baseUrl !== ''))
    let providersProbed = false
    if (probeHealth && probeTargets.length > 0) {
      await probeAll(probeTargets)
      providersProbed = true
    }

    // The active provider is whatever the router would ACTUALLY use right now —
    // the same health-aware order `route()` uses, so the report cannot lie about
    // which provider would answer a request.
    const candidates = routingCandidates(registry, pinned)
    const active = candidates[0]
    const usable = definitions.filter(isRoutable)
    const availableIds = usable.filter((p) => p.capabilities.includes('reasoning')).map((p) => p.id)
    const healthyIds = definitions.filter((p) => freshObservation(p.id)?.connection === 'CONNECTED').map((p) => p.id)

    let status: AiConnectionStatus = 'MISCONFIGURED'
    let message: string | undefined
    let model: string | undefined
    let upstream: string | undefined

    /** Describe a provider that answered but cannot serve requests. */
    const unusableMessage = (provider: AiProviderDefinition, observation: ProbeRecord): string => {
      let text = `${provider.name} is not usable: ${observation.lastError ?? observation.status}`
      if (observation.connection === 'MODEL_UNAVAILABLE') {
        text +=
          provider.id === 'ollama'
            ? ' Pull a model first (for example `ollama pull llama3.2`).'
            : ' Install or load a model in the local engine.'
      }
      return text
    }

    if (configured.length === 0 && candidates.length === 0) {
      // Nothing is routable. If a real probe still reached something, report
      // THAT (actionable) instead of the blanket "nothing is configured" — a
      // reachable local engine with no models is a different problem.
      const observed = definitions
        .map((p) => ({ p, observation: freshObservation(p.id) }))
        .filter((entry): entry is { p: AiProviderDefinition; observation: ProbeRecord } => entry.observation !== undefined)
        .sort((a, b) => observationWeight(a.observation.connection) - observationWeight(b.observation.connection))
      const best = observed[0]
      if (best) {
        status = best.observation.connection
        message = unusableMessage(best.p, best.observation)
      } else {
        message = 'No AI provider is configured. Set JARVIS_AI_PRIMARY_PROVIDER (e.g. auto/gemini/openai/anthropic/openrouter/local) plus its API key, or set JARVIS_AI_BASE_URL + JARVIS_API_KEY (or GEMINI_API_KEY) for the legacy single provider, then restart.'
      }
    } else if (active) {
      const observation = freshObservation(active.id)
      status = observation ? observation.connection : probeHealth ? 'MISCONFIGURED' : 'CONNECTED'
      model = modelFor(active, 'reasoning') || discoveredDefaultModel(active) || active.chatModel || undefined
      upstream = active.baseUrl || undefined
      if (observation && observation.connection !== 'CONNECTED') {
        message = unusableMessage(active, observation)
      }
    }

    const providers: AiProviderHealthEntry[] = definitions.map((p): AiProviderHealthEntry => {
      const observation = freshObservation(p.id)
      const disabled = registry.disabled.includes(p.id)
      // A credential this provider REQUIRES and that is not set — actionable.
      const keyRequired = p.apiKeyEnv !== '' && !p.key && p.baseUrl !== ''
      let pStatus: AiProviderHealthStatus
      if (disabled) pStatus = 'DISABLED'
      else if (observation) pStatus = observation.status
      else if (keyRequired) pStatus = 'KEY_REQUIRED'
      else if (!p.baseUrl) pStatus = 'NOT_CONFIGURED'
      else if (p.enabled) pStatus = probeHealth ? 'UNAVAILABLE' : 'CONFIGURED'
      else pStatus = 'NOT_CONFIGURED'
      return {
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        configured: p.enabled,
        available: isRoutable(p) && p.capabilities.includes('reasoning'),
        capabilities: p.capabilities,
        model: modelFor(p, 'reasoning') || discoveredDefaultModel(p) || p.chatModel || '',
        status: pStatus,
        discovered: observation?.discovered === true,
        models: observation?.models?.length ? observation.models : undefined,
        probedAt: observation?.at ?? 0,
        lastError: observation?.lastError,
      }
    })

    return {
      status,
      code: status,
      message,
      model,
      upstream,
      provider: (active?.id ?? 'none') as AiTransportId | 'none',
      primary: registry.primary,
      pinned,
      configuredProviders: configuredIds,
      availableProviders: availableIds,
      healthyProviders: healthyIds,
      capabilities: [...new Set(usable.flatMap((p) => p.capabilities))],
      providersProbed,
      providers,
    }
  }

  return {
    registry: () => reg(),
    route,
    getHealth,
  }
}

/**
 * Order unreachable-but-observed providers by how actionable they are: a
 * reachable endpoint missing a model beats a transport failure, which beats a
 * bad credential (nothing can be done without a new key).
 */
function observationWeight(connection: AiConnectionStatus): number {
  if (connection === 'MODEL_UNAVAILABLE') return 0
  if (connection === 'DISCONNECTED' || connection === 'NETWORK_ERROR') return 1
  if (connection === 'RATE_LIMITED') return 2
  return 3
}

function mapProbeStatus(outcome: AttemptOutcome): AiConnectionStatus {
  switch (outcome.kind) {
    case 'ok':
      return 'CONNECTED'
    case 'business':
      if (outcome.status === 401 || outcome.status === 403) return 'AUTHENTICATION_FAILED'
      if (outcome.status === 404) return 'MODEL_UNAVAILABLE'
      if (outcome.status === 429) return 'RATE_LIMITED'
      return 'DISCONNECTED'
    case 'rate_limit':
      return 'RATE_LIMITED'
    case 'server':
      return 'DISCONNECTED'
    case 'timeout':
      return 'NETWORK_ERROR'
    case 'network':
      return 'NETWORK_ERROR'
  }
}

export function createAiProviderRouter(options: AiRouterCreateOptions = {}): AiRouter {
  const built = buildRouter(options)
  return {
    route: built.route,
    getHealth: built.getHealth,
    registry: built.registry,
  }
}

/**
 * Resolve the historical single-upstream proxy (Vite dev parity):
 *
 *   baseUrl = VITE_JARVIS_AI_PROXY_TARGET || Gemini OpenAI-compatible default
 *   key     = GEMINI_API_KEY || JARVIS_API_KEY || OPENAI_API_KEY
 *
 * Returns `undefined` when nothing usable is configured (the caller then reports
 * an honest 503 / MISCONFIGURED). Only consulted in legacy (non-router) mode.
 */
export function resolveLegacyProxy(env: Record<string, string | undefined>): AiProxyConfig | undefined {
  const geminiKey = envString(env, 'GEMINI_API_KEY')
  const jarvisKey = envString(env, 'JARVIS_API_KEY') || envString(env, 'OPENAI_API_KEY')
  const activeKey = geminiKey || jarvisKey
  const target = envString(env, 'VITE_JARVIS_AI_PROXY_TARGET')
  const baseUrl = target || DEFAULT_GEMINI_BASE
  if (!baseUrl || !activeKey) return undefined
  return {
    baseUrl,
    key: activeKey,
    timeoutMs: envInt(env, 'JARVIS_AI_TIMEOUT_MS', 60_000),
  }
}