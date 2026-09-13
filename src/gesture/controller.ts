import type { CameraController, CameraCapabilities } from '../camera/types'
import type {
  GestureIntent,
  GesturePhase,
  GestureStatus,
  GestureTrackingQuality,
  RawHandSample,
} from './types'
import { GESTURE_CONFIG } from './config'
import type { MediaPipeTracker } from './tracker'
import { GestureRecognizer } from './classifier'
import { GestureGate } from './stateMachine'
import { normalizeHands } from './landmarks'

/**
 * Phase 10 — GestureController.
 *
 * Single coordinator owning the full pipeline lifecycle:
 *
 *   WEBCAM → HAND TRACKING → LANDMARK NORMALIZATION → MOVEMENT/POSE ANALYSIS
 *   → CLASSIFICATION → CONFIDENCE CHECK → DEBOUNCE/COOLDOWN → GESTURE
 *   → EXISTING JARVIS ACTION → POST-CONDITION VERIFIED → UI FEEDBACK
 *
 * It reuses the camera subsystem's stream (a single <video> consumer element
 * bound to the SAME live feed — never a second getUserMedia request), runs the
 * bundled local MediaPipe model, and reports honest status snapshots for the
 * taskbar/HUD.
 */

export interface GestureControllerOptions {
  camera: CameraController
  trackerFactory: () => Promise<MediaPipeTracker>
  onIntent: (intent: GestureIntent) => void
  onStatus: (status: GestureStatus) => void
  videoHost?: HTMLElement | null
  config?: Partial<typeof GESTURE_CONFIG>
}

export class GestureController {
  private readonly camera: CameraController
  private readonly trackerFactory: () => Promise<MediaPipeTracker>
  private readonly onIntent: (intent: GestureIntent) => void
  private readonly onStatus: (status: GestureStatus) => void
  private readonly videoHost: HTMLElement | null
  private readonly config: typeof GESTURE_CONFIG

  private tracker: MediaPipeTracker | null = null
  private element: HTMLVideoElement | null = null
  private unsubCamera: (() => void) | null = null
  private ownedStart = false

  private active = false
  private rafId = 0
  private lastInference = 0
  private seq = 0
  private lastStatusEmit = 0

  private recognizer: GestureRecognizer
  private gate: GestureGate

  private error: string | undefined
  private phase: GesturePhase = 'unknown'
  private hands = 0
  private quality: GestureTrackingQuality = 'none'

  constructor(options: GestureControllerOptions) {
    this.camera = options.camera
    this.trackerFactory = options.trackerFactory
    this.onIntent = options.onIntent
    this.onStatus = options.onStatus
    this.videoHost = options.videoHost ?? null
    this.config = { ...GESTURE_CONFIG, ...(options.config ?? {}) }
    this.recognizer = new GestureRecognizer(this.config)
    this.gate = new GestureGate(this.config.gestureCooldownMs)
  }

  get isActive(): boolean {
    return this.active
  }

  get lastGesture(): GestureIntent | null {
    return this.gate.lastGesture
  }

  async start(): Promise<void> {
    if (this.active) return
    const caps = this.camera.capabilities()
    if (!caps.available) {
      this.error = 'camera_unavailable'
      this.emitStatus(true)
      return
    }

    try {
      this.tracker = await this.trackerFactory()
      await this.tracker.ensureLoaded()
    } catch {
      this.error = 'model_load_failed'
      this.emitStatus(true)
      return
    }

    if (typeof document === 'undefined') {
      this.error = 'no_document'
      this.emitStatus(true)
      return
    }

    if (!this.element) {
      const el = document.createElement('video')
      el.setAttribute('playsinline', '')
      el.muted = true
      el.autoplay = false
      this.element = el
    }
    this.camera.bindVideoElement(this.element)
    if (this.videoHost) {
      this.videoHost.appendChild(this.element)
    }

    this.ownedStart = !caps.active
    if (!caps.active) {
      const startResult = await this.camera.start()
      if (!startResult.ok) {
        this.error = startResult.reason ?? 'camera_failed'
        this.camera.unbindVideoElement(this.element)
        this.element.remove()
        this.emitStatus(true)
        return
      }
    }

    this.unsubCamera = this.camera.subscribe((status: CameraCapabilities) => {
      if (!status.active && this.active) {
        this.error = 'camera_stopped'
        this.emitStatus(true)
      } else if (status.active && this.error === 'camera_stopped' && this.active) {
        // Camera came back — the error was transient, clear it and resume.
        this.error = undefined
        this.emitStatus(true)
      }
    })

    this.active = true
    this.error = undefined
    this.seq = 0
    this.recognizer.reset()
    this.gate.reset()
    this.emitStatus(true)
    this.loop()
  }

  stop(): void {
    if (!this.active) return
    this.active = false
    this.cancelLoop()
    if (this.ownedStart) this.camera.stop()
    this.unsubCamera?.()
    this.unsubCamera = null
    if (this.element) {
      this.camera.unbindVideoElement(this.element)
      this.element.remove()
      this.element = null
    }
    this.phase = 'unknown'
    this.hands = 0
    this.quality = 'none'
    this.emitStatus(true)
  }

  dispose(): void {
    this.stop()
    this.tracker?.dispose()
    this.tracker = null
  }

  private loop(): void {
    if (!this.active) return
    this.lastInference = performance.now()
    const tick = (now: number) => {
      if (!this.active) return
      if (now - this.lastInference >= this.config.inferenceIntervalMs) {
        this.lastInference = now
        this.infer(now)
      }
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private cancelLoop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  private infer(now: number): void {
    const video = this.element
    const tracker = this.tracker
    if (!video || !tracker) {
      this.hands = 0
      this.quality = 'none'
      this.phase = 'unknown'
      this.emitStatus(true)
      return
    }

    if (video.readyState < 2 || video.currentTime <= 0) {
      this.emitStatus(true)
      return
    }
    if (video.paused && video.srcObject) {
      void video.play().catch(() => undefined)
    }

    const raw = tracker.detect(video, now)
    const hands = normalizeHands(raw)
    this.hands = hands.length
    const mean = hands.reduce((sum, h) => sum + h.confidence, 0) / Math.max(1, hands.length)
    this.quality = hands.length
      ? mean >= 0.85
        ? 'good'
        : mean >= 0.6
          ? 'ok'
          : 'poor'
      : 'none'

    const sample: RawHandSample = {
      t: ++this.seq,
      ts: now,
      hands,
      quality: mean,
    }

    const candidates = this.recognizer.ingest(sample)
    const intent = this.gate.accept(candidates, now, hands.length, this.quality, this.config.minConfidence)

    if (intent) {
      this.recognizer.notifyFired(intent.gesture)
      this.phase = 'fired'
      this.onIntent(intent)
    } else {
      this.phase = this.gate.phase
    }

    this.emitStatus()
  }

  private emitStatus(force = false): void {
    const now = performance.now()
    if (!force && now - this.lastStatusEmit < 300) return
    this.lastStatusEmit = now
    const status: GestureStatus = {
      active: this.active,
      modelReady: this.tracker?.modelLoaded() ?? false,
      hands: this.hands,
      quality: this.quality,
      phase: this.phase,
      lastGesture: this.gate.lastGesture,
      ...(this.error ? { error: this.error } : {}),
    }
    this.onStatus(status)
  }
}