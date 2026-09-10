import { describe, expect, it, vi } from 'vitest'
import { RemoteVisionProvider, RemoteVisionError, createVisionProviderFromConfig } from '../vision'
import { resetVisionConfigCache } from '../config/vision'
import { VISUAL_LIMITS } from '../vision/limits'
import type { ScreenshotResult } from '../observation'

/**
 * Phase 1.8 — REAL VisionProvider (OpenAI-compatible vision endpoint).
 *
 * The provider under test performs exactly ONE network call per analysis to
 * the configured endpoint, sends the screenshot ONLY as a data-URI image_url
 * and the key ONLY in the Authorization header, validates + bounds every
 * element it parses back, and maps every failure onto provider-safe errors —
 * never fabricating a result.
 */

const ENV = import.meta.env as Record<string, string | undefined>

function shot(width = 1920, height = 1080, bytes = 'QUJDRA=='): ScreenshotResult {
  return { width, height, format: 'png', bytesLength: bytes.length, bytes }
}

function jsonResponse(status: number, body: unknown, ok = status >= 200 && status < 300) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response
}

function mockFetch(fetchImpl: ReturnType<typeof vi.fn>): void {
  ;(globalThis as Record<string, unknown>).fetch = fetchImpl
}

function collectRequests(fetchImpl: ReturnType<typeof vi.fn>): Array<{ url: unknown; init: RequestInit }> {
  return fetchImpl.mock.calls.map(([url, init]) => ({ url, init }))
}

function element(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'button', label: 'OK', x: 10, y: 20, width: 100, height: 40, confidence: 0.95, ...overrides }
}

function validBody(elements: unknown[] = [element()]): unknown {
  return { choices: [{ message: { content: JSON.stringify({ elements }) } }] }
}

describe('createVisionProviderFromConfig — config-driven presence', () => {
  it('returns undefined (honest unavailable) when no vision endpoint is configured', () => {
    delete ENV.VITE_JARVIS_VISION_BASE_URL
    delete ENV.VITE_JARVIS_VISION_MODEL
    resetVisionConfigCache()
    expect(createVisionProviderFromConfig()).toBeUndefined()
  })

  it('returns a real provider when base URL + model are configured', () => {
    ENV.VITE_JARVIS_VISION_BASE_URL = 'https://vision.example.com/v1'
    ENV.VITE_JARVIS_VISION_MODEL = 'vision-model'
    ENV.JARVIS_API_KEY = 'test-key'
    resetVisionConfigCache()
    const provider = createVisionProviderFromConfig()
    expect(provider).toBeInstanceOf(RemoteVisionProvider)
    expect(provider?.id).toBe('remote-vision')
  })
})

describe('RemoteVisionProvider', () => {
  it('reports HONEST all-capabilities when configured (config-driven, never speculated)', () => {
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k' })
    expect(provider.capabilities()).toEqual({
      visionAvailable: true,
      ocrAvailable: true,
      uiElementDetectionAvailable: true,
      targetLocalizationAvailable: true,
    })
  })

  it('appends /chat/completions to a bare base URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, validBody()))
    mockFetch(fetchImpl)
    const provider = new RemoteVisionProvider({ baseUrl: 'https://vision.example.com/v1', model: 'm', key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    await provider.analyzeScreenshot(shot())
    const [request] = collectRequests(fetchImpl)
    expect(request.url).toBe('https://vision.example.com/v1/chat/completions')
  })

  it('leaves an already-endpointed base URL untouched', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, validBody()))
    mockFetch(fetchImpl)
    const provider = new RemoteVisionProvider({
      baseUrl: 'https://vision.example.com/v1/chat/completions',
      model: 'm',
      key: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await provider.analyzeScreenshot(shot())
    const [request] = collectRequests(fetchImpl)
    expect(request.url).toBe('https://vision.example.com/v1/chat/completions')
  })

  it('sends the screenshot ONLY as a data-URI image_url and the key ONLY in the Authorization header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, validBody()))
    mockFetch(fetchImpl)
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'vision-model', key: 'secret-key', fetchImpl: fetchImpl as unknown as typeof fetch })
    await provider.analyzeScreenshot(shot())
    const [request] = collectRequests(fetchImpl)
    expect((request.init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key')
    expect((request.init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    const body = JSON.parse(request.init.body as string)
    expect(body.model).toBe('vision-model')
    const content = body.messages[0].content
    const image = content.find((c: { type: string }) => c.type === 'image_url')
    expect(image.image_url.url).toBe('data:image/png;base64,QUJDRA==')
    const text = content.find((c: { type: string }) => c.type === 'text')
    expect(text.text).toContain('elements')
  })

  it('parses a valid envelope into bounded elements with the analysed viewport', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, validBody([element({ type: 'input', label: 'Name', text: 'Ada' })])),
    )
    mockFetch(fetchImpl)
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await provider.analyzeScreenshot(shot())
    expect(result.providerId).toBe('remote-vision')
    expect(result.modelId).toBe('m')
    expect(result.viewport).toEqual({ width: 1920, height: 1080 })
    expect(result.elements).toHaveLength(1)
    expect(result.elements[0]).toMatchObject({
      type: 'input',
      label: 'Name',
      text: 'Ada',
      bounds: { x: 10, y: 20, width: 100, height: 40 },
      confidence: 0.95,
    })
  })

  it('accepts a 2-key elements envelope and drops envelope-level garbage per element', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        200,
        validBody([
          element(),
          { type: 'button', x: 5, y: 5, width: 1, height: 1 }, // no label/text — still actionable
          { type: 'button', x: -5, y: 0, width: 5, height: 5 }, // off-canvas → dropped
          { type: 'button', x: 0, y: 0, width: 0, height: 5 }, // zero area → dropped
          { type: 'not-a-type', x: 0, y: 0, width: 2, height: 2 }, // unknown type
          'garbage', // non-object → dropped
          null, // dropped
        ]),
      ),
    )
    mockFetch(fetchImpl)
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await provider.analyzeScreenshot(shot())
    expect(result.elements).toHaveLength(3)
    expect(result.elements[0].type).toBe('button')
    expect(result.elements[1].type).toBe('button')
    expect(result.elements[2].type).toBe('unknown')
  })

  it('caps the parsed list at MAX_VISUAL_ELEMENTS and clips text to MAX_VISUAL_TEXT_LENGTH', async () => {
    const many = Array.from({ length: VISUAL_LIMITS.MAX_VISUAL_ELEMENTS + 20 }, (_, i) =>
      element({ x: 0, y: i, width: 10, height: 10, label: 'x'.repeat(500), text: 'y'.repeat(500) }),
    )
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, validBody(many)))
    mockFetch(fetchImpl)
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await provider.analyzeScreenshot(shot())
    expect(result.elements.length).toBeLessThanOrEqual(VISUAL_LIMITS.MAX_VISUAL_ELEMENTS)
    for (const e of result.elements) {
      expect((e.label ?? '').length).toBeLessThanOrEqual(VISUAL_LIMITS.MAX_VISUAL_TEXT_LENGTH)
      expect((e.text ?? '').length).toBeLessThanOrEqual(VISUAL_LIMITS.MAX_VISUAL_TEXT_LENGTH)
    }
  })

  it('clamps confidence into [0,1] and defaults a missing value to 0.5', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, validBody([element({ confidence: 3 }), element({ confidence: -1 }), element({ confidence: undefined })])))
    mockFetch(fetchImpl)
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await provider.analyzeScreenshot(shot())
    expect(result.elements.map((e) => e.confidence)).toEqual([1, 0, 0.5])
  })

  it('maps 401/403 → auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, {}))
    mockFetch(fetchImpl)
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(provider.analyzeScreenshot(shot())).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps 429 → rate_limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, {}))
    mockFetch(fetchImpl)
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(provider.analyzeScreenshot(shot())).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps 5xx → server', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, {}))
    mockFetch(fetchImpl)
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(provider.analyzeScreenshot(shot())).rejects.toMatchObject({ kind: 'server' })
  })

  it('maps a network rejection → network', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    mockFetch(fetchImpl)
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(provider.analyzeScreenshot(shot())).rejects.toMatchObject({ kind: 'network' })
  })

  it('maps an unreadable response body → malformed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => Promise.reject(new Error('bad')) } as unknown as Response)
    mockFetch(fetchImpl)
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(provider.analyzeScreenshot(shot())).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('maps a non-JSON model content → malformed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: 'not json' } }] }))
    mockFetch(fetchImpl)
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(provider.analyzeScreenshot(shot())).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('maps an empty reply → malformed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: '   ' } }] }))
    mockFetch(fetchImpl)
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(provider.analyzeScreenshot(shot())).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('maps an unrecognisable envelope and a fully-dropped element list → malformed', async () => {
    const badEnvelope = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }))
    mockFetch(badEnvelope)
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k', fetchImpl: badEnvelope as unknown as typeof fetch })
    await expect(provider.analyzeScreenshot(shot())).rejects.toMatchObject({ kind: 'malformed' })

    const nonEmpty = vi.fn().mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: JSON.stringify({ elements: [{}] }) } }] }))
    const provider2 = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k', fetchImpl: nonEmpty as unknown as typeof fetch })
    await expect(provider2.analyzeScreenshot(shot())).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('surfaces an already-aborted run as a cancellation (never fabricates)', async () => {
    const fetchImpl = vi.fn()
    mockFetch(fetchImpl)
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    const signal = AbortSignal.abort()
    await expect(provider.analyzeScreenshot(shot(), { signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('cancels an in-flight request when the run signal aborts', async () => {
    const controller = new AbortController()
    let fetchRejected = false
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            fetchRejected = true
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }),
    )
    const provider = new RemoteVisionProvider({ baseUrl: 'https://x/v1', model: 'm', key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    const pending = provider.analyzeScreenshot(shot(), { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    expect(fetchRejected).toBe(true)
  })

  it('times out an in-flight request after requestTimeoutMs', async () => {
    let fetchRejected = false
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            fetchRejected = true
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }),
    )
    const provider = new RemoteVisionProvider({
      baseUrl: 'https://x/v1',
      model: 'm',
      key: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestTimeoutMs: 5,
    })
    await expect(provider.analyzeScreenshot(shot())).rejects.toBeInstanceOf(RemoteVisionError)
    expect(fetchRejected).toBe(true)
  })
})