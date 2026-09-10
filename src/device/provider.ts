/**
 * Device bridge capability seam (Phase 2.8).
 *
 * The engine talks to companion devices (phones, other web pages on the LAN)
 * exclusively through this OPTIONAL provider. When the persistent JARVIS Core
 * backend is unreachable the provider reports `available: false` and no
 * device.* tools are registered — the model can never claim phone reach it
 * does not have.
 */

import type { DeviceRecord, NotifyRequest } from '../backend/types'

export interface DeviceCapabilities {
  available: boolean
  reason?: string
}

export interface DeviceNotifyResult {
  delivered: boolean
  deliveredTo: string[]
  reason?: string
}

export interface DeviceTransferResult {
  ok: boolean
  file?: { id: string; name: string; size: number; url: string; deviceId?: string }
  error?: string
}

export interface DeviceProvider {
  capabilities(): DeviceCapabilities
  /** Live device table from the backend (empty when unreachable). */
  refresh(): Promise<DeviceRecord[]>
  /** Fan a notification out; `delivered` is true only when a device got it. */
  notify(request: NotifyRequest): Promise<DeviceNotifyResult>
  /** Store a bounded file for a companion device to download. */
  sendFile(name: string, contentBase64: string, deviceId?: string): Promise<DeviceTransferResult>
}