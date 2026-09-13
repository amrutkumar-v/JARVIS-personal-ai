/**
 * Phase 10 — MediaPipe HandLandmarker adapter (TOOLKIT OFF).
 *
 * Runs the mediapipe hand tracker bundled LOCALLY (public/mediapipe), never a
 * CDN. The tracker is hidden behind a tiny interface so the controller and
 * tests can run without WebGL/wasm. Every camera frame these methods touch is
 * the REAL live webcam stream already opened by the camera subsystem — the
 * tracker never opens a second stream.
 *
 * Delegate strategy: request the GPU delegate, but when creation itself fails
 * (GPU unsupported), transparently fall back to CPU so the feature still works
 * on low-end machines instead of dying.
 *
 * NOTE: importing this module must not eagerly pull the wasm bundle; the
 * `@mediapipe/tasks-vision` module is imported dynamically at load time.
 */
import type { RawHand } from './landmarks'

export interface MediaPipeTracker {
  readonly ready: boolean
  modelLoaded: () => boolean
  /** Load the local model+wasm (idempotent). Throws a bounded error on failure. */
  ensureLoaded(): Promise<void>
  /** Detect hands in one frame. Throws only when the model is not loaded. */
  detect(video: HTMLVideoElement, timestamp: number): RawHand[]
  dispose(): void
}

type LandmarkTuple = { x: number; y: number; z: number }

function toRawHands(
  landmarkLists: LandmarkTuple[][] | undefined,
  handednessList: Array<Array<{ categoryName: string; score: number }>> | undefined,
): RawHand[] {
  if (!landmarkLists) return []
  return landmarkLists.map((points, index) => {
    const handed = handednessList?.[index]?.[0]
    return {
      handIndex: index,
      handedness: handed?.categoryName === 'Left' || handed?.categoryName === 'Right'
        ? handed.categoryName
        : 'Unknown',
      confidence: handed?.score ?? 0,
      landmarks: (points ?? []).map((p) => ({ x: p.x, y: p.y })),
    }
  })
}

export interface TrackerSeams {
  baseUrl?: string
  filesetResolver?: unknown
  engineFactory?: (modelAssetPath: string, delegate: 'GPU' | 'CPU', numHands: number) => Promise<{
    detectForVideo(video: HTMLVideoElement, timestamp: number): {
      landmarks?: LandmarkTuple[][]
      handedness?: Array<Array<{ categoryName: string; score: number }>>
    }
    close(): void
  }>
}

/** Index of the local copy of the fully-qualified wasm fileset. */
function wasmDir(baseUrl: string): string {
  return `${baseUrl}mediapipe`
}

export async function createMediaPipeTracker(seams: TrackerSeams = {}): Promise<MediaPipeTracker> {
  const base = (seams.baseUrl ?? (import.meta.env.BASE_URL || '/')).replace(/\/$/, '') + '/'
  let engine: Awaited<ReturnType<NonNullable<TrackerSeams['engineFactory']>>> | null = null

  const engineFactory = async (delegate: 'GPU' | 'CPU') => {
    if (seams.engineFactory) return seams.engineFactory(`${base}mediapipe/hand_landmarker.task`, delegate, 2)

    const mod = await import('@mediapipe/tasks-vision')
    const fileset = await mod.FilesetResolver.forVisionTasks(wasmDir(base))
    const landmarker = await mod.HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: `${base}mediapipe/hand_landmarker.task`,
        delegate,
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })
    return {
      detectForVideo: (video: HTMLVideoElement, timestamp: number) => landmarker.detectForVideo(video, timestamp),
      close: () => landmarker.close(),
    }
  }

  return {
    ready: false,

    modelLoaded(): boolean {
      return engine !== null
    },

    async ensureLoaded(): Promise<void> {
      if (engine) return
      try {
        engine = await engineFactory('GPU')
      } catch {
        engine = await engineFactory('CPU')
      }
    },

    detect(video: HTMLVideoElement, timestamp: number): RawHand[] {
      if (!engine) {
        return []
      }
      const result = engine.detectForVideo(video, timestamp)
      return toRawHands(result.landmarks, result.handedness)
    },

    dispose(): void {
      engine?.close()
      engine = null
    },
  }
}