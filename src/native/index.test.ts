import { describe, expect, it, vi } from 'vitest'
import {
  createDefaultAppApplicationProvider,
  createDefaultAppDesktopProvider,
  createDefaultAppFileSystemProvider,
  createDefaultAppObservationProvider,
  isNativeWindowsProvider,
} from './index'
import { NativeAgentRpc } from './nativeRpc'
import { FileSystemAccessProvider } from '../filesystem'

// The native-agent env read is mocked so these tests deterministically assert
// the NO-native-URL contract (the dev server keeps the real URL from
// `.env.local`; `import.meta.env` is isolated per module, so it cannot be
// stubbed at runtime from a test file).
vi.mock('./nativeAgentEnv', () => ({
  readNativeAgentEnv: () => undefined,
}))

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

describe('NativeAgentRpc default fetch binding (browser Illegal invocation regression)', () => {
  it('binds the default fetch to globalThis instead of keeping the bare global fetch', () => {
    // Regression: a browser-native `fetch` (window.fetch) is a method that throws
    // "Failed to execute 'fetch' on 'Window': Illegal invocation" when invoked with
    // a foreign `this`. The Rpc calls its stored `fetchImpl` as a plain call, so the
    // default MUST be a bound copy of the global fetch — never the bare function
    // (this is the exact bug that made every native probe fail in the real browser
    // while the same providers succeeded under Node).
    const rpc = new NativeAgentRpc({ token: '' })
    const impl: unknown = (rpc as unknown as { fetchImpl: unknown }).fetchImpl
    expect(typeof impl).toBe('function')
    expect(impl).not.toBe(globalThis.fetch)
  })
})
