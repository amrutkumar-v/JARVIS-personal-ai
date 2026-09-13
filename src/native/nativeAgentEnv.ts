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
export interface NativeAgentEnv {
  baseUrl: string
  token: string
}

export function readNativeAgentEnv(): NativeAgentEnv | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
  const baseUrl = env.VITE_NATIVE_AGENT_URL?.trim()
  if (!baseUrl) return undefined
  return { baseUrl, token: env.VITE_NATIVE_AGENT_TOKEN ?? '' }
}