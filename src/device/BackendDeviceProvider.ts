/**
 * BackendDeviceProvider — the real (non-fabricated) implementation of the
 * device bridge seam, backed by the persistent JARVIS Core backend.
 */

import type { DeviceRecord, NotifyRequest } from '../backend/types'
import type { BackendClient } from '../backend/BackendClient'
import type { DeviceCapabilities, DeviceNotifyResult, DeviceProvider, DeviceTransferResult } from './provider'

export class BackendDeviceProvider implements DeviceProvider {
  private readonly client: BackendClient
  private readonly reachable: () => boolean

  constructor(client: BackendClient, reachable: () => boolean = () => client.hasConnected) {
    this.client = client
    this.reachable = reachable
  }

  capabilities(): DeviceCapabilities {
    const reachable = this.reachable()
    return {
      available: reachable,
      reason: reachable ? undefined : 'JARVIS Core backend is not connected, so no companion devices can be reached right now.',
    }
  }

  async refresh(): Promise<DeviceRecord[]> {
    if (!this.reachable()) return []
    return this.client.listDevices()
  }

  async notify(request: NotifyRequest): Promise<DeviceNotifyResult> {
    if (!this.reachable()) return { delivered: false, deliveredTo: [], reason: 'JARVIS Core backend is not connected.' }
    const result = await this.client.notify(request)
    return { delivered: result.delivered, deliveredTo: result.deliveredTo, reason: result.reason }
  }

  async sendFile(name: string, contentBase64: string, deviceId?: string): Promise<DeviceTransferResult> {
    if (!this.reachable()) return { ok: false, error: 'JARVIS Core backend is not connected.' }
    const result = await this.client.sendFile(name, contentBase64, deviceId)
    return { ok: result.ok, file: result.file, error: result.error }
  }

  async openUrl(deviceId: string, url: string): Promise<{ success: boolean; error?: string; reason?: string }> {
    if (!this.reachable()) return { success: false, error: 'JARVIS Core backend is not connected.' }
    try {
      const res = await this.client.sendOpenUrl(deviceId, url)
      return { success: res.ok, error: res.error, reason: res.reason }
    } catch {
      return { success: false, error: 'Could not reach backend to open URL.' }
    }
  }

  async refreshDevices(): Promise<DeviceRecord[]> {
    if (!this.reachable()) return []
    return this.client.listDevices()
  }
}