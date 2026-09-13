import { beforeEach, describe, expect, it } from 'vitest'
import { executeGestureCommand } from './executor'
import { useZoomStore, levelFor } from '../environment/zoomStore'
import { DEFAULT_ZOOM } from '../environment/zoom'
import { useJarvisStore } from '../state/jarvis.store'
import { usePanelLayoutStore } from '../panel/panelStore'
import { nextTheme, DEFAULT_THEME } from '../themes'
import type { PanelId } from '../panel/types'

/**
 * Phase 10 — executor tests. The executor returns VERIFIED post-conditions:
 * it never claims success without re-reading the store.
 */

beforeEach(() => {
  useZoomStore.getState().setZoom('arc', DEFAULT_ZOOM)
  useZoomStore.getState().setZoom('tunnel', DEFAULT_ZOOM)
  useJarvisStore.getState().setTheme(DEFAULT_THEME)
})

describe('executeGestureCommand', () => {
  it('zoom_in really increases the active environment zoom', () => {
    const before = levelFor('arc')
    const result = executeGestureCommand('zoom_in', 'arc')
    expect(result.ok).toBe(true)
    expect(levelFor('arc')).toBeGreaterThan(before)
  })

  it('zoom_out really decreases the active environment zoom', () => {
    useZoomStore.getState().setZoom('arc', 1.5)
    const before = levelFor('arc')
    const result = executeGestureCommand('zoom_out', 'arc')
    expect(result.ok).toBe(true)
    expect(levelFor('arc')).toBeLessThan(before)
  })

  it('zoom_in refuses with an honest reason at the max bound', () => {
    const result = executeGestureCommand('zoom_in', 'tunnel')
    expect(result.ok).toBe(true)
    let guard = 0
    let last = result
    while (last.ok && guard < 60) {
      last = executeGestureCommand('zoom_in', 'tunnel')
      guard += 1
    }
    expect(last.ok).toBe(false)
    expect(last.reason).toBe('max')
    expect(levelFor('tunnel')).toBeLessThanOrEqual(1.8)
  })

  it('theme_change cycles via the single themes.ts helper and persists', () => {
    const before = useJarvisStore.getState().theme
    const result = executeGestureCommand('theme_change', 'arc')
    expect(result.ok).toBe(true)
    expect(useJarvisStore.getState().theme).toBe(nextTheme(before))
  })

  it('crush closes the topmost REAL open panel', () => {
    usePanelLayoutStore.getState().resetLayout()
    usePanelLayoutStore.getState().openPanel('conversation')
    // Focus bumps z so 'conversation' becomes the TOPMOST open panel.
    usePanelLayoutStore.getState().focusPanel('conversation')
    usePanelLayoutStore.getState().openPanel('activity')
    expect(usePanelLayoutStore.getState().panels['conversation'].open).toBe(true)
    const result = executeGestureCommand('crush', 'arc')
    expect(result.ok).toBe(true)
    expect(usePanelLayoutStore.getState().panels['conversation'].open).toBe(false)
    expect(usePanelLayoutStore.getState().panels['activity'].open).toBe(true)
  })

  it('crush reports an honest failure when no panel is open', () => {
    usePanelLayoutStore.getState().resetLayout()
    const state = usePanelLayoutStore.getState()
    for (const id of Object.keys(state.panels) as PanelId[]) {
      state.closePanel(id)
    }
    const result = executeGestureCommand('crush', 'arc')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no_open_panel')
  })

  it('rejects an empty command', () => {
    const result = executeGestureCommand('' as never, 'arc')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('empty_command')
  })

  it('rejects an unknown command', () => {
    const result = executeGestureCommand('definitely_not_a_gesture' as never, 'arc')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unknown_command')
  })
})