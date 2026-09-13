import { arcReactorPresentation } from '../components/core/arcReactorModel'
import type { JarvisStatus } from '../engine/types'
import type { TaskSnapshot } from '../engine/contracts'
import type { Capabilities } from '../types/capabilities'
import type { BackendUiState, CameraUiState } from '../state/jarvis.store'
import type { GoalRunSnapshot } from '../state/goalRun'
import { deviceTier, prefersReducedMotion } from '../utils/capabilities'
import { supportsWebGL } from '../utils/webgl'
import type { VisualEnvironmentId, VisualState } from './types'
import { normalizeVisualState } from './visualState'

/**
 * Phase 8 — REAL DATA BRIDGE.
 *
 * The single adapter the environments use to read JARVIS state. It reuses the
 * existing mirrors (jarvis.store capabilities/backend/camera/goalRun) and the
 * existing capability utils — no duplicate system/monitoring implementations.
 *
 * Honesty contract:
 *  - Every `MetricRow` value IS the real reported value, or `Unavailable`
 *    when the runtime genuinely cannot expose it. Nothing is fabricated.
 *  - Stale data is flagged (`stale: true`), never dressed up as live.
 */

export type MetricTone = 'ok' | 'warn' | 'err' | 'idle'

export interface MetricRow {
  label: string
  value: string
  available: boolean
  stale?: boolean
  tone?: MetricTone
}

export interface MetricSection {
  title: string
  rows: MetricRow[]
}

export interface HardwareInfo {
  platform: string
  browser: string | null
  cores: number | null
  deviceMemoryGiB: number | null
  tier: string
  webgl: boolean
  reducedMotion: boolean
  online: boolean | null
}

export interface EnvironmentSnapshot {
  environmentId: VisualEnvironmentId
  status: JarvisStatus
  /** Real engine status label (VERIFYING, LISTENING, …). */
  statusLabel: string
  visualState: VisualState
  speaking: boolean
  voiceState: string
  voiceArmed: boolean
  providerId: string
  camera: CameraUiState
  backend: BackendUiState
  capabilities: Capabilities
  task: TaskSnapshot | null
  goalRun: GoalRunSnapshot | null
  hardware: HardwareInfo
  devicesTotal: number
  devicesOnline: number
  lastActivity: { step: string; detail: string; status: string } | null
  now: number
}

export interface BridgeActivity {
  step: string
  detail: string
  status: string
}

export interface BridgeInput {
  environmentId: VisualEnvironmentId
  status: JarvisStatus
  isSpeaking: boolean
  goalRun: GoalRunSnapshot | null
  backend: BackendUiState
  camera: CameraUiState
  capabilities: Capabilities
  task: TaskSnapshot | null
  voiceState: string
  voiceArmed: boolean
  providerId: string
  activities: BridgeActivity[]
  hardware?: Partial<HardwareInfo>
}

export interface NavigatorLike {
  platform?: string
  userAgent?: string
  userAgentData?: { platform?: string }
  hardwareConcurrency?: number
  deviceMemory?: number
  onLine?: boolean
}

/** Pure hardware collection so the bridge is testable in node. */
export function collectHardwareFrom(nav: NavigatorLike | null): HardwareInfo {
  return {
    platform: nav?.userAgentData?.platform ?? nav?.platform ?? 'unknown',
    browser: nav?.userAgent ?? null,
    cores: nav?.hardwareConcurrency ?? null,
    deviceMemoryGiB: nav?.deviceMemory ?? null,
    tier: deviceTier(),
    webgl: supportsWebGL(),
    reducedMotion: prefersReducedMotion(),
    online: nav ? Boolean(nav.onLine) : null,
  }
}

function readNavigator(): NavigatorLike | null {
  return typeof navigator !== 'undefined' ? (navigator as NavigatorLike) : null
}

export const STALE_HEARTBEAT_MS = 45_000

export function buildEnvironmentSnapshot(
  input: BridgeInput,
  now = Date.now(),
): EnvironmentSnapshot {
  const hardware: HardwareInfo = { ...collectHardwareFrom(readNavigator()), ...input.hardware }
  const devicesTotal = input.backend.devices.length
  const devicesOnline = input.backend.devices.reduce(
    (n, d) => n + (d.online ? 1 : 0),
    0,
  )
  return {
    environmentId: input.environmentId,
    status: input.status,
    statusLabel: arcReactorPresentation(input.status, input.isSpeaking).label,
    visualState: normalizeVisualState({
      status: input.status,
      isSpeaking: input.isSpeaking,
      goalRun: input.goalRun,
      backendPhase: input.backend.phase,
    }),
    speaking: input.isSpeaking || input.status === 'speaking',
    voiceState: input.voiceState,
    voiceArmed: input.voiceArmed,
    providerId: input.providerId,
    camera: input.camera,
    backend: input.backend,
    capabilities: input.capabilities,
    task: input.task,
    goalRun: input.goalRun,
    hardware,
    devicesTotal,
    devicesOnline,
    lastActivity: input.activities[0] ?? null,
    now,
  }
}

/* ------------------------------- formatting ------------------------------- */

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '\u2014'
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 1) return '<1s'
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

export function timeAgo(at: number | null, now = Date.now()): string {
  if (at == null) return '\u2014'
  const diff = Math.max(0, now - at)
  if (diff < 5_000) return 'just now'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function isStale(
  lastAt: number | null,
  now: number,
  thresholdMs = STALE_HEARTBEAT_MS,
): boolean {
  if (lastAt == null) return true
  return now - lastAt > thresholdMs
}

function backendTone(connected: boolean, phase: string): MetricTone {
  if (connected) return 'ok'
  if (phase === 'giving_up') return 'err'
  if (phase === 'waiting' || phase === 'connecting') return 'warn'
  return 'idle'
}

function statusTone(status: JarvisStatus): MetricTone {
  switch (status) {
    case 'error':
    case 'failed':
      return 'err'
    case 'warning':
    case 'recovering':
    case 'retrying':
      return 'warn'
    case 'success':
    case 'verifying':
      return 'ok'
    default:
      return 'idle'
  }
}

/* ------------------------------ metric rows ------------------------------- */

export function systemMetrics(s: EnvironmentSnapshot): MetricRow[] {
  return [
    {
      label: 'CPU load',
      value: 'Unavailable',
      available: false,
      tone: 'idle',
    },
    {
      label: 'Memory',
      value:
        s.hardware.deviceMemoryGiB != null
          ? `${s.hardware.deviceMemoryGiB} GiB`
          : 'Unavailable',
      available: s.hardware.deviceMemoryGiB != null,
      tone: 'ok',
    },
    {
      label: 'Graphics (GPU)',
      value: s.hardware.webgl ? 'WebGL ready' : 'WebGL unavailable',
      available: true,
      tone: s.hardware.webgl ? 'idle' : 'warn',
    },
    {
      label: 'Network',
      value:
        s.hardware.online == null
          ? 'Unavailable'
          : s.hardware.online
            ? 'online'
            : 'offline',
      available: s.hardware.online != null,
      tone: s.hardware.online ? 'ok' : s.hardware.online == null ? 'idle' : 'err',
    },
    {
      label: 'Uptime',
      value:
        s.backend.health != null
          ? formatDuration(s.backend.health.uptimeMs)
          : 'Unavailable',
      available: s.backend.health != null,
      tone: 'idle',
    },
    {
      label: 'Platform',
      value: s.hardware.platform,
      available: true,
      tone: 'idle',
    },
    {
      label: 'Cores',
      value: s.hardware.cores != null ? `${s.hardware.cores}` : 'Unavailable',
      available: s.hardware.cores != null,
      tone: 'idle',
    },
  ]
}

export function coreMetrics(s: EnvironmentSnapshot): MetricRow[] {
  const connected = s.backend.phase === 'connected'
  return [
    {
      label: 'Execution',
      value: s.statusLabel,
      available: true,
      tone: statusTone(s.status),
    },
    {
      label: 'Visual state',
      value: s.visualState,
      available: true,
      tone: 'idle',
    },
    {
      label: 'Backend',
      value: connected
        ? `connected${s.backend.health ? ` \u00b7 ${s.backend.health.status}` : ''}`
        : s.backend.phase,
      available: true,
      tone: backendTone(connected, s.backend.phase),
    },
    {
      label: 'Native core',
      value:
        s.backend.health != null
          ? s.backend.health.native.connected &&
            s.backend.health.native.reachable
            ? `supervised \u00b7 v${
                s.backend.health.native.version ?? '?'
              }`
            : 'offline'
          : 'Unavailable',
      available: s.backend.health != null,
      tone:
        s.backend.health != null &&
        s.backend.health.native.connected &&
        s.backend.health.native.reachable
          ? 'ok'
          : s.backend.health != null
            ? 'warn'
            : 'idle',
    },
    {
      label: 'Voice',
      value: s.voiceArmed ? `${s.voiceState} \u00b7 armed` : s.voiceState,
      available: true,
      tone: s.voiceArmed ? 'ok' : 'idle',
    },
  ]
}

export function deviceMetrics(s: EnvironmentSnapshot): MetricRow[] {
  const connected = s.backend.phase === 'connected'
  const anyLiveHeartbeat = s.backend.devices.some(
    (d) => d.online && d.lastHeartbeatAt != null,
  )
  const staleHeartbeat = s.backend.devices.some(
    (d) => d.online && isStale(d.lastHeartbeatAt, s.now),
  )
  return [
    {
      label: 'Connected devices',
      value: connected
        ? `${s.devicesOnline}/${s.devicesTotal} online`
        : 'Disconnected',
      available: true,
      stale: connected && anyLiveHeartbeat && staleHeartbeat,
      tone: connected ? (s.devicesOnline > 0 ? 'ok' : 'idle') : 'warn',
    },
    {
      label: 'Last inbound',
      value: timeAgo(s.backend.lastInboundAt, s.now),
      available: s.backend.lastInboundAt != null,
      tone: 'idle',
    },
    {
      label: 'Camera',
      value: s.camera.active
        ? 'active'
        : s.camera.available
          ? 'ready'
          : 'unavailable',
      available: true,
      tone: s.camera.active ? 'ok' : s.camera.available ? 'idle' : 'warn',
    },
    {
      label: 'Camera permission',
      value: s.camera.permission,
      available: true,
      tone: s.camera.permission === 'granted' ? 'ok' : 'idle',
    },
  ]
}

export function taskMetrics(s: EnvironmentSnapshot): MetricRow[] {
  const plan = s.goalRun?.plan
  return [
    {
      label: 'Active task',
      value: s.task?.active
        ? `${s.task.step}/${s.task.total} ${s.task.status}`
        : 'none',
      available: true,
      tone: s.task?.active ? 'ok' : 'idle',
    },
    {
      label: 'Goal plan',
      value:
        plan && plan.active
          ? `${s.goalRun!.budget.remaining}/${s.goalRun!.budget.limit} steps left`
          : 'inactive',
      available: true,
      tone: plan && plan.active ? 'idle' : 'idle',
    },
  ]
}

export interface ControlSectionsOptions {
  includeProvider?: boolean
}

export function controlSections(
  s: EnvironmentSnapshot,
  options: ControlSectionsOptions = {},
): MetricSection[] {
  const sections: MetricSection[] = [
    { title: 'System', rows: systemMetrics(s) },
    { title: 'Core', rows: coreMetrics(s) },
    { title: 'Devices', rows: deviceMetrics(s) },
    { title: 'Tasks', rows: taskMetrics(s) },
  ]
  if (options.includeProvider) {
    sections[1]!.rows.push({
      label: 'Provider',
      value: s.providerId,
      available: true,
      tone: 'idle',
    })
  }
  return sections
}

/** Primary ring readouts for the Astra HUD (real sources only). */
export function hudTelemetry(s: EnvironmentSnapshot): MetricRow[] {
  return [
    {
      label: 'Mic',
      value: s.capabilities.microphoneAvailable ? 'on' : 'off',
      available: true,
      tone: s.capabilities.microphoneAvailable ? 'ok' : 'idle',
    },
    {
      label: 'Vision',
      value: s.capabilities.visionAvailable ? 'on' : 'off',
      available: true,
      tone: s.capabilities.visionAvailable ? 'ok' : 'idle',
    },
    {
      label: 'Camera',
      value: s.camera.active ? 'on' : 'off',
      available: true,
      tone: s.camera.active ? 'ok' : 'idle',
    },
    {
      label: 'Backend',
      value: s.backend.phase,
      available: true,
      tone: backendTone(s.backend.phase === 'connected', s.backend.phase),
    },
    {
      label: 'Devices',
      value: `${s.devicesOnline}/${s.devicesTotal}`,
      available: s.backend.phase === 'connected',
      tone: s.devicesOnline > 0 ? 'ok' : 'idle',
    },
  ]
}