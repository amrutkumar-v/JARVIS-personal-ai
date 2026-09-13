import { create } from 'zustand'
import { createSelectors } from '../state/createSelectors'
import type { VisualEnvironmentId } from './types'
import { ENVIRONMENT_DEFINITIONS } from './registry'
import {
  DEFAULT_ZOOM,
  atBounds,
  clampZoom,
  stepZoom,
  zoomBoundsFor,
  type ZoomLevel,
} from './zoom'
import { loadZoomLevels, saveZoomLevels } from './zoomStorage'

/**
 * Phase 10 — normalized environment zoom store.
 *
 * Simple zustand mirror of per-environment zoom. Never contains React state:
 * it is the single source the zoom surface (gesture/voice/UI) reads and the
 * environment host consumes to scale the ACTIVE environment. Every mutation is
 * clamped to the environment's real bounds and reports the honest outcome so
 * callers can verify post-conditions instead of assuming success.
 */

export interface ZoomAdjustResult {
  environmentId: VisualEnvironmentId
  before: ZoomLevel
  after: ZoomLevel
  /** True when the level actually changed. */
  moved: boolean
  /** Non-null when the move was refused because a real bound was reached. */
  bound: 'min' | 'max' | null
}

const restored = loadZoomLevels()

function initialLevels(): Record<VisualEnvironmentId, ZoomLevel> {
  const levels = {} as Record<VisualEnvironmentId, ZoomLevel>
  for (const def of ENVIRONMENT_DEFINITIONS) {
    const stored = restored?.[def.id]
    levels[def.id] =
      typeof stored === 'number' && Number.isFinite(stored)
        ? clampZoom(stored, zoomBoundsFor(def.id))
        : DEFAULT_ZOOM
  }
  return levels
}

export interface ZoomStoreState {
  zoomByEnvironment: Record<VisualEnvironmentId, ZoomLevel>
  setZoom: (environmentId: VisualEnvironmentId, level: number) => ZoomAdjustResult
  resetZoom: (environmentId: VisualEnvironmentId) => ZoomAdjustResult
  adjustZoom: (environmentId: VisualEnvironmentId, dir: 1 | -1) => ZoomAdjustResult
}

export function levelFor(environmentId: VisualEnvironmentId): ZoomLevel {
  return useZoomStore.getState().zoomByEnvironment[environmentId] ?? DEFAULT_ZOOM
}

const rawStore = create<ZoomStoreState>()((set, get) => ({
  zoomByEnvironment: initialLevels(),

  setZoom: (environmentId, level) => {
    const bounds = zoomBoundsFor(environmentId)
    const current = get().zoomByEnvironment[environmentId] ?? DEFAULT_ZOOM
    const clamped = clampZoom(level, bounds)
    const moved = clamped !== current
    set({ zoomByEnvironment: { ...get().zoomByEnvironment, [environmentId]: clamped } })
    saveZoomLevels(get().zoomByEnvironment as unknown as Record<string, number>)
    return { environmentId, before: current, after: clamped, moved, bound: null }
  },

  resetZoom: (environmentId) => {
    const current = get().zoomByEnvironment[environmentId] ?? DEFAULT_ZOOM
    const moved = current !== DEFAULT_ZOOM
    set({ zoomByEnvironment: { ...get().zoomByEnvironment, [environmentId]: DEFAULT_ZOOM } })
    saveZoomLevels(get().zoomByEnvironment as unknown as Record<string, number>)
    return { environmentId, before: current, after: DEFAULT_ZOOM, moved, bound: null }
  },

  adjustZoom: (environmentId, dir) => {
    const bounds = zoomBoundsFor(environmentId)
    const current = get().zoomByEnvironment[environmentId] ?? DEFAULT_ZOOM
    const bound = atBounds(current, dir, bounds)
    const { level } = stepZoom(current, dir, bounds)
    const moved = level !== current && bound === null
    set({ zoomByEnvironment: { ...get().zoomByEnvironment, [environmentId]: level } })
    saveZoomLevels(get().zoomByEnvironment as unknown as Record<string, number>)
    return { environmentId, before: current, after: level, moved, bound }
  },
}))

export const useZoomStore = createSelectors(rawStore)
export { useZoomStore as useZoom }