import type { AIProvider, AIRequest, AIResponse, AIMessage, AIProviderInfo, ToolDefinition } from '../provider'
import type { EngineOutMessage } from '../contracts'
import { ProviderError } from './ProviderError'
import { getAiConfig, REMOTE_PROVIDER_ID } from '../../config/ai'

/**
 * Remote provider — OpenAI-compatible Chat Completions.
 *
 * Serves a REAL LLM over HTTP. The API key NEVER ships in the browser bundle
 * (Vite exposes only `VITE_*` vars), so the client reaches the endpoint in one
 * of two honest ways:
 *
 *   - **proxy mode** (`VITE_JARVIS_AI_PROXY_URL`, e.g. `/api/ai`): requests go
 *     to a same-origin proxy that injects `Authorization` server-side (the Vite
 *     dev proxy in development, or the JARVIS Core backend in production). No
 *     key is ever attached client-side.
 *   - **direct keyless mode** (`VITE_JARVIS_AI_BASE_URL`): for local endpoints
 *     that need no auth (Ollama / LM Studio). When the direct endpoint
 *     actually requires a key, the 401/403 response is surfaced as an honest
 *     `auth` ProviderError instead of a misleading success.
 *
 * Where a key genuinely IS visible on `import.meta.env` (test/Electron
 * environments), it is attached directly. Failure behavior is always honest:
 * config errors, network failure, auth rejection, rate limiting and upstream
 * 5xx are reported, never silently swapped for the mock provider.
 */

/** Resolved, transport-aware runtime settings for a single request. */
export interface ResolvedRemoteConfig {
  baseUrl: string
  model: string
  key: string | null
  proxyMode: boolean
  temperature: number
  maxTokens: number
}

export function resolveRemoteConfig(): ResolvedRemoteConfig {
  const cfg = getAiConfig()
  const env = import.meta.env as Record<string, string | undefined>
  // The key is only reachable where the runtime actually exposes it (tests /
  // Electron). In a standard browser it is `undefined` by design.
  const key = env[cfg.apiKeyEnv]?.trim() || null
  const proxyMode = cfg.transport === 'proxy'
  const baseUrl = proxyMode ? cfg.proxyUrl || '' : cfg.baseUrl || ''
  return {
    baseUrl,
    model: cfg.model || '',
    key,
    proxyMode,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
  }
}

export function resolveEndpoint(baseUrl: string): string {
  if (baseUrl.includes('/chat/completions')) return baseUrl
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

interface OpenAIToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}

function mapMessage(m: AIMessage): Record<string, unknown> {
  if (m.role === 'assistant') {
    const base: Record<string, unknown> = { role: 'assistant', content: m.content }
    if (m.toolCalls && m.toolCalls.length) {
      base.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.toolId, arguments: JSON.stringify(tc.payload) },
      }))
    }
    return base
  }
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.callId, content: m.content }
  }
  return { role: m.role, content: m.content }
}

function toToolDefinition(d: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: d.id, description: d.description, parameters: d.parameters },
  }
}

function parseToolCalls(data: unknown): AIResponse['toolRequests'] {
  const calls = (
    data as {
      choices?: Array<{ message?: { tool_calls?: OpenAIToolCall[] } }>
    }
  )?.choices?.[0]?.message?.tool_calls
  if (!calls || !calls.length) return undefined

  return calls
    .filter((c) => c?.function?.name)
    .map((c) => {
      let payload: Record<string, unknown> = {}
      if (c.function?.arguments) {
        try {
          const parsed = JSON.parse(c.function.arguments) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            payload = parsed as Record<string, unknown>
          }
        } catch {
          throw new ProviderError('malformed', 'The model returned malformed tool arguments.', 0)
        }
      }
      return { id: c.id || `call-${Date.now()}`, toolId: c.function?.name || '', payload }
    })
    .filter((t) => t.toolId)
}

export class RemoteProvider implements AIProvider {
  readonly id = REMOTE_PROVIDER_ID

  get label(): string {
    const cfg = getAiConfig()
    if (cfg.model?.includes('gemini')) return `Gemini (${cfg.model})`
    return cfg.model ? `Remote (${cfg.model})` : 'Remote LLM'
  }

  isConfigured(): boolean {
    try {
      const cfg = getAiConfig()
      return cfg.providerId === REMOTE_PROVIDER_ID && Boolean(cfg.model)
    } catch {
      return false
    }
  }

  async isReachable(): Promise<boolean> {
    try {
      const cfg = resolveRemoteConfig()
      if (!cfg.baseUrl || !cfg.model) return false
      const targetUrl = cfg.proxyMode ? `${cfg.baseUrl.replace(/\/+$/, '')}/health` : cfg.baseUrl
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      try {
        const res = await fetch(targetUrl, { method: 'GET', signal: controller.signal })
        if (res.ok) {
          if (cfg.proxyMode) {
            try {
              const data = (await res.json()) as { status?: string }
              return data.status === 'CONNECTED'
            } catch {
              return true
            }
          }
          return true
        }
        return res.status < 500
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return false
    }
  }

  describe(): AIProviderInfo {
    const cfg = getAiConfig()
    return {
      model: cfg.model || undefined,
      baseUrl: cfg.transport === 'proxy' ? cfg.proxyUrl || undefined : cfg.baseUrl || undefined,
    }
  }

  async generate(request: AIRequest, emit: (m: EngineOutMessage) => void): Promise<AIResponse> {
    const cfg = resolveRemoteConfig()
    if (!cfg.baseUrl || !cfg.model) {
      throw new ProviderError('config', 'Remote provider is not configured. Add a base URL and model to `.env.local`.')
    }

    const url = resolveEndpoint(cfg.baseUrl)
    const messages = request.messages.map(mapMessage)

    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
    }
    if (request.toolDefinitions.length) {
      body.tools = request.toolDefinitions.map(toToolDefinition)
      body.tool_choice = 'auto'
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    // Only the proxy (server-side key) or a runtime that actually exposes the
    // key (tests/Electron) sets an Authorization header — never the browser.
    // A direct request without a key is a legitimate keyless-local attempt.
    if (cfg.key && !cfg.proxyMode) headers.Authorization = `Bearer ${cfg.key}`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 45000)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timeout)
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderError('timeout', 'The AI service timed out. Please try again.')
      }
      throw new ProviderError('network', 'Could not reach the AI service.')
    }
    clearTimeout(timeout)

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      if (res.status === 401 || res.status === 403) {
        const hint = cfg.key
          ? 'The AI service rejected the configured key.'
          : 'The AI service requires authentication. Configure the key server-side (proxy mode), or use a keyless local endpoint.'
        throw new ProviderError('auth', hint)
      }
      if (res.status === 429) {
        throw new ProviderError('rate_limit', 'The AI service is rate-limited. Wait a moment and try again.')
      }
      if (res.status >= 500) {
        throw new ProviderError('server', `The AI service returned HTTP ${res.status}.`)
      }
      throw new ProviderError('server', `The AI service returned HTTP ${res.status} (${detail.slice(0, 120)}).`)
    }

    let json: unknown
    try {
      json = (await res.json()) as unknown
    } catch {
      throw new ProviderError('malformed', 'The AI service returned an unreadable response.')
    }

    const choice = (json as { choices?: Array<{ message?: { content?: string | null } }> })?.choices?.[0]
    const content = choice?.message?.content ?? ''
    const toolRequests = parseToolCalls(json)

    if (toolRequests && toolRequests.length) {
      emit({ type: 'notice', kind: 'info', text: `The model requested ${toolRequests.length} tool call(s).` })
      return { text: '', toolRequests }
    }

    if (typeof content !== 'string' || !content.trim()) {
      throw new ProviderError('malformed', 'The AI service returned an empty reply.')
    }
    return { text: content }
  }
}