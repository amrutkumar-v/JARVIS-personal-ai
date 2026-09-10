/**
 * Real VisionProvider — OpenAI-compatible vision model (Phase 1.8).
 *
 * The PRODUCTION vision path. It talks to the same OpenAI-compatible endpoint
 * family the text chat already uses (`RemoteProvider`) but over the vision
 * MULTIMODAL surface: a base64 screenshot is sent as an `image_url` content
 * part, and the model is asked to return STRICT structured JSON describing the
 * UI elements it actually sees.
 *
 * Honesty contract (identical to the rest of the vision layer):
 *   - NO fabricated elements: analysis is ONLY what the real model returns.
 *   - Capability flags are derived from the CONFIGURATION, never speculated:
 *     the provider declares OCR + element detection + target localisation
 *     available only when it is configured for a real vision-capable model.
 *   - Provider errors / timeout / cancellation / malformed responses are
 *     surfaced honestly; nothing is ever claimed on a failure.
 *   - The screenshot bytes are TRANSIT ONLY: sent to the configured endpoint on
 *     demand, never persisted or logged locally.
 *
 * The endpoint is a clean OpenAI-compatible `/chat/completions` call — the same
 * wire contract as `RemoteProvider`, so no new HTTP infrastructure is needed.
 * Configuration reads the existing `VITE_JARVIS_*` environment mechanism and
 * never hard-codes a key (the key is `JARVIS_API_KEY` on `import.meta.env`,
 * git-ignored).
 */
import { getVisionConfig } from '../config/vision'
import type { ScreenshotResult } from '../observation'
import { VISUAL_LIMITS } from './limits'
import type { VisionAnalysisOptions, VisionCapabilities, VisionProvider } from './provider'
import type { VisionAnalysisResult, VisualElement, VisualElementType, VisualViewport } from './types'
import { VISUAL_ELEMENT_TYPES } from './types'

/** Provider-safe error kinds the adapter can throw. */
export type RemoteVisionErrorKind = 'config' | 'timeout' | 'network' | 'auth' | 'rate_limit' | 'server' | 'malformed'

export class RemoteVisionError extends Error {
  readonly kind: RemoteVisionErrorKind
  constructor(kind: RemoteVisionErrorKind, message: string) {
    super(message)
    // Timeout/abort maps onto the STANDARD TimeoutError name so the tool layer
    // (analysisNotCompleted) keeps recognising cancelled analyses exactly as
    // it does for the in-memory fake provider. The provider-safe kind stays
    // available on the error for structured callers.
    this.name = kind === 'timeout' ? 'TimeoutError' : 'RemoteVisionError'
    this.kind = kind
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Raw provider element shape (loose; validated + bounded before use). */
interface RawElement {
  label?: unknown
  text?: unknown
  type?: unknown
  x?: unknown
  y?: unknown
  width?: unknown
  height?: unknown
  confidence?: unknown
}

/** Validate + bound one raw element against the analysed viewport. */
function parseElement(raw: unknown, viewport: VisualViewport): VisualElement | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as RawElement
  const type = typeof e.type === 'string' && (VISUAL_ELEMENT_TYPES as readonly string[]).includes(e.type)
    ? (e.type as VisualElementType)
    : 'unknown'
  if (!isFiniteNumber(e.x) || !isFiniteNumber(e.y) || !isFiniteNumber(e.width) || !isFiniteNumber(e.height)) {
    return null
  }
  const x = e.x as number
  const y = e.y as number
  const width = e.width as number
  const height = e.height as number
  if (width <= 0 || height <= 0) return null
  if (x < 0 || y < 0) return null
  if (x + width > viewport.width || y + height > viewport.height) return null
  const confidence = typeof e.confidence === 'number' && Number.isFinite(e.confidence)
    ? Math.min(1, Math.max(0, e.confidence))
    : 0.5
  const clip = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.length === 0) return undefined
    return value.slice(0, VISUAL_LIMITS.MAX_VISUAL_TEXT_LENGTH)
  }
  const label = clip(e.label)
  const text = clip(e.text)
  return {
    id: `el-${x}-${y}-${width}-${height}`,
    type,
    bounds: { x, y, width, height },
    confidence,
    ...(label !== undefined ? { label } : {}),
    ...(text !== undefined ? { text } : {}),
  }
}

/** Parse the model's JSON payload into bounded, validated elements. */
function parseVisionJson(raw: string, viewport: VisualViewport): VisualElement[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RemoteVisionError('malformed', 'The vision model returned malformed JSON.')
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { elements?: unknown }).elements)
      ? (parsed as { elements: unknown[] }).elements
      : null
  if (list === null) {
    throw new RemoteVisionError('malformed', 'The vision model did not return a recognisable element list.')
  }
  const elements: VisualElement[] = []
  for (const raw of list) {
    if (elements.length >= VISUAL_LIMITS.MAX_VISUAL_ELEMENTS) break
    const element = parseElement(raw, viewport)
    if (element) elements.push(element)
  }
  return elements
}

const DEFAULT_TIMEOUT_MS = VISUAL_LIMITS.MAX_VISUAL_ANALYSIS_MS

export interface RemoteVisionProviderOptions {
  baseUrl: string
  model: string
  key: string | null
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
}

/**
 * The exact instruction handed to the vision model (keeps output bounded).
 * Kept as a separate const so it can be referenced in security scans.
 */
export const VISION_PROMPT =
  'Return ONLY a strict JSON object with a single key "elements". ' +
  `"elements" is an array of at most ${VISUAL_LIMITS.MAX_VISUAL_ELEMENTS} objects, each with keys: ` +
  'type (one of: button,input,text,link,checkbox,menu,dialog,icon,unknown), ' +
  'label (short, at most ' + String(VISUAL_LIMITS.MAX_VISUAL_TEXT_LENGTH) + ' chars), ' +
  'text (visible text only, at most ' + String(VISUAL_LIMITS.MAX_VISUAL_TEXT_LENGTH) + ' chars), ' +
  'x, y, width, height (non-negative pixels within the image), confidence (0..1). ' +
  'Report only UI elements you can actually see. Do not invent any. Output nothing else.'

export class RemoteVisionProvider implements VisionProvider {
  readonly id = 'remote-vision'
  private readonly baseUrl: string
  private readonly model: string
  private readonly key: string | null
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number

  constructor(options: RemoteVisionProviderOptions) {
    this.baseUrl = options.baseUrl
    this.model = options.model
    this.key = options.key
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  capabilities(): VisionCapabilities {
    return {
      visionAvailable: true,
      ocrAvailable: true,
      uiElementDetectionAvailable: true,
      targetLocalizationAvailable: true,
    }
  }

  private resolveEndpoint(): string {
    if (this.baseUrl.includes('/chat/completions')) return this.baseUrl
    return `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`
  }

  async analyzeScreenshot(screenshot: ScreenshotResult, options?: VisionAnalysisOptions): Promise<VisionAnalysisResult> {
    if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const url = this.resolveEndpoint()
    const dataUrl = `data:image/png;base64,${screenshot.bytes}`
    const body = {
      model: this.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.key) headers.Authorization = `Bearer ${this.key}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    const onOuterAbort = () => controller.abort()
    if (options?.signal) {
      if (options.signal.aborted) { controller.abort() }
      else { options.signal.addEventListener('abort', onOuterAbort, { once: true }) }
    }
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (options?.signal) options.signal.removeEventListener('abort', onOuterAbort)
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new RemoteVisionError('auth', 'The vision endpoint rejected the configured key.')
        }
        if (res.status === 429) {
          throw new RemoteVisionError('rate_limit', 'The vision endpoint is rate-limited.')
        }
        throw new RemoteVisionError('server', `The vision endpoint returned HTTP ${res.status}.`)
      }
      if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      let json: unknown
      try {
        json = (await res.json()) as unknown
      } catch {
        throw new RemoteVisionError('malformed', 'The vision endpoint returned an unreadable response.')
      }
      if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const content =
        (json as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? ''
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new RemoteVisionError('malformed', 'The vision model returned an empty reply.')
      }
      const viewport: VisualViewport = { width: screenshot.width, height: screenshot.height }
      const elements = parseVisionJson(content.trim(), viewport)
      if (elements.length === 0) {
        throw new RemoteVisionError('malformed', 'The vision model returned no usable UI elements.')
      }
      return {
        viewport,
        elements,
        providerId: this.id,
        modelId: this.model,
        analyzedAt: Date.now(),
      }
    } catch (error) {
      clearTimeout(timer)
      if (options?.signal) options.signal.removeEventListener('abort', onOuterAbort)
      if (error instanceof RemoteVisionError) throw error
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new RemoteVisionError('timeout', 'The vision analysis exceeded its time bound.')
      }
      throw new RemoteVisionError('network', 'Could not reach the vision endpoint.')
    }
  }
}

/**
 * Factory wiring the provider from environment configuration; returns
 * `undefined` when not configured (honest unavailable state).
 *
 * This reads `VITE_JARVIS_VISION_BASE_URL`, `VITE_JARVIS_VISION_MODEL`,
 * and `JARVIS_API_KEY` from `import.meta.env` (populated from `.env.local`
 * at build time). When none are set the app reports visual understanding as
 * unavailable and no visual tools are registered — exactly as Phase 1.7
 * behaved before any real provider was bound.
 */
export function createVisionProviderFromConfig(
  overrides?: Partial<RemoteVisionProviderOptions>,
): RemoteVisionProvider | undefined {
  const config = getVisionConfig()
  if (!config.configured) return undefined
  return new RemoteVisionProvider({
    baseUrl: config.baseUrl,
    model: config.model,
    key: config.key,
    ...overrides,
  })
}