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
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) maxTokens = 1024

  const apiKeyEnv = 'JARVIS_API_KEY'
  const transport: AiTransport = proxyUrl ? 'proxy' : baseUrl ? 'direct' : 'none'
  // An endpoint alone is not enough — a model name must also be declared.
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