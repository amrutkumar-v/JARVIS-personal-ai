export type PanelPlacement = 'floating' | 'left' | 'right' | 'top' | 'bottom'

export type PanelId =
  | 'core'
  | 'camera'
  | 'conversation'
  | 'activity'
  | 'system'
  | 'environments'
  | 'vision'
  | 'devices'
  | 'files'
  | 'applications'
  | 'tasks'

export interface PanelDefinition {
  id: PanelId
  title: string
  icon: string
  defaultOpen: boolean
  defaultPlacement: PanelPlacement
  defaultSize: { w: number; h: number }
  minSize: { w: number; h: number }
  keepMounted: boolean
  order: number
}

export interface PanelUiState {
  open: boolean
  placement: PanelPlacement
  x: number
  y: number
  w: number
  h: number
  z: number
}

export interface PanelRect {
  x: number
  y: number
  w: number
  h: number
  z: number
  open: boolean
  placement: PanelPlacement
}

export interface ViewportSize {
  w: number
  h: number
}

export const RAIL_WIDTH = 56
export const PANEL_MARGIN = 16
export const PANEL_GAP = 12
export const SNAP_DISTANCE = 48
export const MIN_PANEL_W = 160
export const MIN_PANEL_H = 96

export function defaultPanelState(def: PanelDefinition, index: number): PanelUiState {
  return {
    open: def.defaultOpen,
    placement: def.defaultPlacement,
    x: PANEL_MARGIN,
    y: PANEL_MARGIN,
    w: def.defaultSize.w,
    h: def.defaultSize.h,
    z: index,
  }
}
