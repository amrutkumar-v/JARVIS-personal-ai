/**
 * Real browser webcam controller (Phase 2.7).
 *
 * This is the ONLY implementation of the camera surface: it calls the REAL
 * `navigator.mediaDevices.getUserMedia` API, classifies the REAL browser
 * permission/device outcomes into honest states, and snapshots the LIVE video
 * element to PNG. It never fakes a frame, never pretends a camera exists, and
 * never turns the microphone on (`audio: false` everywhere).
 *
 * Test seams: `mediaDevices` and `canvasFactory` can be injected so the
 * permission classification and capture path are covered without a real
 * webcam. Default production behaviour uses the real navigator surface (and
 * reports `unavailable` honestly when none exists).
 */
import type { ScreenshotResult } from '../observation'
import type { CameraCapabilities, CameraController, CameraPermissionState, CameraStartResult } from './types'

export const CAMERA_UNAVAILABLE_MESSAGE =
  'No webcam surface is available in this browser or tab (getUserMedia needs a secure context).'

/** Minimal canvas surface; the real default is `document.createElement('canvas')`. */
export interface CameraCanvasLike {
  width: number
  height: number
  getContext(kind: '2d'): CameraContextLike | null
  toDataURL(type: string): string
}

export interface CameraContextLike {
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void
}

export interface WebCameraSeams {
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>
  canvasFactory?: () => CameraCanvasLike
}

function realMediaDevices(): Pick<MediaDevices, 'getUserMedia'> | undefined {
  if (typeof navigator === 'undefined') return undefined
  const md = (navigator as { mediaDevices?: MediaDevices }).mediaDevices
  return md && typeof md.getUserMedia === 'function' ? md : undefined
}

function realCanvasFactory(): () => CameraCanvasLike {
  return (): CameraCanvasLike => {
    if (typeof document === 'undefined') {
      throw new Error('No canvas surface in this environment.')
    }
    const canvas = document.createElement('canvas')
    return canvas as unknown as CameraCanvasLike
  }
}

/** Map a real getUserMedia failure onto an honest, bounded permission state. */
export function classifyCameraError(error: unknown): CameraPermissionState {
  const name = error instanceof Error ? error.name : typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: unknown }).name)
    : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied'
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'TypeError':
      return 'incompatible'
    case 'NotReadableError':
    case 'AbortError':
      return 'in-use'
    default:
      return 'unavailable'
  }
}

const PERMISSION_REASON: Record<CameraPermissionState, string | undefined> = {
  unknown: 'Camera permission has not been requested yet.',
  granted: undefined,
  denied: 'The browser denied camera access. Allow the webcam for this site, then ask again.',
  'in-use': 'The camera is already in use — another page or application holds it.',
  incompatible: 'No usable camera was found that matches the request.',
  unavailable: 'No webcam surface is available in this tab.',
}

export class WebCameraController implements CameraController {
  readonly id = 'browser-webcam'
  private readonly mediaDevices: Pick<MediaDevices, 'getUserMedia'> | undefined
  private readonly canvasFactory: () => CameraCanvasLike
  private stream: MediaStream | null = null
  private videoElement: HTMLVideoElement | null = null
  private permission: CameraPermissionState = 'unknown'
  private available: boolean
  private readonly listeners = new Set<(status: CameraCapabilities) => void>()

  constructor(seams: WebCameraSeams = {}) {
    this.mediaDevices = seams.mediaDevices ?? realMediaDevices()
    this.canvasFactory = seams.canvasFactory ?? realCanvasFactory()
    this.available = this.mediaDevices !== undefined
    if (this.available) {
      // When the Permissions API exposes camera state, start from the REAL
      // state instead of guessing. Bounded and best-effort (not supported on
      // every browser).
      this.probePermission().catch(() => undefined)
    }
  }

  private set(active: boolean, permission: CameraPermissionState, reason?: string): CameraCapabilities {
    const status: CameraCapabilities = { available: this.available, active, permission, ...(reason ? { reason } : {}) }
    this.permission = permission
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch {
        // A UI listener must never break the camera surface.
      }
    }
    return status
  }

  capabilities(): CameraCapabilities {
    return { available: this.available, active: this.stream !== null, permission: this.permission }
  }

  private async probePermission(): Promise<void> {
    if (typeof navigator === 'undefined') return
    const permissions = (navigator as { permissions?: { query(desc: { name: string }): Promise<{ state: string }> } }).permissions
    if (!permissions?.query) return
    try {
      const result = await permissions.query({ name: 'camera' as string })
      if (result.state === 'denied') this.permission = 'denied'
      else if (result.state === 'granted') this.permission = 'granted'
    } catch {
      // Permissions API unsupported for camera — stay on the observed state.
    }
  }

  async start(): Promise<CameraStartResult> {
    if (!this.mediaDevices) {
      return { ok: false, permission: 'unavailable', reason: CAMERA_UNAVAILABLE_MESSAGE }
    }
    if (this.stream) {
      return { ok: true, permission: 'granted' }
    }
    // VIDEO ONLY — the camera never captures audio.
    try {
      const stream = await this.mediaDevices.getUserMedia({ video: true, audio: false })
      this.releaseStream()
      this.stream = stream
      if (this.videoElement) {
        try {
          this.videoElement.srcObject = stream
        } catch {
          // srcObject unsupported — the preview element simply stays empty.
        }
      }
      const videoTrack = stream.getVideoTracks()[0]
      videoTrack?.addEventListener('ended', () => {
        // The OS or another app closed the camera — report the honest state.
        this.releaseStream()
        this.set(false, 'in-use', PERMISSION_REASON['in-use'])
        this.permission = 'unknown'
        this.set(false, 'unknown')
      })
      // Only a REAL acquired stream is ever reported as active.
      this.set(true, 'granted')
      return { ok: true, permission: 'granted' }
    } catch (error) {
      const permission = classifyCameraError(error)
      this.set(false, permission, PERMISSION_REASON[permission])
      return { ok: false, permission, reason: PERMISSION_REASON[permission] }
    }
  }

  private releaseStream(): void {
    const tracks = this.stream?.getTracks() ?? []
    for (const track of tracks) {
      try {
        track.stop()
      } catch {
        // Already stopped — fine.
      }
    }
    if (this.videoElement) {
      try {
        this.videoElement.srcObject = null
      } catch {
        // Ignore — the preview element may already be gone.
      }
    }
    this.stream = null
  }

  stop(): void {
    if (!this.stream) {
      this.set(false, this.permission)
      return
    }
    this.releaseStream()
    this.set(false, 'granted')
  }

  dispose(): void {
    this.stop()
    this.videoElement = null
    this.listeners.clear()
  }

  setVideoElement(element: HTMLVideoElement | null): void {
    if (this.videoElement && this.stream) {
      try {
        this.videoElement.srcObject = null
      } catch {
        // Ignore — old preview element may already be gone.
      }
    }
    this.videoElement = element
    if (element && this.stream) {
      try {
        element.srcObject = this.stream
      } catch {
        // Ignore — preview binding is best-effort; capture uses the stream.
      }
    }
  }

  async captureFrame(): Promise<ScreenshotResult | null> {
    const video = this.videoElement
    if (!this.stream || !video) return null
    const width = video.videoWidth ?? 0
    const height = video.videoHeight ?? 0
    if (!width || !height) return null
    let canvas: CameraCanvasLike
    try {
      canvas = this.canvasFactory()
    } catch {
      return null
    }
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(video, 0, 0, width, height)
    const dataUrl = canvas.toDataURL('image/png')
    const bytes = dataUrl.slice(dataUrl.indexOf(',') + 1)
    if (!bytes) return null
    return { width, height, format: 'png', bytesLength: bytes.length, bytes }
  }

  subscribe(listener: (status: CameraCapabilities) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}