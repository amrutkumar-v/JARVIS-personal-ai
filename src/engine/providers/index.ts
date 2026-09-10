import type { AIProvider } from '../provider'
import { ApiProvider } from './ApiProviderMock'
import { RemoteProvider } from './RemoteProvider'
import { getAiConfig, REMOTE_PROVIDER_ID } from '../../config/ai'

/**
 * Provider registry.
 *
 * Bound at startup. Phase 0.2 policy:
 *   - `RemoteProvider` becomes active when a real AI endpoint is configured
 *     (see `.env.example` → `.env.local`).
 *   - Otherwise the clearly-labelled dev `ApiProvider` ('mock') stands in.
 *
 * Fallback is explicit: when the remote provider is configured but unreachable,
 * the engine reports the failure honestly instead of silently using the mock.
 */
let singleton: AIProvider[] | null = null

export function createProviders(): AIProvider[] {
  if (singleton) return singleton

  const cfg = getAiConfig()
  if (cfg.providerId === REMOTE_PROVIDER_ID) {
    singleton = [new RemoteProvider(), new ApiProvider()]
  } else {
    singleton = [new ApiProvider()]
  }
  return singleton
}

/** Reset the cached provider list (used by tests). */
export function resetProviders(): void {
  singleton = null
}

export type { AIProvider } from '../provider'