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

/**
 * Real telephony state vocabulary — mirrors the backend 1:1.
 *
 * Every value describes what the PHONE's OS actually reported; JARVIS never
 * synthesizes a call state. `PERMISSION_REQUIRED`, `NOT_SUPPORTED` and
 * `DEVICE_OFFLINE` exist so an impossible call is refused honestly.
 */
export type CallState =
  | 'CALL_REQUESTED'
  | 'CALLING'
  | 'RINGING'
  | 'CONNECTED'
  | 'ENDED'
  | 'FAILED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'PERMISSION_REQUIRED'
  | 'NOT_SUPPORTED'
  | 'DEVICE_OFFLINE'

export type CallDirection = 'incoming' | 'outgoing'

/** A real call-state observation the phone pushed via `/phone/event`. */
export interface CallEventData {
  deviceId: string
  state: CallState
  direction?: CallDirection
  commandId?: string
  contactName?: string
  number?: string
  reason?: string
  at: number
}

/**
 * The telephony actions the backend will queue for a phone.
 *
 * `speak` is not a telephony action but a call-surface action: it asks the
 * phone to speak a given text on the loudspeaker during a live call. It needs
 * no telephony permission, but the phone must advertise the `call.speak`
 * capability, and the platform decides whether the far end can hear it.
 */
export type CallAction = 'dial' | 'hangup' | 'answer' | 'reject' | 'speak'

export interface CallDispatchResult {
  ok: boolean
  /** Honest state — `DEVICE_OFFLINE` / `PERMISSION_REQUIRED` / `NOT_SUPPORTED` are real refusals. */
  state: CallState
  action?: CallAction
  commandId?: string
  requestId?: string
  device?: string
  delivered?: boolean
  reason?: string
  error?: string
}

export interface CallResultLookup {
  ok: boolean
  device?: string
  commandId?: string
  kind?: string
  pending?: boolean
  acknowledged?: boolean
  ackedAt?: number
  /** The phone's concrete ack result — `null` until it acknowledges. */
  result?: boolean | null
  detail?: string | null
  deviceOnline?: boolean
  error?: string
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
  | 'call'
  | 'task'

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