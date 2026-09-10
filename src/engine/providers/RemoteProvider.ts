import type { AIProvider, AIRequest, AIResponse, AIMessage, AIProviderInfo, ToolDefinition } from '../provider'
import type { EngineOutMessage } from '../contracts'
import { ProviderError } from './ProviderError'
import { getAiConfig, REMOTE_PROVIDER_ID } from '../../config/ai'

/**
 * Remote provider — OpenAI-compatible Chat Completions.
 *
 * Serves a REAL LLM over HTTP. The key is read from `JARVIS_API_KEY` on
 * `import.meta.env` (from `.env.local`, git-ignored) — never hard-coded and
 * never logged. When `VITE_JARVIS_AI_PROXY_URL` is set, requests go to that
 * same-origin proxy instead, keeping the key entirely server-side.
 */

interface RemoteConfig {
  baseUrl: string
  model: string
  key: string | null
  temperature: number
  maxTokens: number
}

async function readConfig(): Promise<RemoteConfig> {
  const cfg = getAiConfig()
  const env = import.meta.env as Record<string, string | undefined>
  const proxyUrl = env['VITE_JARVIS_AI_PROXY_URL']?.trim() || ''
  const key = env[cfg.apiKeyEnv]?.trim() || null
  const baseUrl = proxyUrl || (cfg as { baseUrl: string | null }).baseUrl || ''
  return {
    baseUrl,
    model: cfg.model || '',
    key,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
  }
}

function resolveEndpoint(baseUrl: string): string {
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
  readonly label = 'Remote LLM'

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
      const cfg = await readConfig()
      if (!cfg.baseUrl || !cfg.model) return false
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      try {
        const res = await fetch(cfg.baseUrl, { method: 'GET', signal: controller.signal })
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
    const env = import.meta.env as Record<string, string | undefined>
    const proxyUrl = env['VITE_JARVIS_AI_PROXY_URL']?.trim()
    return { model: cfg.model || undefined, baseUrl: cfg.baseUrl || proxyUrl || undefined }
  }

  async generate(request: AIRequest, emit: (m: EngineOutMessage) => void): Promise<AIResponse> {
    const cfg = await readConfig()
    if (!cfg.baseUrl || !cfg.model) {
      throw new ProviderError('config', 'Remote provider is not configured. Add base URL and model to `.env.local`.')
    }
    const proxyDone = cfg.baseUrl.startsWith('/')
    if (!cfg.key && !proxyDone) {
      throw new ProviderError('config', 'Remote provider needs a key. Set JARVIS_API_KEY in `.env.local` (git-ignored).')
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
    if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`

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
        throw new ProviderError('auth', 'The AI service rejected the configured key.')
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