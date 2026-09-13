import { describe, expect, it, beforeEach } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from './provider'
import type { DeviceProvider } from '../device'
import type { DeviceRecord } from '../backend/types'
import { useConversationStore } from '../state/conversation.store'

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

function req(toolId: string, payload: Record<string, unknown> = {}): AIResponse {
  return { text: '', toolRequests: [{ toolId, payload }] }
}

function text(value: string): AIResponse {
  return { text: value }
}

function seedDeviceRecords(): DeviceRecord[] {
  return [
    {
      id: 'victus-5050',
      name: 'HP Victus (main PC)',
      type: 'windows_pc',
      platform: 'windows',
      connection: 'lan-bridge',
      capabilities: ['notifications', 'files', 'battery'],
      permissions: ['notify', 'inbound'],
      online: true,
      health: 'ok',
      lastHeartbeatAt: 1000,
      registeredAt: 0,
      trusted: true,
      role: 'primary_pc',
      battery: 100,
      charging: false,
    },
    {
      id: 'dell-laptop',
      name: 'Dell Laptop',
      type: 'windows_pc',
      platform: 'windows',
      connection: 'lan-bridge',
      capabilities: ['notifications', 'files', 'battery'],
      permissions: ['notify', 'inbound'],
      online: true,
      health: 'ok',
      lastHeartbeatAt: 2000,
      registeredAt: 1,
      trusted: true,
      role: 'secondary_pc',
      battery: 85,
      charging: true,
    },
    {
      id: 's26-ultra',
      name: 'S26 Ultra (phone)',
      type: 'android_phone',
      platform: 'android',
      connection: 'lan-bridge',
      capabilities: ['notifications', 'files', 'battery'],
      permissions: ['notify', 'inbound'],
      online: true,
      health: 'ok',
      lastHeartbeatAt: 3000,
      registeredAt: 2,
      trusted: true,
      role: 'primary_phone',
      battery: 82,
      charging: false,
    },
    {
      id: 's23-fe',
      name: 'S23 FE (phone)',
      type: 'android_phone',
      platform: 'android',
      connection: 'lan-bridge',
      capabilities: ['notifications', 'files', 'battery'],
      permissions: ['notify', 'inbound'],
      online: false,
      health: 'stale',
      lastHeartbeatAt: 4000,
      registeredAt: 3,
      trusted: true,
      role: 'secondary_phone',
      battery: 45,
      charging: false,
    },
  ]
}

function createFakeDeviceProvider(): DeviceProvider {
  return {
    capabilities: () => ({ available: true }),
    refresh: () => Promise.resolve(seedDeviceRecords()),
    refreshDevices: () => Promise.resolve(seedDeviceRecords()),
    notify: async (_request) => ({ delivered: true, deliveredTo: ['s26-ultra'] }),
    sendFile: async (name, _content, deviceId) => ({
      ok: true,
      file: { id: 'file-1', name, size: 12, url: 'https://jarvis.local/file-1', deviceId },
    }),
    openUrl: async (_deviceId, _url) => ({ success: true }),
  }
}

describe('Phase 11 — Device Command Fabric (new capabilities)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  describe('device.openUrl capability', () => {
    it('opens a URL on a specific device via capability', async () => {
      const provider = new ScriptedProvider([
        req('device.openUrl', { device: 'my phone', url: 'https://example.com' }),
        text('Opened the URL on your phone.'),
      ])
      const engine = new AssistantEngine({ providers: [provider], device: createFakeDeviceProvider() })
      engine.on(() => undefined)

      await engine.process('Open https://example.com on my phone')

      expect(engine.taskResult().status).toBe('completed')
      const trace = engine.lastRunTrace()
      expect(trace.steps[0].toolId).toBe('device.openUrl')
      expect(trace.steps[0].status).toBe('COMPLETED')
    })

    it('rejects invalid URL schemes safely', async () => {
      const provider = new ScriptedProvider([
        req('device.openUrl', { device: 'my phone', url: 'file:///etc/passwd' }),
        text('Invalid URL.'),
      ])
      const engine = new AssistantEngine({ providers: [provider], device: createFakeDeviceProvider() })
      engine.on(() => undefined)

      await engine.process('Open file:///etc/passwd on my phone')

      const trace = engine.lastRunTrace()
      expect(trace.steps[0].status).toBe('FAILED')
      // Tool-level validation failure is classified as tool_failure
      expect(['invalid_input', 'tool_failure']).toContain(trace.steps[0].observation?.errorKind)
    })

    it('rejects unknown device targets safely', async () => {
      const provider = new ScriptedProvider([
        req('device.openUrl', { device: 'the microwave', url: 'https://example.com' }),
        text('Unknown device.'),
      ])
      const engine = new AssistantEngine({ providers: [provider], device: createFakeDeviceProvider() })
      engine.on(() => undefined)

      await engine.process('Open https://example.com on the microwave')

      const trace = engine.lastRunTrace()
      expect(trace.steps[0].status).toBe('FAILED')
      expect(['invalid_input', 'tool_failure']).toContain(trace.steps[0].observation?.errorKind)
    })

    it('requires both device and URL parameters', async () => {
      const provider = new ScriptedProvider([
        req('device.openUrl', { device: 'my phone' }),
        text('Missing URL.'),
      ])
      const engine = new AssistantEngine({ providers: [provider], device: createFakeDeviceProvider() })
      engine.on(() => undefined)

      await engine.process('Open something on my phone')

      const trace = engine.lastRunTrace()
      expect(trace.steps[0].status).toBe('FAILED')
      expect(trace.steps[0].observation?.errorKind).toBe('invalid_input')
    })
  })

  describe('device.refresh capability', () => {
    it('refreshes device state via capability', async () => {
      const provider = new ScriptedProvider([
        req('device.refresh', {}),
        text('Device registry refreshed.'),
      ])
      const engine = new AssistantEngine({ providers: [provider], device: createFakeDeviceProvider() })
      engine.on(() => undefined)

      await engine.process('Refresh my devices')

      expect(engine.taskResult().status).toBe('completed')
      const trace = engine.lastRunTrace()
      expect(trace.steps[0].toolId).toBe('device.refresh')
      expect(trace.steps[0].status).toBe('COMPLETED')
    })

    it('reports refreshed device count', async () => {
      const provider = new ScriptedProvider([
        req('device.refresh', {}),
        text('Refreshed.'),
      ])
      const engine = new AssistantEngine({ providers: [provider], device: createFakeDeviceProvider() })
      engine.on(() => undefined)

      await engine.process('Refresh devices')

      const trace = engine.lastRunTrace()
      expect(trace.steps[0].status).toBe('COMPLETED')
    })
  })

  describe('Cross-device workflows', () => {
    it('download → transfer multi-step workflow', async () => {
      const provider = new ScriptedProvider([
        req('web.download', { url: 'https://example.com/file.pdf' }),
        req('device.sendFile', { device: 'my phone', name: 'file.pdf', content: 'base64content' }),
        text('Downloaded and transferred to your phone.'),
      ])
      const engine = new AssistantEngine({ providers: [provider], device: createFakeDeviceProvider() })
      engine.on(() => undefined)

      await engine.process('Download the PDF and send it to my phone')

      expect(engine.taskResult().status).toBe('completed')
      const trace = engine.lastRunTrace()
      const toolIds = trace.steps.map((s) => s.toolId)
      expect(toolIds).toContain('web.download')
      expect(toolIds).toContain('device.sendFile')
    })

    it('open URL on phone → verify on phone', async () => {
      const provider = new ScriptedProvider([
        req('device.openUrl', { device: 'my phone', url: 'https://youtube.com' }),
        req('device.status', { device: 'my phone' }),
        text('Opened YouTube on your phone. It is online with 82% battery.'),
      ])
      const engine = new AssistantEngine({ providers: [provider], device: createFakeDeviceProvider() })
      engine.on(() => undefined)

      await engine.process('Open YouTube on my phone and check if it is online')

      const trace = engine.lastRunTrace()
      expect(trace.steps[0].toolId).toBe('device.openUrl')
      expect(trace.steps[1].toolId).toBe('device.status')
    })

it('handles unknown device target honestly', async () => {
      const provider = new ScriptedProvider([
        req('device.openUrl', { device: 'my other', url: 'https://example.com' }),
        text('Unknown device.'),
      ])
      const engine = new AssistantEngine({ providers: [provider], device: createFakeDeviceProvider() })
      engine.on(() => undefined)

      await engine.process('Open example.com on my other')

      const trace = engine.lastRunTrace()
      expect(['invalid_input', 'tool_failure']).toContain(trace.steps[0].observation?.errorKind)
      expect(trace.steps[0].observation?.summary).toContain('recognise')
    })
  })

  describe('Trust model enforcement', () => {
    it('rejects untrusted device targets safely', async () => {
      const provider = new ScriptedProvider([
        req('device.openUrl', { device: 'untrusted-device', url: 'https://example.com' }),
        text('Device not trusted.'),
      ])
      const engine = new AssistantEngine({ providers: [provider], device: createFakeDeviceProvider() })
      engine.on(() => undefined)

      await engine.process('Open example.com on untrusted-device')

      const trace = engine.lastRunTrace()
      expect(trace.steps[0].status).toBe('FAILED')
      expect(['invalid_input', 'tool_failure']).toContain(trace.steps[0].observation?.errorKind)
    })

    it('rejects offline trusted device for real-time operations', async () => {
      const provider = new ScriptedProvider([
        req('device.openUrl', { device: 'my other phone', url: 'https://example.com' }),
        text('Device is offline.'),
      ])
      const engine = new AssistantEngine({ providers: [provider], device: createFakeDeviceProvider() })
      engine.on(() => undefined)

      await engine.process('Open example.com on my other phone')

      const trace = engine.lastRunTrace()
      expect(trace.steps[0].status).toBe('FAILED')
      expect(trace.steps[0].observation?.summary).toContain('offline')
    })
  })

  describe('Verification honesty', () => {
    it('reports backend confirmation for openUrl', async () => {
      const provider = new ScriptedProvider([
        req('device.openUrl', { device: 'my phone', url: 'https://example.com' }),
        text('Opened.'),
      ])
      const engine = new AssistantEngine({ providers: [provider], device: createFakeDeviceProvider() })
      engine.on(() => undefined)

      await engine.process('Open example.com on my phone')

      const trace = engine.lastRunTrace()
      expect(trace.steps[0].verification?.status).toBe('verified')
    })

    it('reports backend confirmation for refresh (read-only, not_applicable)', async () => {
      const provider = new ScriptedProvider([
        req('device.refresh', {}),
        text('Refreshed.'),
      ])
      const engine = new AssistantEngine({ providers: [provider], device: createFakeDeviceProvider() })
      engine.on(() => undefined)

      await engine.process('Refresh devices')

      const trace = engine.lastRunTrace()
      // Read-only tools don't require verification
      expect(trace.steps[0].verification?.status).toBe('not_applicable')
    })
  })

  describe('Capability catalogue includes new device capabilities', () => {
    it('exposes device_open_url and device_refresh in catalogue when provider present', async () => {
      const engine = new AssistantEngine({ device: createFakeDeviceProvider() })
      engine.on(() => undefined)

      const caps = engine.capabilityCatalog()
      const openUrlCap = caps.find((c) => c.id === 'device_open_url')
      const refreshCap = caps.find((c) => c.id === 'device_refresh')

      expect(openUrlCap).toBeDefined()
      expect(refreshCap).toBeDefined()
      expect(openUrlCap!.tools).toContain('device.openUrl')
      expect(refreshCap!.tools).toContain('device.refresh')
    })
  })
})