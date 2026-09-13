import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ZOOM } from './zoom'
import { useZoomStore, levelFor } from './zoomStore'

beforeEach(() => {
  const s = useZoomStore.getState()
  s.setZoom('arc', DEFAULT_ZOOM)
  s.setZoom('astra', DEFAULT_ZOOM)
})

describe('zoom store', () => {
  it('starts every environment at the default level', () => {
    expect(levelFor('arc')).toBe(DEFAULT_ZOOM)
    expect(levelFor('tunnel')).toBe(DEFAULT_ZOOM)
  })

  it('adjustZoom in increments the real level', () => {
    const before = levelFor('arc')
    const result = useZoomStore.getState().adjustZoom('arc', 1)
    expect(result.moved).toBe(true)
    expect(result.after).toBeGreaterThan(before)
    expect(levelFor('arc')).toBe(result.after)
  })

  it('honestly reports the maximum bound when reached', () => {
    let result = useZoomStore.getState().adjustZoom('arc', 1)
    let guard = 0
    while (result.moved && guard < 50) {
      result = useZoomStore.getState().adjustZoom('arc', 1)
      guard += 1
    }
    expect(result.bound).toBe('max')
    expect(result.moved).toBe(false)
    expect(levelFor('arc')).toBe(useZoomStore.getState().zoomByEnvironment.arc)
  })

  it('honestly reports the minimum bound when reached', () => {
    let result = useZoomStore.getState().adjustZoom('arc', -1)
    let guard = 0
    while (result.moved && guard < 50) {
      result = useZoomStore.getState().adjustZoom('arc', -1)
      guard += 1
    }
    expect(result.bound).toBe('min')
    expect(result.moved).toBe(false)
  })

  it('setZoom clamps into the environment window', () => {
    const result = useZoomStore.getState().setZoom('control', 99)
    expect(result.after).toBeLessThanOrEqual(1.6)
    expect(levelFor('control')).toBe(result.after)
  })

  it('resetZoom restores the default', () => {
    useZoomStore.getState().adjustZoom('astra', 1)
    const result = useZoomStore.getState().resetZoom('astra')
    expect(result.after).toBe(DEFAULT_ZOOM)
    expect(levelFor('astra')).toBe(DEFAULT_ZOOM)
  })
})