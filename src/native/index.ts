import { createFileSystemProvider } from '../filesystem'
import type { FileSystemProvider } from '../filesystem'
import type { ApplicationProvider } from '../applications'
import type { ObservationProvider } from '../observation'
import type { DesktopProvider } from '../desktop'
import type { VisionProvider } from '../vision'
import type { WebProvider } from '../web/provider'
import { createVisionProviderFromConfig, VISION_UNAVAILABLE_MESSAGE } from '../vision'
import { NativeAgentRpc } from './nativeRpc'
import { NativeWindowsFileSystemProvider } from './NativeWindowsFileSystemProvider'
import { NativeWindowsApplicationProvider } from './NativeWindowsApplicationProvider'
import { NativeWindowsObservationProvider } from './NativeWindowsObservationProvider'
import { NativeWindowsDesktopProvider } from './NativeWindowsDesktopProvider'
import { NativeWindowsWebProvider } from './NativeWindowsWebProvider'

/**
 * Web-side app bootstrap (Phase 1.2/1.3/1.4/1.5).
 *
 * Chooses the capability surfaces for the live app:
 *  - when `VITE_NATIVE_AGENT_URL` is set, the app talks to the REAL local
 *    native Windows agent (real OS filesystem + approved application control
 *    + read-only Windows observation + bounded desktop input injection, typed
 *    allow-listed operations over one shared RPC transport);
 *  - otherwise the filesystem uses the browser File System Access provider
 *    unchanged, and application control / observation / desktop interaction
 *    yield NO provider (hence NO app/observation/desktop tools), because the
 *    browser has no safe way to launch a system application, see the desktop,
 *    or inject input.
 *
 * The browser is never given a simulated application, observation or desktop
 * surface, and all native providers honestly report when the agent is not
 * reachable.
 */
export function createDefaultAppFileSystemProvider(): FileSystemProvider {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
  const nativeUrl = env.VITE_NATIVE_AGENT_URL?.trim()
  if (nativeUrl) {
    return new NativeWindowsFileSystemProvider({
      baseUrl: nativeUrl,
      token: env.VITE_NATIVE_AGENT_TOKEN ?? '',
    })
  }
  return createFileSystemProvider()
}

/**
 * Application capability surface: a real provider when the native agent is
 * configured, otherwise `undefined` (browser mode has no application control).
 * The engine only registers app tools when this returns a provider.
 */
export function createDefaultAppApplicationProvider(): ApplicationProvider | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
  const nativeUrl = env.VITE_NATIVE_AGENT_URL?.trim()
  if (!nativeUrl) return undefined
  const rpc = new NativeAgentRpc({
    baseUrl: nativeUrl,
    token: env.VITE_NATIVE_AGENT_TOKEN ?? '',
  })
  return new NativeWindowsApplicationProvider(rpc)
}

/**
 * Observation capability surface: a real provider when the native agent is
 * configured, otherwise `undefined` (browser mode has no Windows observation).
 * The engine only registers observation tools when this returns a provider,
 * and `desktop.screenshot` still demands explicit user confirmation.
 */
export function createDefaultAppObservationProvider(): ObservationProvider | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
  const nativeUrl = env.VITE_NATIVE_AGENT_URL?.trim()
  if (!nativeUrl) return undefined
  const rpc = new NativeAgentRpc({
    baseUrl: nativeUrl,
    token: env.VITE_NATIVE_AGENT_TOKEN ?? '',
  })
  return new NativeWindowsObservationProvider(rpc)
}

/**
 * Desktop-interaction capability surface (Phase 1.5): a real provider when the
 * native agent is configured, otherwise `undefined` (browser mode has no way
 * to inject input). The engine only registers desktop.* / window.focus tools
 * when this returns a provider.
 */
export function createDefaultAppDesktopProvider(): DesktopProvider | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
  const nativeUrl = env.VITE_NATIVE_AGENT_URL?.trim()
  if (!nativeUrl) return undefined
  const rpc = new NativeAgentRpc({
    baseUrl: nativeUrl,
    token: env.VITE_NATIVE_AGENT_TOKEN ?? '',
  })
  return new NativeWindowsDesktopProvider(rpc)
}

/**
 * Web capability surface (Phase 2.9): a real provider when the native agent is
 * configured, otherwise `undefined` (browser mode has no web access).
 * The engine only registers web.* tools when this returns a provider.
 */
export function createDefaultAppWebProvider(): WebProvider | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
  const nativeUrl = env.VITE_NATIVE_AGENT_URL?.trim()
  if (!nativeUrl) return undefined
  return new NativeWindowsWebProvider({
    baseUrl: nativeUrl,
    token: env.VITE_NATIVE_AGENT_TOKEN ?? '',
  })
}

/**
 * Visual-understanding capability surface (Phase 1.7/1.8): a real
 * OpenAI-compatible vision provider when configured, otherwise `undefined`
 * (browser mode or missing configuration has no visual understanding).
 *
 * The real provider is bound ONLY when `VITE_JARVIS_VISION_BASE_URL` and
 * `VITE_JARVIS_VISION_MODEL` are set in `.env.local` — no network probe is
 * performed merely to claim vision exists. The engine registers the
 * `desktop.visual*` tools only when the provider is actually present.
 */
export function createDefaultAppVisionProvider(): VisionProvider | undefined {
  void VISION_UNAVAILABLE_MESSAGE
  return createVisionProviderFromConfig()
}

export { NativeWindowsFileSystemProvider, isNativeWindowsProvider } from './NativeWindowsFileSystemProvider'
export type { NativeBridgeOptions } from './NativeWindowsFileSystemProvider'
export { NativeWindowsApplicationProvider, isNativeApplicationProvider } from './NativeWindowsApplicationProvider'
export { NativeWindowsObservationProvider, isNativeObservationProvider } from './NativeWindowsObservationProvider'
export { NativeWindowsDesktopProvider, isNativeDesktopProvider, unsupportedWebDesktopCapabilities } from './NativeWindowsDesktopProvider'
export { NativeWindowsWebProvider } from './NativeWindowsWebProvider'
export type { WebProvider, WebCapabilities, WebSearchOptions, WebFetchOptions, WebSearchResponse, WebDocument, WebDownloadResult } from '../web/provider'