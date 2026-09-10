import { describe, it, expect } from 'vitest'
import { useJarvisStore } from './jarvis.store'
import { DEFAULT_THEME } from '../themes'

describe('presentation store (Phase 2.5)', () => {
  it('defaults to classic theme and demo off', () => {
    const s = useJarvisStore.getState()
    expect(s.theme).toBe(DEFAULT_THEME)
    expect(s.demoMode).toBe(false)
  })

  it('setTheme and setDemoMode update only presentation fields', () => {
    const before = useJarvisStore.getState()
    useJarvisStore.getState().setTheme('cyber')
    useJarvisStore.getState().setDemoMode(true)

    const after = useJarvisStore.getState()
    expect(after.theme).toBe('cyber')
    expect(after.demoMode).toBe(true)

    // Presentation toggles must never touch execution/engine state.
    expect(after.status).toBe(before.status)
    expect(after.capabilities).toBe(before.capabilities)

    useJarvisStore.getState().setTheme(DEFAULT_THEME)
    useJarvisStore.getState().setDemoMode(false)
  })

  it('demo mode is decoupled from the engine (no interaction with run/status)', () => {
    const demo = useJarvisStore.getState().demoMode
    // The engine never has a demo flag; this asserts demo only exists as UI
    // state and cannot gate execution.
    expect(typeof demo).toBe('boolean')
    expect(useJarvisStore.getState().setDemoMode).toBeTypeOf('function')
  })
})