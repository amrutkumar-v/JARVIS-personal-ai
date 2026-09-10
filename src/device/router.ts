/**
 * Device router (Phase 2.8) — resolves a target to an honest route.
 *
 * The backend bridge is the transport for phones and the Dell until those run
 * their own bridges; the host PC is 'local' by role but still routes through
 * the backend SSE hub for reachable listeners. The router NEVER guesses: an
 * offline, unpaired, or unknown target is reported unavailable with a reason
 * before any request is attempted.
 */

import type { DeviceRecord } from '../backend/types'
import { isTrustedDevice, trustedDeviceById } from './trusted'

export type DeviceTransport = 'backend' | 'local-host'

export interface DeviceRoute {
  deviceId: string
  transport: DeviceTransport
  available: boolean
  reason?: string
}

const BACKEND_DOWN = 'JARVIS Core backend is not connected, so no device can be reached right now.'

export function routeDeviceTarget(records: DeviceRecord[], target: string | undefined): DeviceRoute {
  const raw = (target ?? '').trim().toLowerCase()

  // Broadcast: honest wherever the registry snapshot is.
  if (!raw || raw === 'all') {
    if (records.length === 0) return { deviceId: 'all', transport: 'backend', available: false, reason: BACKEND_DOWN }
    if (!records.some((d) => d.online)) {
      return { deviceId: 'all', transport: 'backend', available: false, reason: 'no device is online right now.' }
    }
    return { deviceId: 'all', transport: 'backend', available: true }
  }

  if (!isTrustedDevice(raw)) {
    return {
      deviceId: raw,
      transport: 'backend',
      available: false,
      reason: `"${raw}" is not one of your four trusted JARVIS devices (victus-5050, dell-laptop, s26-ultra, s23-fe).`,
    }
  }

  if (records.length === 0) return { deviceId: raw, transport: 'backend', available: false, reason: BACKEND_DOWN }

  const record = records.find((d) => d.id === raw)
  if (!record) {
    return {
      deviceId: raw,
      transport: 'backend',
      available: false,
      reason: `"${raw}" is not registered with JARVIS Core right now.`,
    }
  }
  if (!record.online) {
    const name = trustedDeviceById(raw)?.name ?? raw
    return { deviceId: raw, transport: 'backend', available: false, reason: `${name} is offline right now.` }
  }
  return { deviceId: raw, transport: 'backend', available: true }
}