import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import { RemoteProvider } from './providers/RemoteProvider'
import { resetAiConfigCache } from '../config/ai'
import type { Tool, ToolContext, ToolInput, ToolResult, ToolVerification } from '../tools/Tool'
import type { CapabilityDefinition } from './capabilities'
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

const ENV = import.meta.env as Record<string, string | undefined>

function setRemoteConfig(overrides: Record<string, string | undefined> = {}): void {
  ENV.VITE_JARVIS_AI_MODEL = 'test-model'
  ENV.VITE_JARVIS_AI_BASE_URL = 'https://ai.example.com/v1'
  ENV.JARVIS_API_KEY = 'test-key'
  delete ENV.VITE_JARVIS_AI_PROXY_URL
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete ENV[k]
    else ENV[k] = v
  }
  resetAiConfigCache()
}

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).fetch = vi.fn()
  stubBrowserStorage()
  useConversationStore.getState().clearConversation()
})

afterEach(() => {
  vi.resetAllMocks()
  delete (globalThis as Record<string, unknown>).fetch
  resetAiConfigCache()
})

function mockProviderResponses(
  isReachableBody: unknown,
  generateResponses: Array<{ status: number; body: unknown }>
) {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
  let generateIndex = 0
  fetchMock.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const isGet = !init || init.method === 'GET'
    if (isGet) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(isReachableBody),
        json: async () => isReachableBody,
      } as Response
    }
    const response = generateResponses[generateIndex]
    if (!response) {
      throw new Error('Unexpected generate call ' + (generateIndex + 1) + ' - no more mock responses')
    }
    generateIndex++
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => JSON.stringify(response.body),
      json: async () => response.body,
    } as Response
  })
}

class ClickTool implements Tool {
  readonly id = 'desktop.click'
  readonly category = 'compute'
  readonly name = 'Click'
  readonly description = 'clicks a point on a window'
  readonly permission = 'low_risk'
  readonly inputSchema = {
    type: 'object' as const,
    properties: { window_id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
    required: ['window_id'],
  }
  readonly requiresPermission = false
  readonly verifiable = true
  clicks = 0
  failOnClick = 0

  canRun(): boolean {
    return true
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    this.clicks += 1
    if (this.failOnClick === this.clicks) {
      throw new Error('click failed on purpose')
    }
    return { ok: true, message: 'clicked at (' + input.params?.x + ', ' + input.params?.y + ')', data: { ok: true } }
  }

  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    return { ok: true, message: 'confirmed', checks: ['effect'] }
  }
}

const clickCapability: CapabilityDefinition = {
  id: 'click_at',
  name: 'Click at',
  description: 'click a point on a window',
  category: 'desktop',
  tools: ['desktop.click'],
  contexts: ['desktop'],
  riskLevel: 'action',
  risk: 'medium',
  destructive: false,
  readOnly: false,
  verification: 'strong',
}

function makeEngine() {
  const provider = new RemoteProvider()
  const engine = new AssistantEngine({ providers: [provider], capabilities: [clickCapability] })
  const tool = new ClickTool()
  engine.registerTool(tool)
  engine.on(() => undefined)
  return { engine, tool }
}

describe('Phase 6 - RemoteProvider real-provider integration', () => {
  it('full pipeline: real provider tool call -> execute -> verify -> completed', async () => {
    setRemoteConfig()
    const { engine, tool } = makeEngine()

    mockProviderResponses(
      { ok: true },
      [
        {
          status: 200,
          body: {
            choices: [{
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'desktop.click', arguments: JSON.stringify({ window_id: '1', x: 10, y: 20 }) },
                }],
              },
            }],
          },
        },
        { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'Clicked as requested.' } }] } },
      ]
    )

    await engine.process('click it')

    expect(tool.clicks).toBe(1)
    expect(engine.taskResult().status).toBe('completed')
    expect(engine.goalPlan().steps[0].toolId).toBe('desktop.click')
    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('COMPLETED')
    expect(trace.steps[0].verification?.status).toBe('verified')
  })

  it('capability request: model names capability id click_at -> resolves to desktop.click', async () => {
    setRemoteConfig()
    const { engine, tool } = makeEngine()

    mockProviderResponses(
      { ok: true },
      [
        {
          status: 200,
          body: {
            choices: [{
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'click_at', arguments: JSON.stringify({ window_id: '1', x: 5, y: 5 }) },
                }],
              },
            }],
          },
        },
        { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'Done.' } }] } },
      ]
    )

    await engine.process('click it')

    expect(tool.clicks).toBe(1)
    expect(engine.taskResult().status).toBe('completed')
    const plan = engine.goalPlan()
    expect(plan.steps[0].capability).toBe('click_at')
    expect(plan.steps[0].toolId).toBe('desktop.click')
    const trace = engine.lastRunTrace()
    expect(trace.events?.some((e) => e.type === 'capability_resolved' && e.capability === 'click_at')).toBe(true)
  })

  it('unknown capability is refused safely', async () => {
    setRemoteConfig()
    const { engine, tool } = makeEngine()

    mockProviderResponses(
      { ok: true },
      [
        {
          status: 200,
          body: {
            choices: [{
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'delete_everything', arguments: '{}' },
                }],
              },
            }],
          },
        },
        { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'I cannot do that.' } }] } },
      ]
    )

    await engine.process('delete everything')

    expect(tool.clicks).toBe(0)
    const task = engine.lastRunTrace().task!
    expect(task.actionable).toBe(false)
    expect(tool.clicks).toBe(0)
    expect(['failed', 'blocked']).toContain(task.status)
  })

  it('invalid args on registered tool -> schema validation failure', async () => {
    setRemoteConfig()
    const { engine, tool } = makeEngine()

    mockProviderResponses(
      { ok: true },
      [
        {
          status: 200,
          body: {
            choices: [{
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'desktop.click', arguments: JSON.stringify({ x: 1, y: 2 }) },
                }],
              },
            }],
          },
        },
        { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'Missing window_id.' } }] } },
      ]
    )

    await engine.process('click it')

    expect(tool.clicks).toBe(0)
    const trace = engine.lastRunTrace()
    expect(trace.steps[0].observation?.errorKind).toBe('invalid_input')
    expect(tool.clicks).toBe(0)
    expect(['failed', 'blocked']).toContain(engine.taskResult().status)
  })

  it('malformed tool arguments -> ProviderError malformed -> honest failure', async () => {
    setRemoteConfig()
    const { engine, tool } = makeEngine()

    mockProviderResponses(
      { ok: true },
      [
        {
          status: 200,
          body: {
            choices: [{
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'desktop.click', arguments: '{not valid json}' },
                }],
              },
            }],
          },
        },
        { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'Oops.' } }] } },
      ]
    )

    await engine.process('click it')

    expect(tool.clicks).toBe(0)
    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('failed')
  })

  it('network failure -> ProviderError network -> honest failure', async () => {
    setRemoteConfig()
    const { engine, tool } = makeEngine()

    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'))

    await engine.process('click it')

    expect(tool.clicks).toBe(0)
    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('failed')
  })

  it('multi-step plan: two rounds of tool calls', async () => {
    setRemoteConfig()
    const { engine, tool } = makeEngine()

    mockProviderResponses(
      { ok: true },
      [
        {
          status: 200,
          body: {
            choices: [{
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'click_at', arguments: JSON.stringify({ window_id: '1', x: 1, y: 1 }) },
                }],
              },
            }],
          },
        },
        {
          status: 200,
          body: {
            choices: [{
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'call-2',
                  type: 'function',
                  function: { name: 'desktop.click', arguments: JSON.stringify({ window_id: '1', x: 2, y: 2 }) },
                }],
              },
            }],
          },
        },
        { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'Both clicks done.' } }] } },
      ]
    )

    await engine.process('click twice')

    expect(tool.clicks).toBe(2)
    expect(engine.taskResult().status).toBe('completed')
    expect(engine.taskResult().verifiedSteps).toBe(2)
  })

  it('partial completion: first step verified, second fails -> PARTIAL', async () => {
    setRemoteConfig()
    const { engine, tool } = makeEngine()
    tool.failOnClick = 2

    mockProviderResponses(
      { ok: true },
      [
        {
          status: 200,
          body: {
            choices: [{
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'click_at', arguments: JSON.stringify({ window_id: '1', x: 1, y: 1 }) },
                }],
              },
            }],
          },
        },
        {
          status: 200,
          body: {
            choices: [{
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'call-2',
                  type: 'function',
                  function: { name: 'click_at', arguments: JSON.stringify({ window_id: '1', x: 2, y: 2 }) },
                }],
              },
            }],
          },
        },
        { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'Second click failed.' } }] } },
      ]
    )

    await engine.process('click twice')

    expect(tool.clicks).toBe(2)
    const task = engine.lastRunTrace().task!
    expect(task.status).toBe('partial')
    expect(task.verifiedSteps).toBe(1)
    expect(task.executedSteps).toBe(2)
    expect(task.status).not.toBe('completed')
  })
})