import { describe, expect, it } from 'vitest'
import { clampZoom, stepZoom, atBounds, ENVIRONMENT_ZOOM_BOUNDS } from './zoom'

describe('zoom domain', () => {
  it('clamps NaN to the default level', () => {
    expect(clampZoom(Number.NaN, ENVIRONMENT_ZOOM_BOUNDS.arc)).toBe(1)
  })

  it('clamps below-min and above-max levels to the environment window', () => {
    const bounds = ENVIRONMENT_ZOOM_BOUNDS.arc
    expect(clampZoom(0.1, bounds)).toBe(bounds.min)
    expect(clampZoom(99, bounds)).toBe(bounds.max)
  })

  it('steps up and down multiplicatively within bounds', () => {
    const bounds = ENVIRONMENT_ZOOM_BOUNDS.arc
    const up = stepZoom(1, 1, bounds)
    expect(up.level).toBeGreaterThan(1)
    expect(up.clamped).toBe(false)
    const down = stepZoom(1, -1, bounds)
    expect(down.level).toBeLessThan(1)
  })

  it('reports an honest bound when already at the edge', () => {
    const bounds = ENVIRONMENT_ZOOM_BOUNDS.arc
    expect(atBounds(bounds.max, 1, bounds)).toBe('max')
    expect(atBounds(bounds.min, -1, bounds)).toBe('min')
    expect(atBounds(bounds.min + 0.001, -1, bounds)).toBe(null)
  })

  it('stepZoom clamps instead of overflowing', () => {
    const bounds = ENVIRONMENT_ZOOM_BOUNDS.arc
    const boom = stepZoom(bounds.max, 1, bounds)
    expect(boom.level).toBe(bounds.max)
    expect(boom.clamped).toBe(true)
  })
})