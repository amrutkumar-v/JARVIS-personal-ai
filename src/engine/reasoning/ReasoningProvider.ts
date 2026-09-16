/**
 * Phase 13 — the REAL reasoning provider.
 *
 * Extends the certified `RemoteProvider` transport (OpenAI-compatible Chat
 * Completions; proxy or direct-keyless; the API key never ships in the browser)
 * with ONE additional method: `plan()`. It asks the model for a strict JSON
 * structured plan (response_format json_object, low temperature, no web
 * browsing) and returns the parsed object. The ENGINE validates that object;
 * the provider never executes anything itself.
 *
 * Security posture is inherited from `RemoteProvider`: config errors, network
 * failure, auth rejection, rate limiting, server errors, timeouts and malformed
 * replies are all surfaced as typed `ProviderError`s — the engine maps those to
 * honest refusals and executes NOTHING.
 */

import { RemoteProvider, resolveEndpoint, resolveRemoteConfig, withProviderPin } from '../providers/RemoteProvider'
import { ProviderError } from '../providers/ProviderError'
import type { StructuredPlanProvider } from './provider'
import type { ReasoningRequest } from './contract'
import { REASONING_PLAN_LIMITS } from './contract'

function mergeSignals(controller: AbortController, external?: AbortSignal): AbortSignal {
  if (!external) return controller.signal
  if (external.aborted) controller.abort()
  else external.addEventListener('abort', () => controller.abort(), { once: true })
  return controller.signal
}

function toStructuredSchemaLine(c: ReasoningRequest['capabilities'][number]): string {
  const args = c.arguments
    .map((a) => `${a.name}${a.required ? '' : ' (optional)'}:${a.type}${a.description ? ` — ${a.description}` : ''}`)
    .join('; ')
  const flags = [c.requiresConfirmation ? '[REQUIRES CONFIRMATION]' : undefined, c.readOnly ? '[READ-ONLY]' : undefined]
    .filter(Boolean)
    .join(' ')
  return `- "${c.id}" — ${c.name}: ${c.description}${flags ? ` ${flags}` : ''}${args ? ` Params: ${args}` : ''}`
}

export class ReasoningProvider extends RemoteProvider implements StructuredPlanProvider {
  /**
   * Ask the model for a strict structured plan. Returns the parsed JSON object
   * UNVALIDATED — the engine must pass it through `parseAndValidatePlan` before
   * anything runs. Failure is always a typed ProviderError, never silent.
   */
  async plan(request: ReasoningRequest, signal?: AbortSignal): Promise<unknown> {
    const cfg = resolveRemoteConfig()
    if (!cfg.baseUrl || !cfg.model) {
      throw new ProviderError('config', 'Remote provider is not configured. Add a base URL and model to `.env.local`.')
    }

    const capabilityLines = request.capabilities.map(toStructuredSchemaLine).join('\n')
    const system =
      'You convert one natural-language request into a single strict JSON plan. ' +
      `The reply MUST be ONLY one JSON object: {"intent":"execute"|"status"|"unsupported"|"clarification"|"reject","steps":[{"capabilityId":"...","arguments":{...},"reason":"..."}],"asking":"...","reason":"..."}. ` +
      'Every step must reference a registered capability below with schema-valid arguments. ' +
      `SAFETY — ${request.constraints}`

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: system },
      { role: 'user', content: `REGISTERED CAPABILITIES (json):\n${capabilityLines}\n\nUSER REQUEST: ${request.text}` },
    ]

    const url = resolveEndpoint(cfg.baseUrl)
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: Math.min(cfg.temperature, 0.3),
      max_tokens: 512,
      response_format: { type: 'json_object' },
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.key && !cfg.proxyMode) headers.Authorization = `Bearer ${cfg.key}`
    withProviderPin(headers, cfg.proxyMode)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REASONING_PLAN_LIMITS.planDeadlineMs)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: mergeSignals(controller, signal),
      })
    } catch (error) {
      clearTimeout(timer)
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderError('timeout', 'AI planning timed out. Nothing was executed.')
      }
      throw new ProviderError('network', 'Could not reach the AI service.')
    }
    clearTimeout(timer)

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

    const content = (json as { choices?: Array<{ message?: { content?: string | null } }> })?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      throw new ProviderError('malformed', 'The AI service returned an empty plan.')
    }
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    try {
      return JSON.parse(cleaned) as unknown
    } catch {
      throw new ProviderError('malformed', 'The AI service returned a plan that was not valid JSON.')
    }
  }
}