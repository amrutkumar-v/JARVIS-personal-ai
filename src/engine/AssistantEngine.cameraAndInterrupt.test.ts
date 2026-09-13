import { describe, expect, it, beforeEach } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from './provider'
import type { EngineOutMessage } from './contracts'
import type { Tool, ToolContext, ToolInput, ToolResult } from '../tools/Tool'
import type { CameraCapabilities, CameraController, CameraPermissionState, CameraStartResult } from '../camera'
import type { ScreenshotResult } from '../observation'
import type { VisionAnalysisOptions, VisionCapabilities, VisionProvider } from '../vision'
import type { VisionAnalysisResult, VisualElement } from '../vision/types'
import type { VoiceOutput } from '../voice/VoiceOutput'
import { useConversationStore } from '../state/conversation.store'
import { useJarvisStore } from '../state/jarvis.store'

/**
 * Phase 2.7 — REAL camera surface commands, STOP SPEAKING and the unified
 * interrupt, driven through the real engine entry point. Nothing here fakes a
 * frame or a stream state: the fake camera/vision seams supply scripted REAL
 * result shapes and the engine replies only from what they actually return.
 */

function stubBrowserStorage(): void {
  const backing = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  ;(globalThis as Record<string, unknown>).window = {
    localStorage,
    setTimeout: (_fn: () => void) => 0,
  }
}

function collect(engine: AssistantEngine): string[] {
  const out: string[] = []
  engine.on((m: EngineOutMessage) => {
    if (m.type === 'transcript') out.push(`[assistant] ${m.text}`)
    if (m.type === 'status') out.push(`[status] ${m.status}`)
    if (m.type === 'notice') out.push(`[notice:${m.kind}] ${m.text}`)
    if (m.type === 'error') out.push(`[error] ${m.message}`)
  })
  return out
}

interface FakeCameraOptions {
  available?: boolean
  startResult?: CameraStartResult
  frames?: ScreenshotResult[]
}

class FakeCamera implements CameraController {
  readonly id = 'fake-camera'
  private active = false
  private permission: CameraPermissionState
  private available: boolean
  private readonly startResult: CameraStartResult
  private readonly frames: ScreenshotResult[]
  startCalls = 0
  stopCalls = 0
  private readonly listeners = new Set<(s: CameraCapabilities) => void>()

  constructor(opts: FakeCameraOptions = {}) {
    this.available = opts.available ?? true
    this.permission = opts.startResult?.permission ?? 'unknown'
    this.startResult = opts.startResult ?? { ok: true, permission: 'granted' }
    this.frames = opts.frames ?? []
  }

  private emit(): void {
    const status: CameraCapabilities = { available: this.available, active: this.active, permission: this.permission }
    for (const l of this.listeners) l(status)
  }

  capabilities(): CameraCapabilities {
    return { available: this.available, active: this.active, permission: this.permission }
  }

  async start(): Promise<CameraStartResult> {
    this.startCalls += 1
    if (this.startResult.ok) {
      this.active = true
      this.permission = 'granted'
      this.emit()
    } else {
      this.permission = this.startResult.permission
    }
    return this.startResult
  }

  stop(): void {
    this.stopCalls += 1
    this.active = false
    if (this.permission !== 'denied') this.permission = 'granted'
    this.emit()
  }

  dispose(): void {
    this.stop()
    this.listeners.clear()
  }

  setVideoElement(_element: HTMLVideoElement | null): void {
    // no-op fake
  }

  bindVideoElement(_element: HTMLVideoElement | null): void {
    // no-op fake
  }

  unbindVideoElement(_element: HTMLVideoElement): void {
    // no-op fake
  }

  async captureFrame(): Promise<ScreenshotResult | null> {
    if (!this.active) return null
    return this.frames[0] ?? null
  }

  subscribe(listener: (status: CameraCapabilities) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

class FakeVision implements VisionProvider {
  readonly id = 'fake-vision'
  testsOnly = true
  received: ScreenshotResult[] = []
  private readonly result: VisionAnalysisResult

  constructor(elements: VisualElement[]) {
    this.result = {
      viewport: { width: 640, height: 480 },
      elements,
      providerId: this.id,
      analyzedAt: 0,
    }
  }

  capabilities(): VisionCapabilities {
    return { visionAvailable: true, ocrAvailable: true, uiElementDetectionAvailable: true, targetLocalizationAvailable: true }
  }

  async analyzeScreenshot(screenshot: ScreenshotResult, _options?: VisionAnalysisOptions): Promise<VisionAnalysisResult> {
    this.received.push(screenshot)
    return this.result
  }
}

class ScriptedProvider implements AIProvider {
  readonly id = 'scripted'
  readonly label = 'Scripted'
  private readonly queue: AIResponse[]

  constructor(script: AIResponse[]) {
    this.queue = [...script]
  }

  async generate(_request: AIRequest): Promise<AIResponse> {
    const next = this.queue.shift()
    if (!next) return { text: 'No more scripted steps.' }
    return next
  }

  isConfigured(): boolean {
    return true
  }

  isReachable(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

/** A tool that blocks on the run's abort signal — the real cancellation path. */
class GatedTool implements Tool {
  readonly id = 'gated_tool'
  readonly category = 'system' as const
  readonly name = 'Gated tool'
  readonly description = 'Blocks until the run is cancelled.'
  readonly permission = 'read_only' as const
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      reason: {
        type: 'string',
        description: 'Any text; the step exists to test run cancellation.',
      },
    },
    required: [],
  }
  readonly requiresPermission = false
  startedResolve!: () => void
  started = new Promise<void>((resolve) => {
    this.startedResolve = resolve
  })
  aborted = false

  canRun(query: string): boolean {
    return /gate/i.test(query)
  }

  async execute(_input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
    this.startedResolve()
    if (ctx.signal?.aborted) {
      this.aborted = true
      return { ok: true, message: 'interrupted before execution started' }
    }
    await new Promise<void>((resolve) => {
      ctx.signal?.addEventListener('abort', () => {
        this.aborted = true
        resolve()
      })
    })
    return { ok: true, message: 'gate released against a cancelled run' }
  }
}

function req(toolId: string, payload: Record<string, unknown> = {}): AIResponse {
  return { text: '', toolRequests: [{ toolId, payload }] }
}

function text(value: string): AIResponse {
  return { text: value }
}

describe('Phase 2.7 — camera surface commands through the engine', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('answers honestly when NO camera surface is bound', async () => {
    const engine = new AssistantEngine({ providers: [] })
    const log = collect(engine)
    await engine.process('turn on the camera')

    expect(log.join('\n')).toContain('[assistant] I have no webcam surface bound')
  })

  it('turns the camera on through the REAL controller when available', async () => {
    const camera = new FakeCamera()
    const engine = new AssistantEngine({ providers: [], camera })
    const log = collect(engine)
    await engine.process('turn on the camera')

    expect(camera.startCalls).toBe(1)
    expect(log.join('\n')).toContain('[assistant] The camera is on.')
    expect(useJarvisStore.getState().lastAssistantText).toContain('The camera is on.')
  })

  it('reports the REAL denied state instead of pretending success', async () => {
    const camera = new FakeCamera({ startResult: { ok: false, permission: 'denied', reason: 'The browser denied camera access. Allow the webcam for this site, then ask again.' } })
    const engine = new AssistantEngine({ providers: [], camera })
    const log = collect(engine)
    await engine.process('turn on the camera')

    expect(camera.startCalls).toBe(1)
    expect(log.join('\n')).toContain('I could not start the camera')
    expect(log.join('\n')).toContain('denied')
  })

  it('turns the camera off and stops the real stream when running', async () => {
    const camera = new FakeCamera()
    const engine = new AssistantEngine({ providers: [], camera })
    await engine.process('turn on the camera')
    const log = collect(engine)
    await engine.process('turn off the camera')

    expect(camera.stopCalls).toBe(1)
    expect(log.join('\n')).toContain('[assistant] Camera off.')
  })

  it('does not claim to see without a vision model configured', async () => {
    const camera = new FakeCamera({ frames: [{ width: 640, height: 480, format: 'png', bytesLength: 4, bytes: 'AAAA' }] })
    const engine = new AssistantEngine({ providers: [], camera })
    await engine.process('turn on the camera')
    const log = collect(engine)
    await engine.process('what do you see')

    expect(log.join('\n')).toContain('no vision model is configured')
    expect(log.join('\n')).toContain('I genuinely cannot tell you')
  })

  it('feeds the REAL captured frame to vision and reports only what it sees', async () => {
    const camera = new FakeCamera({ frames: [{ width: 640, height: 480, format: 'png', bytesLength: 4, bytes: 'AAAA' }] })
    const vision = new FakeVision([
      { id: 'a', type: 'text', text: 'Hello', bounds: { x: 0, y: 0, width: 10, height: 10 }, confidence: 0.9 },
    ])
    const engine = new AssistantEngine({ providers: [], camera, vision })
    await engine.process('turn on the camera')
    const log = collect(engine)
    await engine.process('what do you see')

    expect(vision.received.length).toBe(1)
    expect(vision.received[0].bytes).toBe('AAAA')
    expect(log.join('\n')).toContain('I see 1 element')
    expect(log.join('\n')).toContain('text "Hello"')
  })

  it('requires the camera to be ON before looking at the feed', async () => {
    const engine = new AssistantEngine({ providers: [], camera: new FakeCamera() })
    const log = collect(engine)
    await engine.process('what do you see')

    expect(log.join('\n')).toContain('The camera is not running')
  })

  it('starts every camera command on a fresh run (state machine resets)', async () => {
    const camera = new FakeCamera()
    const engine = new AssistantEngine({ providers: [], camera })
    await engine.process('turn on the camera')
    await engine.process('turn off the camera')
    await engine.process('turn on the camera')
    expect(camera.startCalls).toBe(2)
    expect(camera.stopCalls).toBe(1)
  })
})

describe('Phase 2.7 — STOP SPEAKING', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    useJarvisStore.getState().setIsSpeaking(false)
  })

  it('interrupts the in-flight TTS stream and returns to idle', async () => {
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([text('Hello there.')])] })
    const stops: string[] = []
    const voice: VoiceOutput = {
      // A REAL utterance stays live until the engine stops it (never completes
      // synchronously, so `isSpeaking` reflects the in-flight stream).
      speak: () => {
        /* utterance is live — nothing resolves it yet */
      },
      stop: () => stops.push('stopped'),
      pickVoice: () => null,
      get speaking() { return true },
      get supported() { return true },
    }
    engine.attach(voice)
    const log = collect(engine)
    await engine.process('wave')

    // The engine itself reports the real in-flight speaking state.
    expect(useJarvisStore.getState().isSpeaking).toBe(true)
    expect(stops.length).toBe(0)

    engine.stopSpeaking()
    expect(stops.length).toBe(1)
    expect(useJarvisStore.getState().isSpeaking).toBe(false)
    expect(log.join('\n')).toContain('[status] idle')
  })
})

describe('Phase 2.7 — unified interrupt (STOP TASK)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('cancels a running multi-step task and reports cancelled-after-N steps', async () => {
    const gated = new GatedTool()
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([req('gated_tool'), text('finished')])] })
    engine.registerTool(gated)
    const log = collect(engine)

    const run = engine.process('open the gate')
    await gated.started
    engine.cancelCurrentTask()

    await run
    const joined = log.join('\n')
    expect(joined).toContain('[status] cancelling')
    expect(joined).toContain('[status] cancelled')
    expect(joined).toContain('Cancelled after 1 completed step')
    expect(joined).not.toContain('finished')
    expect(gated.aborted).toBe(true)
  })

  it('cancelling mid-run leaves a fresh command fully runnable afterwards', async () => {
    const gated = new GatedTool()
    const engine = new AssistantEngine({
      providers: [new ScriptedProvider([req('gated_tool'), text('second answer')])],
    })
    engine.registerTool(gated)

    const run = engine.process('open the gate')
    await gated.started
    engine.cancelCurrentTask()
    await run

    const log = collect(engine)
    await engine.process('open the gate again')
    expect(log.join('\n')).toContain('[assistant] second answer')
  })
})