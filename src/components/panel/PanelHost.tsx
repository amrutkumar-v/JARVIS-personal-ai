import { useMemo, useCallback, type ReactNode } from 'react'
import type { PanelId } from '../../panel/types'
import { PANEL_BY_ID } from '../../panel/registry'
import { computePanelRects } from '../../panel/geometry'
import { usePanelLayoutStore } from '../../panel/panelStore'
import { useViewport } from '../../hooks/useViewport'
import { PanelWindow } from './PanelWindow'

interface Props {
  renderPanel: (id: PanelId) => ReactNode
}

export function PanelHost({ renderPanel }: Props) {
  const panels = usePanelLayoutStore((s) => s.panels)
  const focusPanel = usePanelLayoutStore((s) => s.focusPanel)
  const viewport = useViewport()

  const rects = useMemo(
    () => computePanelRects(panels, PANEL_BY_ID, viewport),
    [panels, viewport],
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
