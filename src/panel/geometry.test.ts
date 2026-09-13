import { describe, expect, it } from 'vitest'
import {
  workspaceBounds,
  clampFloating,
  clampSize,
  computePanelRects,
  snapPlacement,
  placementLabel,
} from './geometry'
import type { PanelUiState, PanelId } from './types'
import { PANEL_BY_ID } from './registry'
import { RAIL_WIDTH, PANEL_MARGIN } from './types'

function makeState(overrides: Partial<PanelUiState> & { id: PanelId }): PanelUiState {
  const def = PANEL_BY_ID.get(overrides.id)!
  return {
    open: true,
    placement: 'floating',
    x: 100,
    y: 100,
    w: def.defaultSize.w,
    h: def.defaultSize.h,
    z: 0,
    ...overrides,
  }
}

function allPanels(overrides?: Partial<Record<PanelId, Partial<PanelUiState>>>) {
  const result = {} as Record<PanelId, PanelUiState>
  for (const [id] of PANEL_BY_ID) {
    result[id] = makeState({ id, ...(overrides?.[id] ?? {}) })
  }
  return result
}

const VIEWPORT = { w: 1920, h: 1080 }

describe('workspaceBounds', () => {
  it('offsets from taskbar and margin', () => {
    const b = workspaceBounds(VIEWPORT)
    expect(b.x).toBe(RAIL_WIDTH + PANEL_MARGIN)
    expect(b.y).toBe(PANEL_MARGIN)
    expect(b.w).toBe(VIEWPORT.w - RAIL_WIDTH - PANEL_MARGIN * 2)
    expect(b.h).toBe(VIEWPORT.h - PANEL_MARGIN * 2)
  })
})

describe('clampFloating', () => {
  it('clamps to workspace bounds', () => {
    const b = workspaceBounds(VIEWPORT)
    const r = clampFloating(-500, -500, 200, 200, b)
    expect(r.x).toBe(b.x)
    expect(r.y).toBe(b.y)
  })

  it('clamps right/bottom edges', () => {
    const b = workspaceBounds(VIEWPORT)
    const r = clampFloating(99999, 99999, 200, 200, b)
    expect(r.x).toBe(b.x + b.w - 200)
    expect(r.y).toBe(b.y + b.h - 200)
  })

  it('passes through valid coordinates', () => {
    const b = workspaceBounds(VIEWPORT)
    const r = clampFloating(400, 400, 200, 200, b)
    expect(r.x).toBe(400)
    expect(r.y).toBe(400)
  })
})

describe('clampSize', () => {
  it('enforces minimum', () => {
    const b = workspaceBounds(VIEWPORT)
    const s = clampSize(10, 10, { w: 100, h: 80 }, b)
    expect(s.w).toBe(100)
    expect(s.h).toBe(80)
  })

  it('enforces maximum relative to bounds', () => {
    const b = workspaceBounds(VIEWPORT)
    const s = clampSize(9999, 9999, { w: 50, h: 50 }, b)
    expect(s.w).toBeLessThanOrEqual(b.w * 0.9)
    expect(s.h).toBeLessThanOrEqual(b.h * 0.9)
  })
})

describe('computePanelRects', () => {
  it('returns zero rects for closed panels', () => {
    const panels = allPanels({ core: { open: false } })
    const rects = computePanelRects(panels, PANEL_BY_ID, VIEWPORT)
    expect(rects.get('core')!.open).toBe(false)
  })

  it('left-edge panels stack vertically', () => {
    const panels = allPanels({
      camera: { open: true, placement: 'left' },
      system: { open: true, placement: 'left' },
    })
    const rects = computePanelRects(panels, PANEL_BY_ID, VIEWPORT)
    const cam = rects.get('camera')!
    const sys = rects.get('system')!
    expect(cam.placement).toBe('left')
    expect(sys.placement).toBe('left')
    expect(cam.y).toBeLessThan(sys.y)
    expect(cam.x).toBe(sys.x)
  })

  it('right-edge panels are right-aligned', () => {
    const panels = allPanels({
      conversation: { open: true, placement: 'right' },
      activity: { open: true, placement: 'right' },
    })
    const rects = computePanelRects(panels, PANEL_BY_ID, VIEWPORT)
    const b = workspaceBounds(VIEWPORT)
    for (const id of ['conversation', 'activity'] as PanelId[]) {
      const r = rects.get(id)!
      expect(r.x + r.w).toBeCloseTo(b.x + b.w, 0)
    }
  })

  it('floating panels use stored x/y clamped to bounds', () => {
    const panels = allPanels({
      environments: { open: true, placement: 'floating', x: 500, y: 400 },
    })
    const rects = computePanelRects(panels, PANEL_BY_ID, VIEWPORT)
    const r = rects.get('environments')!
    expect(r.placement).toBe('floating')
    const b = workspaceBounds(VIEWPORT)
    expect(r.x).toBeGreaterThanOrEqual(b.x)
    expect(r.y).toBeGreaterThanOrEqual(b.y)
  })
})

describe('snapPlacement', () => {
  const viewport = { w: 1920, h: 1080 }

  it('snaps to left when near left edge', () => {
    const b = workspaceBounds(viewport)
    expect(snapPlacement(b.x + 5, 400, 200, 200, viewport)).toBe('left')
  })

  it('snaps to right when near right edge', () => {
    const b = workspaceBounds(viewport)
    expect(snapPlacement(b.x + b.w - 200 - 10, 400, 200, 200, viewport)).toBe('right')
  })

  it('snaps to top when near top edge', () => {
    const b = workspaceBounds(viewport)
    expect(snapPlacement(600, b.y + 5, 200, 200, viewport)).toBe('top')
  })

  it('snaps to bottom when near bottom edge', () => {
    const b = workspaceBounds(viewport)
    expect(snapPlacement(600, b.y + b.h - 200 - 10, 200, 200, viewport)).toBe('bottom')
  })

  it('stays floating when far from all edges', () => {
    const b = workspaceBounds(viewport)
    expect(snapPlacement(b.x + 200, b.y + 200, 200, 200, viewport)).toBe('floating')
  })
})

describe('placementLabel', () => {
  it('returns human-readable label for every placement', () => {
    expect(placementLabel('left')).toBe('Left')
    expect(placementLabel('right')).toBe('Right')
    expect(placementLabel('top')).toBe('Top')
    expect(placementLabel('bottom')).toBe('Bottom')
    expect(placementLabel('floating')).toBe('Float')
  })
})
