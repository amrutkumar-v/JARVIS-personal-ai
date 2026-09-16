import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchInteraction,
  registerVoiceHandlers,
  type InteractionResult,
} from './controller'
import { useZoomStore, levelFor } from '../environment/zoomStore'
import { DEFAULT_ZOOM } from '../environment/zoom'
import { useJarvisStore } from '../state/jarvis.store'
import { usePanelLayoutStore } from '../panel/panelStore'
import { nextTheme, DEFAULT_THEME } from '../themes'
import type { PanelId } from '../panel/types'

/**
 * Phase 11 — interaction controller tests. The controller verifies post-
 * conditions the same way the gesture executor does: a result is only `ok`
 * when the store actually reflects the requested change.
 */

function closeAllPanels(): void {
  const state = usePanelLayoutStore.getState()
  for (const id of Object.keys(state.panels) as PanelId[]) {
    state.closePanel(id)
  }
}

beforeEach(() => {
  closeAllPanels()
  useZoomStore.getState().setZoom('arc', DEFAULT_ZOOM)
  useZoomStore.getState().setZoom('neural', DEFAULT_ZOOM)
  useJarvisStore.getState().setTheme(DEFAULT_THEME)
  useJarvisStore.getState().setVoiceArmed(false)
  usePanelLayoutStore.getState().setEnvironment('arc')
})

afterEach(() => {
  // The voice registry is module-level; reset so tests never leak handlers.
  registerVoiceHandlers({})
})

describe('dispatchInteraction', () => {
  it('select_environment really switches the active environment', () => {
    const result = dispatchInteraction(
      { action: 'select_environment', environment: 'tunnel' },
      'arc',
    )
    expect(result.ok).toBe(true)
    expect(usePanelLayoutStore.getState().environmentId).toBe('tunnel')
  })

  it('select_environment refuses when the environment is already active', () => {
    const result = dispatchInteraction(
      { action: 'select_environment', environment: 'arc' },
      'arc',
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('already_active')
  })

  it('next_environment wraps neural back to arc', () => {
    const result = dispatchInteraction({ action: 'next_environment' }, 'neural')
    expect(result.ok).toBe(true)
    expect(usePanelLayoutStore.getState().environmentId).toBe('arc')
  })

  it('previous_environment wraps arc back to neural', () => {
    const result = dispatchInteraction({ action: 'previous_environment' }, 'arc')
    expect(result.ok).toBe(true)
    expect(usePanelLayoutStore.getState().environmentId).toBe('neural')
  })

  it('zoom_in really increases the active environment zoom', () => {
    const before = levelFor('arc')
    const result: InteractionResult = dispatchInteraction({ action: 'zoom_in' }, 'arc')
    expect(result.ok).toBe(true)
    expect(levelFor('arc')).toBeGreaterThan(before)
  })

  it('zoom_in reports max bound honestly', () => {
    useZoomStore.getState().setZoom('neural', 1.8)
    const result = dispatchInteraction({ action: 'zoom_in' }, 'neural')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('max')
  })

  it('reset_layout closes back to the default panel set', () => {
    usePanelLayoutStore.getState().openPanel('activity')
    const result = dispatchInteraction({ action: 'reset_layout' }, 'arc')
    expect(result.ok).toBe(true)
    expect(usePanelLayoutStore.getState().panels['activity'].open).toBe(true)
    expect(usePanelLayoutStore.getState().environmentId).toBe('arc')
    closeAllPanels()
  })

  it('open_panel really opens a panel', () => {
    const result = dispatchInteraction(
      { action: 'open_panel', panel: 'vision' },
      'arc',
    )
    expect(result.ok).toBe(true)
    expect(usePanelLayoutStore.getState().panels['vision'].open).toBe(true)
  })

  it('close_panel really closes a panel', () => {
    usePanelLayoutStore.getState().openPanel('vision')
    const result = dispatchInteraction(
      { action: 'close_panel', panel: 'vision' },
      'arc',
    )
    expect(result.ok).toBe(true)
    expect(usePanelLayoutStore.getState().panels['vision'].open).toBe(false)
  })

  it('focus_core focuses the only open panel without fabricating', () => {
    usePanelLayoutStore.getState().openPanel('core')
    usePanelLayoutStore.getState().focusPanel('core')
    const result = dispatchInteraction({ action: 'focus_core' }, 'arc')
    expect(result.ok).toBe(true)
  })

  it('theme_change cycles to the deterministic next theme', () => {
    const before = useJarvisStore.getState().theme
    const result = dispatchInteraction({ action: 'theme_change' }, 'arc')
    expect(result.ok).toBe(true)
    expect(useJarvisStore.getState().theme).toBe(nextTheme(before))
  })

  it('crush reports an honest failure when no panel is open', () => {
    const result = dispatchInteraction({ action: 'crush' }, 'arc')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no_open_panel')
  })

  it('crush really closes the topmost open panel', () => {
    usePanelLayoutStore.getState().openPanel('activity')
    const result = dispatchInteraction({ action: 'crush' }, 'arc')
    expect(result.ok).toBe(true)
    expect(usePanelLayoutStore.getState().panels['activity'].open).toBe(false)
  })
})

describe('voice actions route to the REAL voice session handlers', () => {
  it('toggle_wake dispatches armWake when the wake session is off', () => {
    const armWake = vi.fn()
    const disarmWake = vi.fn()
    registerVoiceHandlers({ armWake, disarmWake })
    expect(useJarvisStore.getState().voiceArmed).toBe(false)

    const result = dispatchInteraction({ action: 'toggle_wake' }, 'arc')

    expect(result.ok).toBe(true)
    expect(armWake).toHaveBeenCalledTimes(1)
    expect(disarmWake).not.toHaveBeenCalled()
  })

  it('toggle_wake dispatches disarmWake when the wake session is on', () => {
    const armWake = vi.fn()
    const disarmWake = vi.fn()
    registerVoiceHandlers({ armWake, disarmWake })
    useJarvisStore.getState().setVoiceArmed(true)

    const result = dispatchInteraction({ action: 'toggle_wake' }, 'arc')

    expect(result.ok).toBe(true)
    expect(disarmWake).toHaveBeenCalledTimes(1)
    expect(armWake).not.toHaveBeenCalled()
  })

  it('toggle_wake never mutates the voice store directly (delegation)', () => {
    registerVoiceHandlers({ armWake: vi.fn(), disarmWake: vi.fn() })
    const before = useJarvisStore.getState().voiceArmed

    dispatchInteraction({ action: 'toggle_wake' }, 'arc')

    // The controller only delegates: the session layer owns armed state.
    expect(useJarvisStore.getState().voiceArmed).toBe(before)
  })

  it('listen_start routes startListening through the registry', () => {
    const startListening = vi.fn()
    registerVoiceHandlers({ startListening })
    const result = dispatchInteraction({ action: 'listen_start' }, 'arc')
    expect(result.ok).toBe(true)
    expect(startListening).toHaveBeenCalledTimes(1)
  })

  it('listen_stop routes stopListening through the registry', () => {
    const stopListening = vi.fn()
    registerVoiceHandlers({ stopListening })
    const result = dispatchInteraction({ action: 'listen_stop' }, 'arc')
    expect(result.ok).toBe(true)
    expect(stopListening).toHaveBeenCalledTimes(1)
  })

  it('refuses honestly when no voice session handler is registered', () => {
    const result = dispatchInteraction({ action: 'listen_start' }, 'arc')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('voice_unavailable')
  })

  it('refuses honestly to disarm an armed-looking toggle without a handler', () => {
    useJarvisStore.getState().setVoiceArmed(true)
    const result = dispatchInteraction({ action: 'toggle_wake' }, 'arc')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('voice_unavailable')
  })
})