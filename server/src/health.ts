/**
 * Health endpoint builder for the JARVIS Core backend (Phase 2.8).
 *
 * `/health` is the honest, aggregate state of the always-on runtime: backend
 * identity, native agent connection, the device registry, the browser
 * assistant mirror and the wake registry. Nothing here is fabricated; every
 * field comes from a real observed/measured source or is honestly absent.
 */

import type { BackendHealth, AssistantMirror, WakeState } from './types.js'
import type { NativeStatus } from './native.js'
import type { DeviceRegistry } from './registry.js'

export interface HealthContext {
  name: string
  version: string
  protocol: string
  pid: number
  startedAt: number
  now: number
  native: NativeStatus
  registry: DeviceRegistry
  assistant: AssistantMirror
  wake: WakeState
  filesCount: number
  dataDir: string
  lockFile?: string
  logFile?: string
}

export function buildHealth(context: HealthContext): BackendHealth {
  const devices = context.registry.list()
  const online = devices.filter((d) => d.online).length
  const nativeConnected = context.native.connected
  // Honest aggregate: degraded when the supervised native agent is not
  // connected, or the assistant has never reported in (no browser attached).
  const assistantAbsent = context.assistant.lastSeenAt === undefined
  const status: 'ok' | 'degraded' =
    nativeConnected && !assistantAbsent && context.registry.count() >= 0 ? 'ok' : 'degraded'

  return {
    name: context.name,
    version: context.version,
    protocol: context.protocol,
    status,
    pid: context.pid,
    startedAt: new Date(context.startedAt).toISOString(),
    uptimeMs: Math.max(0, context.now - context.startedAt),
    now: context.now,
    native: {
      supervising: context.native.supervising,
      connected: nativeConnected,
      reachable: context.native.reachable,
      childRunning: context.native.childRunning,
      childPid: context.native.childPid,
      protocol: context.native.protocol,
      version: context.native.version,
      error: context.native.error,
      restarts: context.native.restarts,
      lastProbeAt: context.native.lastProbeAt,
    },
    devices: {
      count: devices.length,
      online,
      list: devices,
    },
    assistant: context.assistant,
    wake: context.wake,
    files: {
      count: context.filesCount,
    },
    paths: {
      dataDir: context.dataDir,
      lockFile: context.lockFile,
      logFile: context.logFile,
    },
  }
}