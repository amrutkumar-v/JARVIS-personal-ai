import type {
  PanelId,
  PanelUiState,
  PanelRect,
  PanelPlacement,
  PanelDefinition,
  ViewportSize,
} from './types'
import { RAIL_WIDTH, PANEL_MARGIN, PANEL_GAP, SNAP_DISTANCE } from './types'

export interface WorkspaceBounds {
  x: number
  y: number
  w: number
  h: number
}

export interface WorkspaceOffsets {
  sidebarWidth?: number
  topbarHeight?: number
  dockHeight?: number
  margin?: number
}

export function workspaceBounds(
  viewport: ViewportSize,
  offsets?: WorkspaceOffsets,
): WorkspaceBounds {
  const sidebarW = offsets?.sidebarWidth ?? RAIL_WIDTH
  const topbarH = offsets?.topbarHeight ?? 0
  const dockH = offsets?.dockHeight ?? 0
  const margin = offsets?.margin ?? PANEL_MARGIN
  const topY = topbarH > 0 ? topbarH + margin : margin
  const bottomMargin = dockH > 0 ? dockH + margin : margin

  return {
    x: sidebarW + margin,
    y: topY,
    w: Math.max(0, viewport.w - sidebarW - margin * 2),
    h: Math.max(0, viewport.h - topY - bottomMargin),
  }
}

export function clampFloating(
  x: number,
  y: number,
  w: number,
  h: number,
  bounds: WorkspaceBounds,
): { x: number; y: number } {
  const minX = bounds.x
  const minY = bounds.y
  const maxX = bounds.x + bounds.w - w
  const maxY = bounds.y + bounds.h - h
  return {
    x: Math.round(Math.max(minX, Math.min(maxX, x))),
    y: Math.round(Math.max(minY, Math.min(maxY, y))),
  }
}

export function clampSize(
  w: number,
  h: number,
  min: { w: number; h: number },
  bounds: WorkspaceBounds,
): { w: number; h: number } {
  return {
    w: Math.max(min.w, Math.min(w, bounds.w * 0.9)),
    h: Math.max(min.h, Math.min(h, bounds.h * 0.9)),
  }
}

interface EdgePanel {
  id: PanelId
  state: PanelUiState
  def: PanelDefinition
}

function arrangeColumn(
  panels: EdgePanel[],
  bounds: WorkspaceBounds,
  edgeX: number,
): Map<PanelId, PanelRect> {
  const result = new Map<PanelId, PanelRect>()
  let y = bounds.y
  const available = bounds.h
  let remaining = available
  const count = panels.length

  const heights = panels.map((p) =>
    Math.max(p.def.minSize.h, Math.min(p.state.h, available / count)),
  )
  const totalH = heights.reduce((a, b) => a + b, 0)

  let scale = 1
  if (totalH > available && totalH > 0) {
    scale = available / totalH
  }

  let z = 0
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i]
    const h = Math.round(heights[i] * scale)
    remaining -= h
    const rawW = Math.max(p.def.minSize.w, Math.min(p.state.w, bounds.w * 0.9))
    const w = Math.min(rawW, bounds.w)
    const clampedX = Math.max(bounds.x, Math.min(bounds.x + bounds.w - w, edgeX))
    result.set(p.id, {
      x: Math.round(clampedX),
      y: Math.round(y),
      w: Math.round(w),
      h,
      z: z++,
      open: true,
      placement: p.state.placement,
    })
    y += h + PANEL_GAP
  }

  return result
}

function arrangeRow(
  panels: EdgePanel[],
  bounds: WorkspaceBounds,
  edgeY: number,
): Map<PanelId, PanelRect> {
  const result = new Map<PanelId, PanelRect>()
  let x = bounds.x
  const available = bounds.w
  const count = panels.length

  const widths = panels.map((p) =>
    Math.max(p.def.minSize.w, Math.min(p.state.w, available / count)),
  )
  const totalW = widths.reduce((a, b) => a + b, 0)

  let scale = 1
  if (totalW > available && totalW > 0) {
    scale = available / totalW
  }

  let z = 0
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i]
    const rawW = Math.round(widths[i] * scale)
    const w = Math.min(rawW, bounds.w)
    const rawH = Math.max(p.def.minSize.h, Math.min(p.state.h, bounds.h * 0.9))
    const h = Math.min(rawH, bounds.h)
    result.set(p.id, {
      x: Math.round(x),
      y: Math.round(edgeY),
      w,
      h: Math.round(h),
      z: z++,
      open: true,
      placement: p.state.placement,
    })
    x += w + PANEL_GAP
  }

  return result
}

export function computePanelRects(
  panels: Record<PanelId, PanelUiState>,
  registry: Map<PanelId, PanelDefinition>,
  viewport: ViewportSize,
  offsets?: WorkspaceOffsets,
): Map<PanelId, PanelRect> {
  const bounds = workspaceBounds(viewport, offsets)
  const result = new Map<PanelId, PanelRect>()

  const edgeGroups: Record<PanelPlacement, EdgePanel[]> = {
    left: [],
    right: [],
    top: [],
    bottom: [],
    floating: [],
  }

  const ids = Object.keys(panels) as PanelId[]

  for (const id of ids) {
    const state = panels[id]
    const def = registry.get(id)
    if (!def || !state.open) {
      result.set(id, {
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        z: 0,
        open: false,
        placement: state.placement,
      })
      continue
    }

    if (state.placement === 'floating') {
      const clamped = clampFloating(state.x, state.y, state.w, state.h, bounds)
      const w = Math.min(Math.round(state.w), bounds.w)
      const h = Math.min(Math.round(state.h), bounds.h)
      result.set(id, {
        ...clamped,
        w,
        h,
        z: state.z,
        open: true,
        placement: 'floating',
      })
    } else {
      edgeGroups[state.placement].push({ id, state, def })
    }
  }

  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    const group = edgeGroups[edge]
    if (group.length === 0) continue

    group.sort((a, b) => {
      const da = registry.get(a.id)
      const db = registry.get(b.id)
      return (da?.order ?? 99) - (db?.order ?? 99)
    })

    if (edge === 'left') {
      const rects = arrangeColumn(group, bounds, bounds.x)
      for (const [id, rect] of rects) result.set(id, rect)
    } else if (edge === 'right') {
      const rects = arrangeColumn(group, bounds, bounds.x + bounds.w - group[0]!.state.w)
      let zBase = 0
      for (const [id, rect] of rects) {
        const adjusted = { ...rect, x: Math.round(bounds.x + bounds.w - rect.w), z: zBase++ }
        result.set(id, adjusted)
      }
    } else if (edge === 'top') {
      const rects = arrangeRow(group, bounds, bounds.y)
      for (const [id, rect] of rects) result.set(id, rect)
    } else {
      const rects = arrangeRow(group, bounds, bounds.y + bounds.h - group[0]!.state.h)
      let zBase = 0
      for (const [id, rect] of rects) {
        const adjusted = { ...rect, y: Math.round(bounds.y + bounds.h - rect.h), z: zBase++ }
        result.set(id, adjusted)
      }
    }
  }

  return result
}

export function snapPlacement(
  x: number,
  y: number,
  w: number,
  h: number,
  viewport: ViewportSize,
): PanelPlacement {
  const b = workspaceBounds(viewport)
  const snap = SNAP_DISTANCE

  if (x <= b.x + snap) return 'left'
  if (x + w >= b.x + b.w - snap) return 'right'
  if (y <= b.y + snap) return 'top'
  if (y + h >= b.y + b.h - snap) return 'bottom'
  return 'floating'
}

export function placementLabel(p: PanelPlacement): string {
  const labels: Record<PanelPlacement, string> = {
    floating: 'Float',
    left: 'Left',
    right: 'Right',
    top: 'Top',
    bottom: 'Bottom',
  }
  return labels[p]
}
