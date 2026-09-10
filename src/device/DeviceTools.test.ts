import { describe, expect, it } from 'vitest'
import { createDeviceTools, resolveTargetInput } from './DeviceTools'
import type { DeviceProvider, DeviceNotifyResult } from './provider'
import type { DeviceRecord, NotifyRequest } from '../backend/types'
import { TRUSTED_DEVICES } from './trusted'

function seedRecords(): DeviceRecord[] {
  return TRUSTED_DEVICES.map((def, i) => ({
    id: def.id,
    name: def.name,
    type: def.type,
    platform: def.platform,
    connection: 'lan-bridge',
    capabilities: ['notifications', 'files', 'battery'],
    permissions: ['notify', 'inbound'],
    online: def.role === 'primary_pc' || def.id === 's26-ultra',
    health: def.role === 'primary_pc' || def.id === 's26-ultra' ? 'ok' : 'unknown',
    lastHeartbeatAt: def.id === 's26-ultra' ? 1000 : 0,
    registeredAt: i,
    trusted: true,
    role: def.role,
    battery: def.id === 's26-ultra' ? 82 : undefined,
    charging: def.id === 's26-ultra' ? true : undefined,
  }))
}

class ScriptedDeviceProvider implements DeviceProvider {
  records: DeviceRecord[] = seedRecords()
  notifyRequests: NotifyRequest[] = []
  notified: DeviceNotifyResult = { delivered: true, deliveredTo: ['s26-ultra'] }
  available = true

  capabilities() {
    return { available: this.available, reason: this.available ? undefined : 'backend down' }
  }

  refresh(): Promise<DeviceRecord[]> {
    return Promise.resolve(this.records)
  }

  notify(request: NotifyRequest): Promise<DeviceNotifyResult> {
    this.notifyRequests.push(request)
    return Promise.resolve({ ...this.notified, deliveredTo: this.notified.deliveredTo })
  }

  sendFile(name: string, _content: string, deviceId?: string) {
    return Promise.resolve({ ok: true, file: { id: 'f-1', name, size: 3, url: '/api/files/f-1', deviceId } })
  }
}

function notifyTool(tool: DeviceProvider) {
  return createDeviceTools(tool).find((t) => t.id === 'device.notify')!
}
function listTool(tool: DeviceProvider) {
  return createDeviceTools(tool).find((t) => t.id === 'device.list')!
}
function statusTool(tool: DeviceProvider) {
  return createDeviceTools(tool).find((t) => t.id === 'device.status')!
}
function sendFileTool(tool: DeviceProvider) {
  return createDeviceTools(tool).find((t) => t.id === 'device.sendFile')!
}

describe('Phase 2.8 — device tools on the four-device ecosystem', () => {
  it('resolveTargetInput maps natural phrases and rejects ambiguity/unknown honestly', () => {
    expect(resolveTargetInput('my phone').deviceId).toBe('s26-ultra')
    expect(resolveTargetInput('dell').deviceId).toBe('dell-laptop')
    expect(resolveTargetInput('').deviceId).toBeUndefined()
    expect(resolveTargetInput('the microwave').error).toBeDefined()
    expect(resolveTargetInput('both s23 and s26').error).toBeDefined()
  })

  it('device.list reports the trusted ecosystem with roles and honest liveness', async () => {
    const provider = new ScriptedDeviceProvider()
    const result = await listTool(provider).execute({ query: 'list my devices', params: {} }, { requestId: '1' })
    expect(result.ok).toBe(true)
    const data = result.data as { devices: DeviceRecord[]; count: number; online: number }
    expect(data.count).toBe(4)
    expect(data.online).toBe(2)
    expect(result.message).toContain('S26 Ultra')
    expect(result.message).toContain('battery 82%')
  })

  it('device.status focuses a single device by phrase and marks offline state honestly', async () => {
    const provider = new ScriptedDeviceProvider()
    const focus = await statusTool(provider).execute({ query: 'is my other phone online', params: { device: 'my other phone' } }, { requestId: '1' })
    const data = focus.data as { devices: DeviceRecord[] }
    expect(data.devices[0]!.id).toBe('s23-fe')
    expect(focus.message).toContain('offline')

    const all = await statusTool(provider).execute({ query: 'device status', params: {} }, { requestId: '2' })
    expect((all.data as { devices: DeviceRecord[] }).devices).toHaveLength(4)
  })

  it('device.notify sends the RESOLVED trusted id to the backend, not the phrase', async () => {
    const provider = new ScriptedDeviceProvider()
    const result = await notifyTool(provider).execute(
      { query: 'notify my phone', params: { device: 'my phone', title: 'Reminder', message: 'Call mom' } },
      { requestId: '1' },
    )
    expect(result.ok).toBe(true)
    expect(provider.notifyRequests[0]!.device).toBe('s26-ultra')
  })

  it('device.notify refuses an unknown target before any backend call', async () => {
    const provider = new ScriptedDeviceProvider()
    const result = await notifyTool(provider).execute(
      { query: 'notify the microwave', params: { device: 'the microwave', title: 'T', message: 'M' } },
      { requestId: '1' },
    )
    expect(result.ok).toBe(false)
    expect(provider.notifyRequests).toHaveLength(0)
    expect(result.message).toContain('four trusted')
  })

  it('device.notify refuses an offline trusted device with an honest reason', async () => {
    const provider = new ScriptedDeviceProvider()
    const result = await notifyTool(provider).execute(
      { query: 'notify s23', params: { device: 's23-fe', title: 'T', message: 'M' } },
      { requestId: '1' },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('offline')
    expect(provider.notifyRequests).toHaveLength(0)
  })

  it('device.sendFile stores for a target and reflects offline delivery honestly', async () => {
    const provider = new ScriptedDeviceProvider()
    const result = await sendFileTool(provider).execute(
      { query: 'send notes to s23', params: { device: 's23-fe', name: 'notes.txt', content: 'aGk=' } },
      { requestId: '1' },
    )
    expect(result.ok).toBe(true)
    expect(result.message).toContain('offline')
    const data = result.data as { file: { deviceId?: string } }
    expect(data.file.deviceId).toBe('s23-fe')
  })
})