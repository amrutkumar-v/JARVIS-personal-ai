import { describe, expect, it } from 'vitest'
import { resolveClientPoint, screenPointToClient, viewportPointToScreen } from './coords'
import type { VirtualScreen } from '../desktop'
import type { WindowBounds } from '../observation'

const SCREEN: VirtualScreen = { left: 0, top: 0, width: 1920, height: 1080 }
const WINDOW: WindowBounds = { left: 100, top: 200, right: 500, bottom: 600 }

describe('viewportPointToScreen', () => {
  it('maps a viewport point onto the virtual desktop origin', () => {
    const done = viewportPointToScreen({ width: 1920, height: 1080 }, SCREEN, 800, 500)
    expect(done).toEqual({ screen: { x: 800, y: 500 } })
  })

  it('accounts for a negative virtual-screen origin (multi-monitor)', () => {
    const screen: VirtualScreen = { left: -1920, top: -120, width: 1920, height: 1080 }
    const done = viewportPointToScreen({ width: 1920, height: 1080 }, screen, 0, 0)
    expect(done).toEqual({ screen: { x: -1920, y: -120 } })
  })

  it('rejects a point outside the screenshot', () => {
    expect('screen' in viewportPointToScreen({ width: 10, height: 10 }, SCREEN, 10, 0)).toBe(false)
    expect('screen' in viewportPointToScreen({ width: 10, height: 10 }, SCREEN, -1, 0)).toBe(false)
  })

  it('rejects non-finite points', () => {
    expect('screen' in viewportPointToScreen({ width: 10, height: 10 }, SCREEN, NaN, 0)).toBe(false)
    expect('screen' in viewportPointToScreen({ width: 10, height: 10 }, SCREEN, Infinity, 0)).toBe(false)
  })

  it('REJECTS dimension mismatch — never scales coordinates blindly', () => {
    const done = viewportPointToScreen({ width: 800, height: 600 }, SCREEN, 400, 300)
    expect('screen' in done).toBe(false)
    if ('error' in done) expect(done.error).toContain('does not match')
  })
})

describe('screenPointToClient', () => {
  it('subtracts the window origin from an absolute screen point', () => {
    expect(screenPointToClient(WINDOW, { x: 300, y: 400 })).toEqual({ client: { x: 200, y: 200 } })
  })

  it('rejects a point outside the window bounds', () => {
    expect('client' in screenPointToClient(WINDOW, { x: 50, y: 400 })).toBe(false)
    expect('client' in screenPointToClient(WINDOW, { x: 500, y: 400 })).toBe(false)
  })

  it('rejects inverted or non-finite window bounds', () => {
    const inverted: WindowBounds = { left: 500, top: 200, right: 100, bottom: 600 }
    expect('client' in screenPointToClient(inverted, { x: 300, y: 400 })).toBe(false)
    const nanBounds: WindowBounds = { left: NaN, top: 0, right: 10, bottom: 10 }
    expect('client' in screenPointToClient(nanBounds, { x: 1, y: 1 })).toBe(false)
  })

  it('uses EXACT clientBounds when measured (frame offsets absent)', () => {
    // Frame: (100,200)-(500,600). Client area starts below the title bar:
    // a point at the frame's top edge (the title bar) is OUTSIDE the client.
    const clientBounds: WindowBounds = { left: 100, top: 240, right: 500, bottom: 600 }
    expect(screenPointToClient(WINDOW, { x: 300, y: 400 }, clientBounds)).toEqual({ client: { x: 200, y: 160 } })
  })

  it('refuses a screen point in the window FRAME but outside the client area', () => {
    const clientBounds: WindowBounds = { left: 100, top: 240, right: 500, bottom: 600 }
    // y=220 is inside the outer frame but above the client area (title bar).
    const done = screenPointToClient(WINDOW, { x: 300, y: 220 }, clientBounds)
    expect('client' in done).toBe(false)
    if ('error' in done) expect(done.error).toContain('client area')
  })

  it('refuses a point in ANOTHER window surface (multi-window scope guard)', () => {
    // The resolved element sits inside window B, not the selected window.
    const clientBounds: WindowBounds = { left: 100, top: 240, right: 500, bottom: 600 }
    expect('client' in screenPointToClient(WINDOW, { x: 700, y: 400 }, clientBounds)).toBe(false)
    expect('client' in screenPointToClient(WINDOW, { x: 700, y: 400 })).toBe(false)
  })

  it('refuses inverted or non-finite clientBounds', () => {
    const inverted = { left: 500, top: 100, right: 100, bottom: 600 }
    expect('client' in screenPointToClient(WINDOW, { x: 300, y: 400 }, inverted)).toBe(false)
    const nan = { left: NaN, top: 0, right: 10, bottom: 10 }
    expect('client' in screenPointToClient(WINDOW, { x: 1, y: 1 }, nan)).toBe(false)
  })
})

describe('resolveClientPoint (full pipeline)', () => {
  it('viewport → screen → client', () => {
    const done = resolveClientPoint({ width: 1920, height: 1080 }, SCREEN, WINDOW, 300, 400)
    expect(done).toEqual({ client: { x: 200, y: 200 } })
  })

  it('propagates a viewport/screen dimension mismatch', () => {
    const done = resolveClientPoint({ width: 10, height: 10 }, SCREEN, WINDOW, 5, 5)
    expect('client' in done).toBe(false)
  })

  it('propagates an out-of-window screen point', () => {
    const done = resolveClientPoint({ width: 1920, height: 1080 }, SCREEN, WINDOW, 50, 400)
    expect('client' in done).toBe(false)
  })

  it('works with a negative virtual origin and an offset window', () => {
    const screen: VirtualScreen = { left: -1920, top: 0, width: 1920, height: 1080 }
    const window: WindowBounds = { left: -500, top: 50, right: 200, bottom: 500 }
    // viewport (1500, 200) → screen (-420, 200) → inside window → client (80, 150)
    expect(resolveClientPoint({ width: 1920, height: 1080 }, screen, window, 1500, 200)).toEqual({
      client: { x: 80, y: 150 },
    })
  })

  it('uses EXACT clientBounds through the full pipeline', () => {
    // Frame (100,200)-(500,600), client area (100,240)-(500,600).
    const clientBounds: WindowBounds = { left: 100, top: 240, right: 500, bottom: 600 }
    const done = resolveClientPoint({ width: 1920, height: 1080 }, SCREEN, WINDOW, 300, 400, clientBounds)
    expect(done).toEqual({ client: { x: 200, y: 160 } })
  })

  it('refuses a full-pipeline target outside the measured client area', () => {
    const clientBounds: WindowBounds = { left: 100, top: 240, right: 500, bottom: 600 }
    const done = resolveClientPoint({ width: 1920, height: 1080 }, SCREEN, WINDOW, 300, 220, clientBounds)
    expect('client' in done).toBe(false)
  })
})