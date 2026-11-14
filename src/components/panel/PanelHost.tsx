import { useMemo, useCallback, type ReactNode } from 'react'
import type { PanelId } from '../../panel/types'
import { PANEL_BY_ID } from '../../panel/registry'
import { computePanelRects } from '../../panel/geometry'
import { usePanelLayoutStore } from '../../panel/panelStore'
import { useViewport } from '../../hooks/useViewport'
import { PanelWindow } from './PanelWindow'

interface Props {
  renderPanel: (id: PanelId) => ReactNode
  isSidebarCollapsed?: boolean
}

export function PanelHost({ renderPanel, isSidebarCollapsed }: Props) {
  const panels = usePanelLayoutStore((s) => s.panels)
  const focusPanel = usePanelLayoutStore((s) => s.focusPanel)
  const viewport = useViewport()

  const offsets = useMemo(() => {
    const isMobile = viewport.w <= 768
    const sidebarWidth = isMobile ? 0 : isSidebarCollapsed ? 64 : 240
    const margin = isMobile ? 12 : 16
    const topbarHeight = 54
    const dockHeight = isMobile ? 84 : 110
    return { sidebarWidth, topbarHeight, dockHeight, margin }
  }, [viewport.w, isSidebarCollapsed])

  const rects = useMemo(
    () => computePanelRects(panels, PANEL_BY_ID, viewport, offsets),
    [panels, viewport, offsets],
  )

  const sorted = useMemo(() => {
    return [...PANEL_BY_ID.values()].sort((a, b) => a.order - b.order)
  }, [])

  const topZ = useMemo(() => {
    let max = 0
    for (const def of sorted) {
      const r = rects.get(def.id)
      if (r && r.open && r.z > max) max = r.z
    }
    return max
  }, [sorted, rects])

  const handlePointerDown = useCallback(
    (id: string) => focusPanel(id as PanelId),
    [focusPanel],
  )

  return (
    <div className="panel-host">
      {sorted.map((def) => {
        const state = panels[def.id]
        const rect = rects.get(def.id)
        if (!rect) return null

        if (!state.open && !def.keepMounted) return null

        return (
          <PanelWindow
            key={def.id}
            def={def}
            rect={rect}
            viewport={viewport}
            offsets={offsets}
            open={state.open}
            focused={state.open && rect.z === topZ}
            onPointerDown={handlePointerDown}
          >
            {renderPanel(def.id)}
          </PanelWindow>
        )
      })}
    </div>
  )
}
