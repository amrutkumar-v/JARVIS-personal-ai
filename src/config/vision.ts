/**
 * Vision provider configuration — Phase 1.8.
 *
 * Reuses the same `JARVIS_API_KEY` and (optionally) the same base URL as the
 * text AI provider, but with a separate model declaration for the vision
 * endpoint. A multimodal model (e.g. `gpt-4o`) is required. If no vision URL
 * is configured, the vision layer is *honestly unavailable* — never faked.
 *
 * Configuration (all optional — when unset the provider is simply absent):
 *   `VITE_JARVIS_VISION_BASE_URL`  — OpenAI-compatible endpoint (fallback: same as AI)
 *   `VITE_JARVIS_VISION_MODEL`     — model name (required for the provider to exist)
 *   `JARVIS_API_KEY`               — key (shared with the text provider, .env.local)
 */

export interface VisionConfig {
  configured: boolean
  baseUrl: string
  model: string
  key: string | null
}

function envString(name: string): string | undefined {
  return (import.meta.env as Record<string, string | undefined>)?.[name]
}

let cached: VisionConfig | null = null

export function getVisionConfig(): VisionConfig {
  if (cached) return cached
  const aiBaseUrl = envString('VITE_JARVIS_AI_BASE_URL')?.trim() || ''
  const baseUrl = envString('VITE_JARVIS_VISION_BASE_URL')?.trim() || aiBaseUrl
  const model = envString('VITE_JARVIS_VISION_MODEL')?.trim() || ''
  const key = envString('JARVIS_API_KEY')?.trim() || null
  cached = {
    configured: Boolean(baseUrl && model),
    baseUrl,
    model,
    key,
  }
  return cached
}

/** Reset the singleton (tests only — must never be called by production). */
export function resetVisionConfigCache(): void {
  cached = null
}