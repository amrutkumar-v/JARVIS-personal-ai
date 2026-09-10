import { describe, expect, it } from 'vitest'
import { classifyStaleness, screenshotsMatch, windowStateChanged } from './staleness'
import type { ScreenshotResult, WindowBounds, WindowStatus } from '../observation'

/**
 * Phase 1.9 — stale-observation protection: exact identity comparisons that
 * decide whether an observation is still current enough to inject against.
 * Deterministic and never time-based.
 */

const shot = (bytes: string): ScreenshotResult => ({ width: 2, height: 2, format: 'png', bytesLength: bytes.length, bytes })

const SHOT_A = shot('png-a')
const SHOT_B = shot('png-b')

const win = (patch: Partial<WindowStatus> = {}): WindowStatus => ({
  windowId: '1',
  title: 'App',
  pid: 1,
  processName: 'app',
  visible: true,
  minimized: false,
  maximized: false,
  bounds: { left: 0, top: 0, right: 2, bottom: 2 },
  exists: true,
  ...patch,
})

const moved = (b: WindowBounds): WindowStatus =>
  win({ bounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom }, clientBounds: undefined })

describe('screenshotsMatch', () => {
  it('is true for byte-identical captures', () => {
    expect(screenshotsMatch(SHOT_A, { ...SHOT_A })).toBe(true)
  })

  it('is false when the pixels differ', () => {
    expect(screenshotsMatch(SHOT_A, SHOT_B)).toBe(false)
  })

  it('is false when the framing differs', () => {
    expect(screenshotsMatch(SHOT_A, { ...SHOT_A, width: 4 })).toBe(false)
    expect(screenshotsMatch(SHOT_A, { ...SHOT_A, height: 4 })).toBe(false)
    expect(screenshotsMatch(SHOT_A, { ...SHOT_A, format: 'png', bytes: 'a-different-png' })).toBe(false)
  })
})

describe('windowStateChanged', () => {
  it('is false when nothing moved', () => {
    expect(windowStateChanged(win(), win())).toBe(false)
  })

  it('is true when the window moved', () => {
    expect(windowStateChanged(win(), moved({ left: 1, top: 0, right: 3, bottom: 2 }))).toBe(true)
  })

  it('is true when the outer frame resized (bounds change)', () => {
    expect(windowStateChanged(win(), win({ bounds: { left: 0, top: 0, right: 4, bottom: 4 } }))).toBe(true)
  })

  it('is true when the measured clientBounds resize even with identical bounds', () => {
    expect(
      windowStateChanged(win(), win({ clientBounds: { left: 0, top: 1, right: 2, bottom: 2 } })),
    ).toBe(true)
  })

  it('is true when clientBounds appear or disappear', () => {
    expect(windowStateChanged(win(), win({ clientBounds: { left: 0, top: 1, right: 2, bottom: 2 } }))).toBe(true)
    expect(windowStateChanged(win({ clientBounds: { left: 0, top: 1, right: 2, bottom: 2 } }), win())).toBe(true)
  })

  it('is true when existence flips either way', () => {
    expect(windowStateChanged(win(), win({ exists: false }))).toBe(true)
    expect(windowStateChanged(win({ exists: false }), win())).toBe(true)
  })

  it('is false when both windows are gone', () => {
    expect(windowStateChanged(win({ exists: false }), win({ exists: false }))).toBe(false)
  })
})

describe('classifyStaleness', () => {
  it('returns null when the decision identities are all current', () => {
    expect(classifyStaleness(win(), win(), SHOT_A, { ...SHOT_A })).toBeNull()
  })

  it('classifies a closed window first', () => {
    expect(classifyStaleness(win(), win({ exists: false }), SHOT_A, SHOT_B)).toBe('window_closed')
  })

  it('classifies window geometry drift before pixel drift', () => {
    expect(classifyStaleness(win(), moved({ left: 1, top: 0, right: 3, bottom: 2 }), SHOT_A, SHOT_B)).toBe('window_changed')
  })

  it('classifies a pixel change when the window is stable', () => {
    expect(classifyStaleness(win(), win(), SHOT_A, SHOT_B)).toBe('screen_changed')
  })
})