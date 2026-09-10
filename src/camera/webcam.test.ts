import { describe, expect, it } from 'vitest'
import { classifyCameraError, WebCameraController } from './webcam'
import type { CameraCanvasLike, CameraContextLike } from './webcam'

function fakeTrack(stopSpy?: () => void): { stop: () => void } {
  return { stop: stopSpy ?? (() => undefined) }
}

function fakeStream(tracks: Array<{ stop: () => void }> = []): MediaStream {
  return {
    getVideoTracks: () => (tracks[0] ? [{ addEventListener: () => undefined, ...tracks[0] }] : []),
    getTracks: () => tracks,
  } as unknown as MediaStream
}

function fakeCanvas(bytes = 'AAAA'): () => CameraCanvasLike {
  return () =>
    ({
      width: 0,
      height: 0,
      getContext: (_kind: string): CameraContextLike | null => ({ drawImage: () => undefined }),
      toDataURL: (_type: string) => `data:image/png;base64,${bytes}`,
    }) as CameraCanvasLike
}

function rejectedGetUserMedia(name: string): Pick<MediaDevices, 'getUserMedia'> {
  const makeError = () => {
    const e = new Error(name)
    e.name = name
    return e
  }
  return { getUserMedia: () => Promise.reject(makeError()) }
}

describe('classifyCameraError', () => {
  it('maps the real browser failure names onto honest permission states', () => {
    expect(classifyCameraError(Object.assign(new Error('x'), { name: 'NotAllowedError' }))).toBe('denied')
    expect(classifyCameraError(Object.assign(new Error('x'), { name: 'SecurityError' }))).toBe('denied')
    expect(classifyCameraError(Object.assign(new Error('x'), { name: 'NotReadableError' }))).toBe('in-use')
    expect(classifyCameraError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('in-use')
    expect(classifyCameraError(Object.assign(new Error('x'), { name: 'NotFoundError' }))).toBe('incompatible')
    expect(classifyCameraError(Object.assign(new Error('x'), { name: 'OverconstrainedError' }))).toBe('incompatible')
    expect(classifyCameraError(new Error('boom'))).toBe('unavailable')
  })
})

describe('WebCameraController (real getUserMedia surface)', () => {
  it('reports unavailable honestly when no getUserMedia surface exists', async () => {
    const camera = new WebCameraController({ mediaDevices: undefined, canvasFactory: fakeCanvas() })
    expect(camera.capabilities().available).toBe(false)
    const result = await camera.start()
    expect(result.ok).toBe(false)
    expect(result.permission).toBe('unavailable')
  })

  it('starts a real stream and notifies subscribers only with true state', async () => {
    const events: Array<{ active: boolean; permission: string }> = []
    const tracks = [fakeTrack()]
    const camera = new WebCameraController({
      mediaDevices: { getUserMedia: () => Promise.resolve(fakeStream(tracks)) },
      canvasFactory: fakeCanvas(),
    })
    camera.subscribe((status) => events.push({ active: status.active, permission: status.permission }))

    const result = await camera.start()
    expect(result.ok).toBe(true)
    expect(result.permission).toBe('granted')
    expect(camera.capabilities().active).toBe(true)
    expect(events.find((e) => e.active)).toMatchObject({ active: true, permission: 'granted' })
  })

  it('reports permission denied without inventing a stream', async () => {
    const camera = new WebCameraController({
      mediaDevices: rejectedGetUserMedia('NotAllowedError'),
      canvasFactory: fakeCanvas(),
    })
    const result = await camera.start()
    expect(result.ok).toBe(false)
    expect(result.permission).toBe('denied')
    expect(camera.capabilities().active).toBe(false)
  })

  it('reports in-use when the camera is held by another app', async () => {
    const camera = new WebCameraController({
      mediaDevices: rejectedGetUserMedia('NotReadableError'),
      canvasFactory: fakeCanvas(),
    })
    const result = await camera.start()
    expect(result.permission).toBe('in-use')
    expect(camera.capabilities().active).toBe(false)
  })

  it('captures a REAL transient PNG frame from the live feed', async () => {
    const tracks = [fakeTrack()]
    const video = { videoWidth: 320, videoHeight: 240, srcObject: null } as unknown as HTMLVideoElement
    const camera = new WebCameraController({
      mediaDevices: { getUserMedia: () => Promise.resolve(fakeStream(tracks)) },
      canvasFactory: fakeCanvas('c2FtcGxl'),
    })
    camera.setVideoElement(video)
    await camera.start()

    const frame = await camera.captureFrame()
    expect(frame).not.toBeNull()
    expect(frame!.width).toBe(320)
    expect(frame!.height).toBe(240)
    expect(frame!.format).toBe('png')
    expect(frame!.bytes).toBe('c2FtcGxl')
  })

  it('returns null when asked for a frame while the camera is off', async () => {
    const camera = new WebCameraController({ mediaDevices: undefined, canvasFactory: fakeCanvas() })
    const frame = await camera.captureFrame()
    expect(frame).toBeNull()
  })

  it('stop releases every track and clears the preview binding', async () => {
    const stops: string[] = []
    const tracks = [fakeTrack(() => void stops.push('video'))]
    const video = { videoWidth: 320, videoHeight: 240, srcObject: null } as unknown as HTMLVideoElement
    const camera = new WebCameraController({
      mediaDevices: { getUserMedia: () => Promise.resolve(fakeStream(tracks)) },
      canvasFactory: fakeCanvas(),
    })
    camera.setVideoElement(video)
    await camera.start()
    expect(camera.capabilities().active).toBe(true)
    expect(video.srcObject).toBeDefined()

    camera.stop()
    expect(camera.capabilities().active).toBe(false)
    expect(stops.length).toBe(1)
    expect(video.srcObject).toBeNull()
  })

  it('unsubscribe stops a listener from receiving further status', async () => {
    const events: string[] = []
    const camera = new WebCameraController({
      mediaDevices: { getUserMedia: () => Promise.resolve(fakeStream([fakeTrack()])) },
      canvasFactory: fakeCanvas(),
    })
    const off = camera.subscribe((s) => events.push(String(s.active)))
    await camera.start()
    off()
    camera.stop()
    expect(events).toEqual(['true'])
  })
})