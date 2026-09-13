import { create } from 'zustand'
import type { PanelId, PanelUiState, PanelPlacement } from './types'
import { PANEL_DEFINITIONS } from './registry'
import { defaultPanelState } from './types'
import { loadLayout, saveLayout } from './storage'
import { sanitizeEnvironmentId } from '../environment/registry'

const restoredLayout = loadLayout()

export interface PanelLayoutState {
  panels: Record<PanelId, PanelUiState>
  environmentId: string
  openPanel: (id: PanelId) => void
  closePanel: (id: PanelId) => void
  togglePanel: (id: PanelId) => void
  focusPanel: (id: PanelId) => void
  setPlacement: (id: PanelId, placement: PanelPlacement) => void
  moveFloating: (id: PanelId, x: number, y: number) => void
  resetLayout: () => void
  setEnvironment: (id: string) => void
  /** Phase 10 — close the topmost OPEN panel (CRUSH surface). Returns false
   * when no panel is open, so callers verify the honest outcome. */
  closeTopmostPanel: () => boolean
}

function buildInitialPanels(): Record<PanelId, PanelUiState> {
  const panels = {} as Record<PanelId, PanelUiState>
  for (let i = 0; i < PANEL_DEFINITIONS.length; i++) {
    const def = PANEL_DEFINITIONS[i]!
    panels[def.id] = defaultPanelState(def, i)
  }
  if (restoredLayout) return restoredLayout.panels
  return panels
}

function computeMaxZ(panels: Record<PanelId, PanelUiState>): number {
  let max = 0
  for (const id of Object.keys(panels) as PanelId[]) {
    max = Math.max(max, panels[id].z)
  }
  return max
}

export const usePanelLayoutStore = create<PanelLayoutState>()((set, get) => ({
  panels: buildInitialPanels(),
  environmentId: restoredLayout
    ? sanitizeEnvironmentId(restoredLayout.environmentId)
    : 'arc',

  openPanel: (id) =>
    set((s) => ({
      panels: { ...s.panels, [id]: { ...s.panels[id], open: true } },
    })),

  closePanel: (id) =>
    set((s) => ({
      panels: { ...s.panels, [id]: { ...s.panels[id], open: false } },
    })),

  togglePanel: (id) =>
    set((s) => {
      const panel = s.panels[id]
      return {
        panels: { ...s.panels, [id]: { ...panel, open: !panel.open } },
      }
    }),

  focusPanel: (id) =>
    set((s) => {
      const panel = s.panels[id]
      if (!panel.open) return s
      const maxZ = computeMaxZ(s.panels)
      if (panel.z === maxZ) return s
      return { panels: { ...s.panels, [id]: { ...panel, z: maxZ + 1 } } }
    }),

  setPlacement: (id, placement) =>
    set((s) => {
      const panel = s.panels[id]
      return {
        panels: {
          ...s.panels,
          [id]: {
            ...panel,
            placement,
          },
        },
      }
    }),

  moveFloating: (id, x, y) =>
    set((s) => ({
      panels: { ...s.panels, [id]: { ...s.panels[id], x, y } },
    })),

  resetLayout: () =>
    set(() => {
      const panels = {} as Record<PanelId, PanelUiState>
      for (let i = 0; i < PANEL_DEFINITIONS.length; i++) {
        panels[PANEL_DEFINITIONS[i]!.id] = defaultPanelState(PANEL_DEFINITIONS[i]!, i)
      }
      return { panels, environmentId: 'arc' }
    }),

  setEnvironment: (id) => set({ environmentId: id }),

  closeTopmostPanel: () => {
    const s = get()
    const openIds = (Object.keys(s.panels) as PanelId[]).filter(
      (id) => s.panels[id].open,
    )
    if (openIds.length === 0) return false
    let topId = openIds[0]!
    for (let i = 1; i < openIds.length; i += 1) {
      if (s.panels[openIds[i]!]!.z > s.panels[topId]!.z) topId = openIds[i]!
    }
    if (!s.panels[topId].open) return false
    set({ panels: { ...s.panels, [topId]: { ...s.panels[topId], open: false } } })
    return !get().panels[topId].open
  },
}))

export function persistLayout(state: PanelLayoutState): void {
  saveLayout(state.panels, state.environmentId)
}

let subscribed = false

export function ensureLayoutPersistence(): void {
  if (subscribed) return
  subscribed = true
  usePanelLayoutStore.subscribe((state) => persistLayout(state))
}