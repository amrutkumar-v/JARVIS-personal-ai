/**
 * AI configuration — read from `VITE_*` environment variables at build time.
 *
 * SECURITY: never embed a real key in source. The key field here holds ONLY a
 * placeholder name ("auto") that tells `RemoteProvider` to look for a
 * `JARVIS_API_KEY` value on `import.meta.env` (from `.env.local`, which is
 * git-ignored). No real credentials are ever committed — `.env.example` ships
 * placeholder values only.
 */

export interface AiConfig {
  /** Configured provider id ('remote') or 'mock' when none is set up. */
  providerId: string
  /** OpenAI-compatible base URL (no trailing slash normally). */
  baseUrl: string | null
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
  const model = envString('VITE_JARVIS_AI_MODEL')?.trim() || null
  let temperature = Number(envString('VITE_JARVIS_AI_TEMPERATURE'))
  if (!Number.isFinite(temperature)) temperature = 0.7
  let maxTokens = Number(envString('VITE_JARVIS_AI_MAX_TOKENS'))
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) maxTokens = 1024

  const apiKeyEnv = 'JARVIS_API_KEY'
  const configured = Boolean((baseUrl || envString('VITE_JARVIS_AI_PROXY_URL')) && model)

  return {
    providerId: configured ? 'remote' : 'mock',
    baseUrl,
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

/** The placeholder name placed in `.env.example` (never a real key). */
export const REMOTE_PROVIDER_ID = 'remote'
export const MOCK_PROVIDER_ID = 'mock'