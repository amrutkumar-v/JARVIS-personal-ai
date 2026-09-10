import { beforeEach, describe, expect, it } from 'vitest'
import { AssistantEngine } from '../AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from '../provider'
import type { DeviceProvider } from '../../device'
import type { DeviceRecord } from '../../backend/types'
import { PersonalAICore } from './orchestrator'
import type { OrchestrationRequest, PersonalAICoreView } from './types'
import { useConversationStore } from '../../state/conversation.store'

/**
 * Phase 3.0A — the Personal AI Core turns raw input into ONE structured
 * OrchestrationRequest through the REAL Phase 2.x building blocks (goal
 * understanding, capability discovery, device routing). No goal is executed.
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

function record(partial: Partial<DeviceRecord>): DeviceRecord {
  return {
    id: 'unknown',
    name: 'Unknown',
    type: 'windows_pc',
    connection: 'lan',
    capabilities: [],
    permissions: [],
    online: true,
    health: 'ok',
    lastHeartbeatAt: Date.now(),
    registeredAt: Date.now(),
    platform: 'windows',
    trusted: true,
    ...partial,
  }
}

const DEVICES: DeviceRecord[] = [
  record({ id: 'victus-5050', name: 'HP Victus', type: 'windows_pc', platform: 'windows', role: 'primary_pc' }),
  record({ id: 'dell-laptop', name: 'Dell Laptop', type: 'windows_pc', platform: 'windows', role: 'secondary_pc' }),
  record({ id: 's26-ultra', name: 'S26 Ultra', type: 'android_phone', platform: 'android', role: 'primary_phone', battery: 80, charging: true }),
  record({ id: 's23-fe', name: 'S23 FE', type: 'android_phone', platform: 'android', role: 'secondary_phone' }),
]

const FULL_CATALOG = [
  'perform_calculation', 'tell_time', 'system_inquiry',
  'query_memory', 'store_memory',
  'list_directory', 'read_file_contents', 'search_files', 'inspect_file',
  'create_directory', 'write_to_file', 'copy_file', 'move_file', 'delete_file',
  'list_applications', 'application_status', 'open_application',
  'list_windows', 'window_status', 'observe_desktop',
  'move_cursor', 'click_at', 'double_click_at', 'right_click_at', 'scroll_at',
  'press_key', 'press_hotkey', 'type_text', 'focus_window',
  'visual_inspect', 'visual_click', 'visual_type',
  'list_devices', 'send_device_notification', 'transfer_to_device',
  'web_search', 'web_read_page', 'web_download',
  'camera_capture',
]

function makeView(options?: {
  devices?: DeviceRecord[]
  catalog?: string[]
  hasActiveTask?: boolean
  artifacts?: Array<{ type: string; description: string; value: string }>
  web?: boolean
}): PersonalAICoreView {
  const devices = options?.devices ?? DEVICES
  const catalog = options?.catalog ?? FULL_CATALOG
  const web = options?.web ?? true
  return {
    capabilityCatalog: () => catalog.map((id) => ({ id })),
    taskContextStore: options?.artifacts
      ? { getContext: () => ({ artifacts: options.artifacts }) }
      : undefined,
    deviceProvider: {
      capabilities: () => ({ available: true }),
      refresh: () => Promise.resolve(devices),
    },
    hasActiveTask: () => options?.hasActiveTask ?? false,
    fileSystemProvider: {},
    applicationProvider: {},
    observationProvider: {},
    desktopProvider: {},
    visionProvider: undefined,
    cameraProvider: undefined,
    webProvider: web ? {} : undefined,
  }
}

describe('Phase 3.0A — Personal AI Core central orchestration', () => {
  const core = new PersonalAICore()

  it('1 — simple question: no fabricated device target', async () => {
    const request = await core.orchestrate('What is 25 × 40?', makeView())
    expect(request.requestClass).toBe('question')
    expect(request.confidence).toBeGreaterThanOrEqual(0.8)
    expect(request.requiresContext).toBe(false)
    expect(request.isContinuation).toBe(false)
    expect(request.targetDevices).toEqual([])
    expect(request.targets).toEqual([])
  })

  it('2 — device status request suggests the device capability', async () => {
    const request = await core.orchestrate('What devices are connected?', makeView())
    expect(request.requestClass).toBe('status_request')
    expect(request.confidence).toBeGreaterThanOrEqual(0.9)
    expect(request.suggestedCapabilities).toContain('list_devices')
    expect(request.targetDevices).toEqual([])
  })

  it('3 — explicit Victus command routes to the primary PC', async () => {
    const request = await core.orchestrate('Open Chrome on my Victus.', makeView())
    expect(request.requestClass).toBe('device_operation')
    expect(request.targetDevices).toEqual(['victus-5050'])
    expect(request.targets).toHaveLength(1)
    expect(request.targets[0].deviceId).toBe('victus-5050')
    expect(request.targets[0].transport).toBe('backend')
    expect(request.targets[0].available).toBe(true)
    expect(request.implicitTargetDevice).toBeUndefined()
  })

  it('4 — explicit Dell command routes to the secondary PC', async () => {
    const request = await core.orchestrate('Open Chrome on my Dell.', makeView())
    expect(request.requestClass).toBe('device_operation')
    expect(request.targetDevices).toEqual(['dell-laptop'])
    expect(request.targets[0].deviceId).toBe('dell-laptop')
    expect(request.targets[0].available).toBe(true)
  })

  it('5 — "my phone" routes to the primary phone (s26-ultra)', async () => {
    const request = await core.orchestrate('Send a file to my phone.', makeView())
    expect(request.requestClass).toBe('cross_device_workflow')
    expect(request.targetDevices).toEqual(['s26-ultra'])
    expect(request.targets[0].deviceId).toBe('s26-ultra')
  })

  it('6 — "my S23" routes to the secondary phone (s23-fe)', async () => {
    const request = await core.orchestrate('Send it to my S23.', makeView())
    expect(request.requestClass).toBe('cross_device_workflow')
    expect(request.targetDevices).toEqual(['s23-fe'])
    expect(request.targets[0].deviceId).toBe('s23-fe')
  })

  it('7 — web request suggests the web capabilities it needs', async () => {
    const request = await core.orchestrate('Search the web for the official NVIDIA driver.', makeView())
    expect(request.requestClass).toBe('web_research')
    expect(request.requiresContext).toBe(false)
    expect(request.suggestedCapabilities).toContain('web_search')
    expect(request.suggestedCapabilities).not.toContain('web_fetch')
    expect(request.targetDevices).toEqual([])
  })

  it('8 — deictic follow-up after a task is a continuation with previous-task context', async () => {
    const request = await core.orchestrate('Download it.', makeView({
      hasActiveTask: true,
      artifacts: [{ type: 'url', description: 'NVIDIA driver page', value: 'https://nvidia.com/driver' }],
    }))
    expect(request.requestClass).toBe('follow_up')
    expect(request.requiresContext).toBe(true)
    expect(request.isContinuation).toBe(true)
    expect(request.contextReference).toBe('previous_task_result')
    expect(request.targetDevices).toEqual([])
    expect(request.entities.description).toBe('NVIDIA driver page')
  })

  it('9 — hard stop is a cancellation, not a continuation', async () => {
    const request = await core.orchestrate('Stop.', makeView())
    expect(request.requestClass).toBe('cancellation')
    expect(request.isContinuation).toBe(false)
    expect(request.targetDevices).toEqual([])
    expect(request.suggestedCapabilities).toEqual([])
  })

  it('10 — conversational small talk never invents an action', async () => {
    const request = await core.orchestrate('Good morning, JARVIS.', makeView())
    expect(request.requestClass).toBe('conversation')
    expect(request.targetDevices).toEqual([])
    expect(request.suggestedCapabilities).toEqual([])
    expect(request.isContinuation).toBe(false)
  })

  it('11 — an unresolved deictic reference never fabricates a device target', async () => {
    const request = await core.orchestrate('Send it there.', makeView())
    expect(request.requestClass).toBe('follow_up')
    expect(request.requiresContext).toBe(true)
    expect(request.contextReference).toBe('unresolved_reference')
    expect(request.targetDevices).toEqual([])
    expect(request.targets).toEqual([])
    expect(request.implicitTargetDevice).toBeUndefined()
  })

  it('12 — registered-but-unreachable capabilities are reported unavailable, never promised', async () => {
    const request = await core.orchestrate('Search the web for drivers.', makeView({ web: false }))
    expect(request.requestClass).toBe('web_research')
    expect(request.suggestedCapabilities).toEqual([])
    expect(request.availableCapabilities.includes('web_search')).toBe(false)
    expect(request.unavailableCapabilities).toContain('web_search')
  })

  it('13 — an explicit target is honestly unroutable when no backend is present', async () => {
    const request = await core.orchestrate('Open Chrome on my Victus.', makeView({ devices: [] }))
    expect(request.requestClass).toBe('device_operation')
    expect(request.targetDevices).toEqual(['victus-5050'])
    expect(request.targets).toHaveLength(1)
    expect(request.targets[0].available).toBe(false)
    expect(request.targets[0].transport).toBe('backend')
    expect(request.targets[0].reason).toMatch(/backend is not connected/)
  })

  it('implicit target — an unspecific local command defaults to the host PC', async () => {
    const request = await core.orchestrate('Open Chrome.', makeView())
    expect(request.requestClass).toBe('command')
    expect(request.targetDevices).toEqual([])
    expect(request.implicitTargetDevice).toBe('victus-5050')
    expect(request.targets[0].deviceId).toBe('victus-5050')
    expect(request.targets[0].available).toBe(true)
  })
})

function stubDeviceProvider(): DeviceProvider {
  return {
    capabilities: () => ({ available: true }),
    refresh: () => Promise.resolve(DEVICES),
    notify: async () => ({ delivered: false, deliveredTo: [] }),
    sendFile: async () => ({ ok: false, error: 'not used in tests' }),
  }
}

describe('Phase 3.0A — AssistantEngine.orchestrate integration', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('produces a device-operation request through the real engine view', async () => {
    const provider = new ScriptedProvider([])
    const engine = new AssistantEngine({ providers: [provider], device: stubDeviceProvider() })
    engine.on(() => undefined)

    const request: OrchestrationRequest = await engine.orchestrate('Open Chrome on my Dell.')
    expect(request.requestClass).toBe('device_operation')
    expect(request.targetDevices).toEqual(['dell-laptop'])
    expect(request.targets[0].deviceId).toBe('dell-laptop')
    expect(request.targets[0].available).toBe(true)
    expect(request.availableCapabilities).toContain('list_devices')
  })
})