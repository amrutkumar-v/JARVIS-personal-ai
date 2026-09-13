import type { AIProvider } from '../provider'
import { ApiProvider } from './ApiProviderMock'
import { ReasoningProvider } from '../reasoning/ReasoningProvider'
import { getAiConfig, REMOTE_PROVIDER_ID } from '../../config/ai'

/**
 * Provider registry — deterministic, observable selection.
 *
 * Bound at startup. Selection policy (single source of truth: `getAiConfig()`):
 *   - the structured-planning `ReasoningProvider` becomes active when a real
 *     AI endpoint + model are configured (see `.env.example` → `.env.local`),
 *     via proxy or direct. It is a superset of `RemoteProvider` (drop-in for
 *     chat) and additionally supports Phase 13 structured planning.
 *   - Otherwise the clearly-labelled dev `ApiProvider` ('mock') stands in —
 *     ONLY when no real AI configuration is genuinely available.
 *
 * Exactly one provider is returned: the engine addresses `providers[0]`, so a
 * configured remote provider is used and the mock is never silently consulted.
 * Fallback is explicit: when the remote provider is configured but unreachable,
 * the engine reports the failure honestly instead of using the mock.
 */
let singleton: AIProvider[] | null = null

export function createProviders(): AIProvider[] {
  if (singleton) return singleton

  const cfg = getAiConfig()
  singleton = cfg.providerId === REMOTE_PROVIDER_ID ? [new ReasoningProvider()] : [new ApiProvider()]
  return singleton
}

/** Reset the cached provider list (used by tests). */
export function resetProviders(): void {
  singleton = null
}

export type { AIProvider } from '../provider'