/**
 * Phase 13 — the structured-planning provider seam.
 *
 * A provider that can reason structurally implements `plan()` and OPTIONALLY
 * returns a single strict-JSON structured plan (the engine validates whatever
 * comes back; nothing is trusted). The base `RemoteProvider` deliberately does
 * NOT implement `plan()` — only the reasoning subclass does — so existing
 * chat-completions contract tests keep exercising the tool-calling loop.
 */

import type { AIProvider } from '../provider'
import { ProviderError } from '../providers/ProviderError'
import type { ReasoningRequest } from './contract'

export interface StructuredPlanProvider {
  readonly id: string
  /**
   * Strict structured planning: returns ONLY the raw structured-plan JSON
   * (already parsed as `unknown`). The engine runs `parseAndValidatePlan` on
   * it before any capability is selected. Throws `ProviderError` (or a plain
   * Error) on config/network/auth/rate-limit/server/timeout/malformed — the
   * engine maps failures to honest refusals and never executes anything.
   *
   * May be passed an `AbortSignal` owned by the engine watchdog; the provider
   * should abort its request when the signal fires.
   */
  plan(request: ReasoningRequest, signal?: AbortSignal): Promise<unknown>
}

/** True when the active provider can produce structured plans. This is what
 * unlocks the reasoning gate for a provider — a bare `RemoteProvider` (tool
 * calling only) never triggers it. */
export function isStructuredPlanProvider(provider: AIProvider): provider is AIProvider & StructuredPlanProvider {
  return typeof (provider as Partial<StructuredPlanProvider>).plan === 'function'
}

/** Stable, user-safe failure kind for a reasoning-plan attempt. The engine
 * never echoes raw error contents (which could carry secrets). */
export function reasoningFailureKind(error: unknown): string {
  if (error instanceof ProviderError) return error.kind
  if (error instanceof Error && error.name === 'AbortError') return 'timeout'
  return 'unknown'
}