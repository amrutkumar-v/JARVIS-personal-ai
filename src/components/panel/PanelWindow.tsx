import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { PanelDefinition, PanelRect, PanelPlacement, ViewportSize } from '../../panel/types'
import { usePanelLayoutStore } from '../../panel/panelStore'
import { snapPlacement, workspaceBounds, clampFloating, placementLabel } from '../../panel/geometry'

interface Props {
  def: PanelDefinition
  rect: PanelRect
  viewport: ViewportSize
  open: boolean
  focused: boolean
  onPointerDown: (id: string) => void
  children: ReactNode
}

const PLACEMENTS: PanelPlacement[] = ['left', 'right', 'top', 'bottom', 'floating']

export function PanelWindow({ def, rect, viewport, open, focused, onPointerDown, children }: Props) {
  const focusPanel = usePanelLayoutStore((s) => s.focusPanel)
  const moveFloating = usePanelLayoutStore((s) => s.moveFloating)
  const setPlacement = usePanelLayoutStore((s) => s.setPlacement)
  const togglePanel = usePanelLayoutStore((s) => s.togglePanel)

  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [isDragging, setIsDragging] = useState(false)

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      if ((e.target as HTMLElement).closest('[data-stop-drag]')) return

      onPointerDown(def.id)
      focusPanel(def.id)

      if (rect.placement === 'floating') {
        dragRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          origX: rect.x,
          origY: rect.y,
          moved: false,
        }
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }
    },
    [def.id, rect.x, rect.y, rect.placement, focusPanel, onPointerDown],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return

      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return

      drag.moved = true
      setIsDragging(true)

      const bounds = workspaceBounds(viewport)
      const nx = clampFloating(drag.origX + dx, drag.origY + dy, rect.w, rect.h, bounds).x
      const ny = clampFloating(drag.origX + dx, drag.origY + dy, rect.w, rect.h, bounds).y

      if (frameRef.current) {
        frameRef.current.style.transform = `translate(${nx}px, ${ny}px)`
      }
    },
    [viewport, rect.w, rect.h],
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current
      dragRef.current = null
      if (!frameRef.current) return

      if (!drag || !drag.moved) {
        setIsDragging(false)
        return
      }

      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      const nx = drag.origX + dx
      const ny = drag.origY + dy

      const snapped = snapPlacement(nx, ny, rect.w, rect.h, viewport)
      if (snapped === 'floating') {
        moveFloating(def.id, nx, ny)
      } else {
        setPlacement(def.id, snapped)
      }

      frameRef.current.style.transform = ''
      setIsDragging(false)
    },
    [def.id, rect.w, rect.h, viewport, moveFloating, setPlacement],
  )

  const handlePlacementSelect = useCallback(
    (p: PanelPlacement) => {
      setPlacement(def.id, p)
      setMenuOpen(false)
    },
    [def.id, setPlacement],
  )

  return (
    <section
      ref={frameRef}
      className={`panel-window${focused ? ' is-focused' : ''}${isDragging ? ' is-dragging' : ''}${open ? '' : ' is-hidden'}`}
      role="region"
      aria-label={def.title}
      style={{
        transform: open
          ? `translate(${rect.x}px, ${rect.y}px)`
          : undefined,
        width: open ? rect.w : undefined,
        height: open ? rect.h : undefined,
        zIndex: rect.z + 100,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div className="panel-window-titlebar" data-stop-drag>
        <span className="panel-window-icon" aria-hidden="true">
          {def.icon}
        </span>
        <span className="panel-window-label">{def.title}</span>

        <div className="panel-window-actions" data-stop-drag>
          <button
            type="button"
            className="panel-window-placement-btn"
            aria-haspopup="menu"
            aria-label={`Move panel — currently ${placementLabel(rect.placement)}`}
            onClick={() => setMenuOpen((o) => !o)}
            data-stop-drag
          >
            &#x25f3;
          </button>

          <button
            type="button"
            className="panel-window-close-btn"
            aria-label={`Close ${def.title}`}
            onClick={() => togglePanel(def.id)}
            data-stop-drag
          >
            &#x2715;
          </button>
        </div>

        {menuOpen && (
          <>
            <div className="panel-menu-backdrop" onClick={() => setMenuOpen(false)} />
            <ul className="panel-placement-menu" role="menu">
              {PLACEMENTS.map((p) => (
                <li key={p}>
                  <button
                    type="button"
                    role="menuitem"
                    className={`panel-placement-option${rect.placement === p ? ' is-active' : ''}`}
                    onClick={() => handlePlacementSelect(p)}
                    data-stop-drag
                  >
                    {placementLabel(p)}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="panel-window-body">{children}</div>
    </section>
  )
}
