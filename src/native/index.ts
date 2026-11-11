import { createFileSystemProvider } from '../filesystem'
import type { FileSystemProvider } from '../filesystem'
import type { ApplicationProvider } from '../applications'
import type { ObservationProvider } from '../observation'
import type { DesktopProvider } from '../desktop'
import type { VisionProvider } from '../vision'
import type { WebProvider } from '../web/provider'
import type { ClipboardProvider } from '../clipboard/provider'
import type { BrowserProvider } from '../browser/provider'
import { createVisionProviderFromConfig, VISION_UNAVAILABLE_MESSAGE } from '../vision'
import { NativeAgentRpc } from './nativeRpc'
import { NativeWindowsFileSystemProvider } from './NativeWindowsFileSystemProvider'
import { NativeWindowsApplicationProvider } from './NativeWindowsApplicationProvider'
import { NativeWindowsObservationProvider } from './NativeWindowsObservationProvider'
import { NativeWindowsDesktopProvider } from './NativeWindowsDesktopProvider'
import { NativeWindowsWebProvider } from './NativeWindowsWebProvider'
import { NativeWindowsClipboardProvider } from './NativeWindowsClipboardProvider'
import { NativeWindowsBrowserProvider } from './NativeWindowsBrowserProvider'
import { readNativeAgentEnv } from './nativeAgentEnv'

/**
 * Web-side app bootstrap (Phase 1.2/1.3/1.4/1.5).
 *
 * Chooses the capability surfaces for the live app:
 *  - when `VITE_NATIVE_AGENT_URL` is set, the app selects REAL native Windows
 *    providers and sends their typed, allow-listed RPC calls through the
 *    backend broker (the privileged native bearer token remains server-side);
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
  const env = readNativeAgentEnv()
  if (!env) return createFileSystemProvider()
  return new NativeWindowsFileSystemProvider(env)
}

/**
 * Application capability surface: a real provider when the native agent is
 * configured, otherwise `undefined` (browser mode has no application control).
 * The engine only registers app tools when this returns a provider.
 */
export function createDefaultAppApplicationProvider(): ApplicationProvider | undefined {
  const env = readNativeAgentEnv()
  if (!env) return undefined
  return new NativeWindowsApplicationProvider(new NativeAgentRpc(env))
}

/**
 * Observation capability surface: a real provider when the native agent is
 * configured, otherwise `undefined` (browser mode has no Windows observation).
 * The engine only registers observation tools when this returns a provider,
 * and `desktop.screenshot` still demands explicit user confirmation.
 */
export function createDefaultAppObservationProvider(): ObservationProvider | undefined {
  const env = readNativeAgentEnv()
  if (!env) return undefined
  return new NativeWindowsObservationProvider(new NativeAgentRpc(env))
}

/**
 * Desktop-interaction capability surface (Phase 1.5): a real provider when the
 * native agent is configured, otherwise `undefined` (browser mode has no way
 * to inject input). The engine only registers desktop.* / window.focus tools
 * when this returns a provider.
 */
export function createDefaultAppDesktopProvider(): DesktopProvider | undefined {
  const env = readNativeAgentEnv()
  if (!env) return undefined
  return new NativeWindowsDesktopProvider(new NativeAgentRpc(env))
}

/**
 * Web capability surface (Phase 2.9): a real provider when the native agent is
 * configured, otherwise `undefined` (browser mode has no web access).
 * The engine only registers web.* tools when this returns a provider.
 */
export function createDefaultAppWebProvider(): WebProvider | undefined {
  const env = readNativeAgentEnv()
  if (!env) return undefined
  return new NativeWindowsWebProvider(env)
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

/**
 * Clipboard capability surface (Phase 4.0): a real provider when the native
 * agent is configured, otherwise `undefined` (browser mode has no clipboard
 * access). The engine only registers clipboard.* tools when this returns a
 * provider.
 */
export function createDefaultAppClipboardProvider(): ClipboardProvider | undefined {
  const env = readNativeAgentEnv()
  if (!env) return undefined
  return new NativeWindowsClipboardProvider(env)
}

/**
 * Browser automation capability surface (Phase 4.0): a real provider when the
 * native agent is configured, otherwise `undefined` (browser mode has no
 * browser automation). The engine only registers browser.* tools when this
 * returns a provider.
 */
export function createDefaultAppBrowserProvider(): BrowserProvider | undefined {
  const env = readNativeAgentEnv()
  if (!env) return undefined
  return new NativeWindowsBrowserProvider(env)
}

export { NativeWindowsFileSystemProvider, isNativeWindowsProvider } from './NativeWindowsFileSystemProvider'
export type { NativeBridgeOptions } from './NativeWindowsFileSystemProvider'
export { NativeWindowsApplicationProvider, isNativeApplicationProvider } from './NativeWindowsApplicationProvider'
export { NativeWindowsObservationProvider, isNativeObservationProvider } from './NativeWindowsObservationProvider'
export { NativeWindowsDesktopProvider, isNativeDesktopProvider, unsupportedWebDesktopCapabilities } from './NativeWindowsDesktopProvider'
export { NativeWindowsWebProvider } from './NativeWindowsWebProvider'
export { NativeWindowsClipboardProvider } from './NativeWindowsClipboardProvider'
export { NativeWindowsBrowserProvider } from './NativeWindowsBrowserProvider'
export type { WebProvider, WebCapabilities, WebSearchOptions, WebFetchOptions, WebSearchResponse, WebDocument, WebDownloadResult } from '../web/provider'
export type { ClipboardProvider, ClipboardCapabilities, ClipboardReadResult, ClipboardWriteResult } from '../clipboard/provider'
export type { BrowserProvider, BrowserCapabilities, BrowserNavResult, BrowserReadPageResult, BrowserSearchResult } from '../browser/provider'
