/**
 * Ambient native-agent configuration (Phase 1.2 / Phase 5).
 *
 * The live app binds real native Windows providers only when
 * `VITE_NATIVE_AGENT_URL` is declared (`.env.local`). This module is the single
 * seam where that ambient env is read, so the browser bootstrap in `index.ts`
 * stays pure and tests can deterministically exercise the "no native agent
 * configured" contract by mocking this module — the value comes from
 * `import.meta.env`, which Vite isolates per transformed module, so it cannot
 * be stubbed at runtime from a test file.
 */
import { getBackendConfig } from '../backend/config'

export interface NativeAgentEnv {
  /** Backend origin. Native RPC and its privileged token stay server-side. */
  baseUrl: string
}

export function readNativeAgentEnv(): NativeAgentEnv | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
  // This non-secret switch enables native capabilities in local builds. It
  // does not configure a direct browser-to-agent transport or carry a token.
  if (!env.VITE_NATIVE_AGENT_URL?.trim()) return undefined
  return { baseUrl: getBackendConfig().baseUrl }
}
