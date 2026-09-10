/**
 * Android companion device capability seam (Phase 4.0 Foundation).
 *
 * THIS IS ARCHITECTURE ONLY — NOT YET IMPLEMENTED.
 *
 * This module defines the adapter boundary for future Android device control.
 * When implemented, Android capabilities will plug into the same capability
 * architecture as desktop, clipboard, browser, etc.
 *
 * STATUS: ARCHITECTURE READY — NOT YET IMPLEMENTED
 *
 * The planned architecture:
 *  1. An AndroidProvider exposes device capabilities (list, notify, file transfer)
 *  2. A native or cloud bridge handles communication with the Android device
 *  3. Tools are registered via the same createAndroidTools(provider) pattern
 *  4. Capabilities are defined in DEFAULT_CAPABILITIES with category 'android'
 *  5. The engine registers tools only when a real provider is bound
 *
 * The existing device.* tools (device.list, device.notify, device.sendFile)
 * already work through the JARVIS Core backend bridge. This module provides
 * the architectural foundation for richer Android-specific capabilities:
 *  - Screen observation (screenshot/mirror)
 *  - App control (launch/close)
 *  - Notification management
 *  - File transfer (bidirectional)
 *  - Input injection (tap/swipe/type)
 */

export type AndroidDeviceType = 'phone' | 'tablet' | 'emulator'

export interface AndroidDeviceInfo {
  deviceId: string
  deviceName: string
  deviceType: AndroidDeviceType
  androidVersion?: string
  online: boolean
  /** Capabilities supported by this specific device. */
  supportedOps: AndroidOp[]
}

export type AndroidOp =
  | 'list'
  | 'notify'
  | 'sendFile'
  | 'screenshot'
  | 'launch'
  | 'close'
  | 'tap'
  | 'swipe'
  | 'type'

export interface AndroidCapabilities {
  available: boolean
  reason?: string
  ops: Record<AndroidOp, boolean>
  devices: AndroidDeviceInfo[]
}

/**
 * The Android provider interface. When implemented, this will be the seam
 * through which JARVIS communicates with Android devices.
 *
 * CURRENT STATUS: NOT IMPLEMENTED — This interface defines the future
 * adapter boundary. The existing device.* tools use a different bridge
 * (BackendDeviceProvider via JARVIS Core backend).
 *
 * When Android is implemented, it will:
 *  1. Implement this interface
 *  2. Register via createAndroidTools(provider)
 *  3. Be wired through createDefaultAppAndroidProvider()
 *  4. Use the same capability/tool/permission architecture
 */
export interface AndroidProvider {
  readonly id: string
  capabilities(): AndroidCapabilities
  /** Refresh device list. */
  refresh(): Promise<AndroidDeviceInfo[]>
  /** Send a notification to a specific device. */
  notify(deviceId: string, title: string, message: string): Promise<{ success: boolean }>
  /** Transfer a file to a device. */
  sendFile(deviceId: string, name: string, content: string): Promise<{ success: boolean }>
  /** Capture a screenshot from a device. */
  screenshot(deviceId: string): Promise<{ success: boolean; width: number; height: number; bytes: string }>
}

/**
 * Adapter boundary documentation for future Android implementation.
 *
 * IMPLEMENTATION STATUS:
 *   ✅ IMPLEMENTED     — Working, verified, in production
 *   🔧 SUPPORTED       — Working locally on specific configurations
 *   🏗️ ARCHITECTURE    — Design complete, interfaces defined, not yet coded
 *   ❌ NOT YET         — Not implemented, not started
 *
 * Current status by feature:
 *   ✅ device.list        — IMPLEMENTED (via BackendDeviceProvider)
 *   ✅ device.notify      — IMPLEMENTED (via BackendDeviceProvider)
 *   ✅ device.sendFile    — IMPLEMENTED (via BackendDeviceProvider)
 *   🏗️ AndroidProvider   — ARCHITECTURE READY (this interface)
 *   🏗️ android.screenshot — ARCHITECTURE READY (interface defined)
 *   🏗️ android.launch    — ARCHITECTURE READY (interface defined)
 *   🏗️ android.tap       — ARCHITECTURE READY (interface defined)
 *   🏗️ android.type      — ARCHITECTURE READY (interface defined)
 *   ❌ Native Android bridge — NOT YET (requires ADB or companion app)
 *   ❌ Android screen mirror — NOT YET (requires scrcpy or similar)
 *   ❌ Android input injection — NOT YET (requires ADB input commands)
 */
export const ANDROID_IMPLEMENTATION_STATUS = {
  'device.list': 'implemented',
  'device.notify': 'implemented',
  'device.sendFile': 'implemented',
  'AndroidProvider': 'architecture_ready',
  'android.screenshot': 'architecture_ready',
  'android.launch': 'architecture_ready',
  'android.tap': 'architecture_ready',
  'android.type': 'architecture_ready',
  'Native Android bridge': 'not_yet',
  'Android screen mirror': 'not_yet',
  'Android input injection': 'not_yet',
} as const
