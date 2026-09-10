import { describe, expect, it } from 'vitest'
import {
  createDefaultAppApplicationProvider,
  createDefaultAppDesktopProvider,
  createDefaultAppFileSystemProvider,
  createDefaultAppObservationProvider,
  isNativeWindowsProvider,
} from './index'
import { FileSystemAccessProvider } from '../filesystem'

/**
 * Phase 1.2/1.3/1.4/1.5 app bootstrap — without VITE_NATIVE_AGENT_URL the app
 * must keep using the real browser File System Access provider (never a fake)
 * and MUST expose NO application / observation / desktop provider at all, so
 * the engine registers no app.* / window.* / desktop.* tools in browser mode.
 * The native bridges are opt-in via build-time env only.
 */
describe('native app bootstrap — no native URL configured', () => {
  it('defaults filesystem to the real browser File System Access provider (never a fake)', () => {
    const provider = createDefaultAppFileSystemProvider()
    expect(provider).toBeInstanceOf(FileSystemAccessProvider)
    expect(isNativeWindowsProvider(provider)).toBe(false)
    expect((provider as unknown as { testsOnly?: boolean }).testsOnly).toBeUndefined()
  })

  it('exposes NO application provider without a native URL (browser mode has no app control)', () => {
    expect(createDefaultAppApplicationProvider()).toBeUndefined()
  })

  it('exposes NO observation provider without a native URL (no fake windows)', () => {
    const provider = createDefaultAppObservationProvider()
    expect(provider).toBeUndefined()
  })

  it('exposes NO desktop provider without a native URL (no fake input), and never the fake', () => {
    const provider = createDefaultAppDesktopProvider()
    expect(provider).toBeUndefined()
  })
})