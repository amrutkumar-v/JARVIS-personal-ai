/**
 * Wire types for the JARVIS Core persistent backend (Phase 2.8) — browser side.
 * These mirror the server contracts 1:1 so the client, /phone companion page
 * and the backend always agree on the transport shape.
 */

export type DeviceType = 'windows_pc' | 'android_phone' | 'android' | 'web' | 'desktop' | 'unknown'

/**
 * Structured device-error code a device tool may attach to its failure result
 * (Work 11.9). The engine maps these to bounded, honest recovery actions —
 * never a silent retry loop.
 */
export type DeviceErrorKind =
  | 'device_not_found'
  | 'device_disconnected'
  | 'device_untrusted'
  | 'device_permission_required'
  | 'device_timeout'
  | 'device_unavailable'
  | 'device_protocol_error'
  | 'transfer_failed'
  | 'verification_unavailable'

export type DevicePlatform = 'windows' | 'android' | 'unknown'

export type DeviceRole = 'primary_pc' | 'secondary_pc' | 'primary_phone' | 'secondary_phone'

export interface DeviceRecord {
  id: string
  name: string
  type: DeviceType
  connection: string
  capabilities: string[]
  permissions: string[]
  online: boolean
  health: 'ok' | 'stale' | 'unknown'
  lastHeartbeatAt: number
  registeredAt: number
  platform: DevicePlatform
  role?: DeviceRole
  trusted: boolean
  version?: string
  battery?: number
  charging?: boolean
  network?: string
  activity?: string
}

/** Telemetry a companion bridge reports when pairing or heartbeating. */
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
  device?: string
  title: string
  message: string
}

export interface NotifyResult {
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

export type BackendEventType =
  | 'ready'
  | 'device'
  | 'notify'
  | 'open-url'
  | 'file'
  | 'inbound'
  | 'assistant'
  | 'wake'

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
  wake: { browserOnly: true; lastWakeAt?: number; armAt?: number; disarmAt?: number }
  files: { count: number }
  paths: { dataDir: string; lockFile?: string; logFile?: string }
}

export interface ApiResponse<T> {
  ok: boolean
  error?: string
  data?: T
}