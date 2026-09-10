import { describe, expect, it, beforeEach } from 'vitest'
import { AssistantEngine } from '../engine/AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from '../engine/provider'
import type { DeviceProvider } from './provider'
import type { DeviceRecord } from '../backend/types'
import { useConversationStore } from '../state/conversation.store'
import { useJarvisStore } from '../state/jarvis.store'
import { resetProviders } from '../engine/providers'

/**
 * Phase 2.8 — the device bridge through the REAL engine:
 *  - zero device.* tools (and zero device capabilities) while no provider exists;
 *  - real tools + capability catalogue once a provider is bound;
 *  - honest delivery reporting — `device.notify` never claims a device got a
 *    message the backend did not confirm.
 */

function stubBrowserStorage(): void {
  const backing = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  ;(globalThis as Record<string, unknown>).window = {
    localStorage,
    setTimeout: (_fn: () => void) => 0,
  }
}

class ScriptedProvider implements AIProvider {
  readonly id = 'scripted'
  readonly label = 'Scripted'
  requests: AIRequest[] = []
  private readonly queue: AIResponse[]

  constructor(script: AIResponse[]) {
    this.queue = [...script]
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    this.requests.push(request)
    const next = this.queue.shift()
    if (!next) return { text: 'No more scripted steps.' }
    return next
  }

  isConfigured(): boolean {
    return true
  }

  isReachable(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

function toolReq(toolId: string, payload: Record<string, unknown> = {}): AIResponse {
  return { text: '', toolRequests: [{ toolId, payload }] }
}

const text = (value: string): AIResponse => ({ text: value })

const DEVICE: DeviceRecord = {
  id: 'pixel-9',
  name: 'Pixel 9',
  type: 'android',
  connection: 'lan-web',
  capabilities: ['notifications', 'files', 'inbound'],
  permissions: ['notify', 'inbound'],
  online: true,
  health: 'ok',
  lastHeartbeatAt: 1,
  registeredAt: 0,
  platform: 'unknown',
  trusted: false,
}

class FakeDeviceProvider implements DeviceProvider {
  available = true
  delivered = true
  reason: string | undefined

  capabilities() {
    return { available: this.available, reason: this.available ? undefined : 'backend down' }
  }

  refresh(): Promise<DeviceRecord[]> {
    return Promise.resolve([DEVICE])
  }

  notify() {
    return Promise.resolve({ delivered: this.delivered, deliveredTo: this.delivered ? ['pixel-9'] : [], reason: this.reason })
  }

  sendFile(name: string) {
    return Promise.resolve({ ok: true, file: { id: 'f-1', name, size: 3, url: '/api/files/f-1' } })
  }
}

describe('Phase 2.8 — device bridge seams', () => {
  beforeEach(() => {
    stubBrowserStorage()
    resetProviders()
    useJarvisStore.getState().resetRun()
    useConversationStore.getState().clearConversation()
  })

  it('registers NO device tools or capabilities without a provider', () => {
    const provider = new ScriptedProvider([])
    const engine = new AssistantEngine({ providers: [provider] })
    engine.on(() => undefined)
    expect(engine.tools.get('device.list')).toBeUndefined()
    expect(engine.tools.get('device.notify')).toBeUndefined()
    const ids = engine.capabilityCatalog().map((c) => c.id)
    expect(ids).not.toContain('list_devices')
    expect(ids).not.toContain('send_device_notification')
    void engine
  })

  it('registers device tools and capability catalogue entries when a provider is bound', async () => {
    const device = new FakeDeviceProvider()
    const provider = new ScriptedProvider([toolReq('device.list'), text('devices:')])
    const engine = new AssistantEngine({ providers: [provider], device })
    engine.on(() => undefined)
    expect(engine.tools.get('device.list')).toBeDefined()
    expect(engine.tools.get('device.notify')).toBeDefined()
    expect(engine.tools.get('device.sendFile')).toBeDefined()
    const ids = engine.capabilityCatalog().map((c) => c.id)
    expect(ids).toContain('list_devices')
    expect(ids).toContain('send_device_notification')
    expect(ids).toContain('transfer_to_device')
    await engine.process('list my devices')
    const last = provider.requests[provider.requests.length - 1]
    expect(JSON.stringify(last?.messages ?? [])).toContain('Pixel 9')
    void engine
  })

  it('device.notify reports honest failure when the backend did not deliver', async () => {
    const device = new FakeDeviceProvider()
    device.delivered = false
    device.reason = 'no device is online right now'
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])], device })
    engine.on(() => undefined)
    const tool = engine.tools.get('device.notify')
    expect(tool).toBeDefined()
    const result = await tool!.execute({ query: 'notify my phone', params: { title: 'T', message: 'M' } }, { requestId: '1' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('no device is online right now')
    void engine
  })

  it('reports deviceBridgeAvailable through the real capability snapshot', async () => {
    const device = new FakeDeviceProvider()
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])], device })
    engine.on(() => undefined)
    await engine.start()
    const caps = useJarvisStore.getState().capabilities
    expect(caps.deviceBridgeAvailable).toBe(true)
  })

  it('detaching the provider removes the device tools AND capability entries — nothing lingers', () => {
    const device = new FakeDeviceProvider()
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])], device })
    engine.on(() => undefined)
    expect(engine.tools.get('device.list')).toBeDefined()
    expect(engine.capabilityCatalog().map((c) => c.id)).toContain('list_devices')

    engine.attachDevice(undefined)
    expect(engine.tools.get('device.list')).toBeUndefined()
    expect(engine.tools.get('device.notify')).toBeUndefined()
    expect(engine.tools.get('device.sendFile')).toBeUndefined()
    const ids = engine.capabilityCatalog().map((c) => c.id)
    expect(ids).not.toContain('list_devices')
    expect(ids).not.toContain('send_device_notification')
    expect(ids).not.toContain('transfer_to_device')
  })
})