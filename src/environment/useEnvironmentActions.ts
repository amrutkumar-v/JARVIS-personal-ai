import { usePanelLayoutStore } from '../panel/panelStore'
import type { PanelId } from '../panel/types'
import type { VisualEnvironmentId } from './types'
import { DEFAULT_ENVIRONMENT, isEnvironmentId, stepEnvironment } from './registry'

/**
 * Phase 8 — clean environment/panel control surface.
 *
 * These are the ONLY gesture/voice-ready actions the environment layer
 * exposes. The hand-gesture and voice mappings are intentionally NOT defined
 * here (later phases wire them to these primitives).
 */
export interface EnvironmentActions {
  nextEnvironment: () => void
  previousEnvironment: () => void
  selectEnvironment: (id: string) => void
  openPanel: (id: PanelId) => void
  closePanel: (id: PanelId) => void
  togglePanel: (id: PanelId) => void
  focusPanel: (id: PanelId) => void
}

function currentEnvironment(): VisualEnvironmentId {
  const id = usePanelLayoutStore.getState().environmentId
  return isEnvironmentId(id) ? id : DEFAULT_ENVIRONMENT
}

export function useEnvironmentActions(): EnvironmentActions {
  const store = usePanelLayoutStore

  return {
    nextEnvironment: () =>
      store.getState().setEnvironment(stepEnvironment(currentEnvironment(), 1)),
    previousEnvironment: () =>
      store.getState().setEnvironment(stepEnvironment(currentEnvironment(), -1)),
    selectEnvironment: (id) =>
      store
        .getState()
        .setEnvironment(isEnvironmentId(id) ? id : DEFAULT_ENVIRONMENT),
    openPanel: (id) => store.getState().openPanel(id),
    closePanel: (id) => store.getState().closePanel(id),
    togglePanel: (id) => store.getState().togglePanel(id),
    focusPanel: (id) => store.getState().focusPanel(id),
  }
}