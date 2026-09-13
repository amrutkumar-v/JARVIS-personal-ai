/**
 * Shared wire types for the JARVIS Core persistent backend (Phase 2.8).
 *
 * Everything here is data + transport contracts between the backend, the
 * browser assistant, and companion devices (phone/web). No execution, no
 * permissions — those stay in the existing engine rails on the browser side
 * and in the native agent on the OS side.
 */

export type DeviceType = 'windows_pc' | 'android_phone' | 'android' | 'web' | 'unknown'

export type DevicePlatform = 'windows' | 'android' | 'unknown'

export type DeviceRole = 'primary_pc' | 'secondary_pc' | 'primary_phone' | 'secondary_phone'

export interface DeviceRecord {
  /** Canonical trusted id (e.g. `s26-ultra`); never invented. */
  id: string
  /** Human-readable label (trusted device name or my default). */
  name: string
  type: DeviceType
  platform: DevicePlatform
  /** Role within the personal ecosystem (trusted devices only). */
  role?: DeviceRole
  /** True for the four trusted devices; unknown devices are never added. */
  trusted: boolean
  /** Transport the device is using (e.g. 'lan-web', 'native-agent'). */
  connection: string
  /** Real capabilities the device reports (notifications/files/inbound). */
  capabilities: string[]
  /** Permission labels the device requests (informational only). */
  permissions: string[]
  online: boolean
  health: 'ok' | 'stale' | 'unknown'
  lastHeartbeatAt: number
  registeredAt: number
  /** Client-reported JARVIS version where the bridge reports it. */
  version?: string
  /** Battery fill (0–100) where the device reports it. */
  battery?: number
  /** Whether the device reports it is charging. */
  charging?: boolean
  /** Reported network label (e.g. 'wifi', 'mobile', 'lan'). */
  network?: string
  /** Ongoing activity/task on the device where supported. */
  activity?: string
}

export interface ClaimMeta {
  name?: string
  version?: string
  battery?: number
  charging?: boolean
  network?: string
  activity?: string
  connection?: string
  capabilities?: string[]
  permissions?: string[]
}

export interface NotifyRequest {
  /** 'all' (default) or a canonical trusted device id (e.g. `s26-ultra`). */
  device?: string
  title: string
  message: string
}

export interface NotifyResult {
  /** True only when at least one online device received the message. */
  delivered: boolean
  deliveredTo: string[]
  reason?: string
}

export interface InboundMessage {
  deviceId: string
  deviceName: string
  text: string
  at: number
}

export interface OutboundFile {
  id: string
  name: string
  size: number
  createdAt: number
  url: string
  /** Canonical target device id for targeted transfers (absent = any device). */
  deviceId?: string
}

export interface AssistantMirror {
  lastSeenAt?: number
  status?: string
  isSpeaking?: boolean
  voiceArmed?: boolean
  wakeWordEnabled?: boolean
  cameraActive?: boolean
}

export interface WakeState {
  /** Browser-hosted wake listening is real but requires an open UI tab. */
  browserOnly: true
  lastWakeAt?: number
  armAt?: number
  disarmAt?: number
}

export type BackendEventType =
  | 'ready'
  | 'device'
  | 'notify'
  | 'open-url'
  | 'file'
  | 'inbound'
  | 'assistant'
  | 'wake'

export interface BackendEvent {
  type: BackendEventType
  at: number
  data: unknown
}

export interface BackendHealth {
  name: string
  version: string
  protocol: string
  status: 'ok' | 'degraded'
  pid: number
  startedAt: string
  uptimeMs: number
  now: number
  native: {
    supervising: boolean
    connected: boolean
    reachable: boolean
    childRunning: boolean
    childPid?: number
    protocol?: string
    version?: string
    error?: string
    restarts: number
    lastProbeAt?: number
  }
  devices: {
    count: number
    online: number
    list: DeviceRecord[]
  }
  assistant: AssistantMirror
  wake: WakeState
  files: {
    count: number
  }
  paths: {
    dataDir: string
    lockFile?: string
    logFile?: string
  }
}