import { describe, expect, it, beforeEach } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from './provider'
import type { EngineOutMessage } from './contracts'
import type { Tool, ToolContext, ToolInput, ToolResult, ToolVerification } from '../tools/Tool'
import { useConversationStore } from '../state/conversation.store'
import { useJarvisStore } from '../state/jarvis.store'
import { AGENT_LIMITS } from './limits'

/**
 * Phase 1.0 — Agent Core end-to-end behavior, driven by a *scripted* provider
 * (deterministic AIResponse queue) plus purpose-built fake tools. The scripted
 * provider lets tests exercise the real engine loop — permission gating,
 * validation, retries, verification, observations, bounded execution and the
 * trace — without a network or a real model.
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
  private queue: AIResponse[]

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

/** Verifiable tool: execute succeeds, verifier returns the configured verdict. */
class FakeSendTool implements Tool {
  readonly id = 'fake-send'
  readonly category = 'communication'
  readonly name = 'Fake Send'
  readonly description = 'fires a fake message'
  readonly permission = 'low_risk'
  readonly inputSchema = {
    type: 'object' as const,
    properties: { to: { type: 'string' } },
    required: ['to'],
  }
  readonly requiresPermission = false
  readonly verifiable = true
  executions = 0
  private readonly verifyOk: boolean
  private readonly verifyMessage: string

  constructor(verifyOk: boolean, verifyMessage = 'Confirmed.') {
    this.verifyOk = verifyOk
    this.verifyMessage = verifyMessage
  }

  canRun(): boolean {
    return true
  }

  async execute(): Promise<ToolResult> {
    this.executions += 1
    return { ok: true, message: 'sent', data: { id: 'm1' } }
  }

  async verify(_input: ToolInput, _result: ToolResult, _ctx: ToolContext): Promise<ToolVerification> {
    return { ok: this.verifyOk, message: this.verifyMessage, checks: ['delivery'] }
  }
}

/** Strict contract tool: never runs without its required argument. */
class StrictTool implements Tool {
  readonly id = 'strict'
  readonly category = 'compute'
  readonly name = 'Strict'
  readonly description = 'requires a name'
  readonly permission = 'low_risk'
  readonly inputSchema = {
    type: 'object' as const,
    properties: { name: { type: 'string' } },
    required: ['name'],
  }
  readonly requiresPermission = false
  executions = 0

  canRun(): boolean {
    return true
  }

  async execute(): Promise<ToolResult> {
    this.executions += 1
    return { ok: true, message: 'accepted' }
  }
}

/** Retryable tool: fails its first attempt, recovers on the second. */
class FlakyTool implements Tool {
  readonly id = 'flaky'
  readonly category = 'compute'
  readonly name = 'Flaky'
  readonly description = 'fails once then recovers'
  readonly permission = 'low_risk'
  readonly inputSchema = { type: 'object' as const, properties: {}, required: [] }
  readonly requiresPermission = false
  // shouldRetry allows an attempt while attempt < maxRetries, so maxRetries=2
  // permits two total attempts (first failure + one retry).
  readonly retry = { retryable: true, maxRetries: 2, backoffMs: 1 }
  executions = 0

  canRun(): boolean {
    return true
  }

  async execute(): Promise<ToolResult> {
    this.executions += 1
    if (this.executions === 1) throw new Error('transient glitch')
    return { ok: true, message: 'recovered' }
  }
}

/** Simple low-risk tool used for bounds / repeated-action tests. */
class RepeaterTool implements Tool {
  readonly id = 'repeater'
  readonly category = 'compute'
  readonly name = 'Repeater'
  readonly description = 'repeats anything'
  readonly permission = 'low_risk'
  readonly inputSchema = {
    type: 'object' as const,
    properties: { n: { type: 'number' } },
    required: ['n'],
  }
  readonly requiresPermission = false
  executions = 0

  canRun(): boolean {
    return true
  }

  async execute(): Promise<ToolResult> {
    this.executions += 1
    return { ok: true, message: `ran #${this.executions}` }
  }
}

/** Confirmation-gated tool used to test the cancellation path. */
class ConfirmGateTool implements Tool {
  readonly id = 'confirm-gate'
  readonly category = 'communication'
  readonly name = 'Confirm Gate'
  readonly description = 'needs approval'
  readonly permission = 'user_confirmation'
  readonly inputSchema = { type: 'object' as const, properties: {}, required: [] }
  readonly requiresPermission = true
  runs = 0

  canRun(): boolean {
    return true
  }

  async execute(): Promise<ToolResult> {
    this.runs += 1
    return { ok: true, message: 'ran after approval' }
  }
}

function spyTools(engine: AssistantEngine): string[] {
  const out: string[] = []
  engine.on((m: EngineOutMessage) => {
    if (m.type === 'tool') out.push(`[tool:${m.toolId}] ${m.status}: ${m.detail}`)
    if (m.type === 'status') out.push(`[status] ${m.status}`)
    if (m.type === 'activity') out.push(`[activity:${m.activity.status}] ${m.activity.detail}`)
  })
  return out
}

function runWith(script: AIResponse[], tools: Tool[]): { engine: AssistantEngine; provider: ScriptedProvider; log: string[] } {
  const provider = new ScriptedProvider(script)
  const engine = new AssistantEngine({ providers: [provider] })
  for (const tool of tools) engine.registerTool(tool)
  const log = spyTools(engine)
  return { engine, provider, log }
}

describe('Agent Core (scripted provider end-to-end)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('A/K — runs a scripted two-round tool loop and records a completed trace', async () => {
    const tool = new FakeSendTool(true)
    const { engine, provider } = runWith([req('fake-send', { to: 'a' }), text('Delivered.')], [tool])

    await engine.process('please send it')

    expect(useJarvisStorePinned()).toEqual('Delivered.')
    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps).toHaveLength(1)
    expect(provider.requests.length).toBe(2)
  })

  it('C/G — verified success is recorded as success and marked [verified]', async () => {
    const tool = new FakeSendTool(true)
    const { engine, provider, log } = runWith([req('fake-send', { to: 'a' }), text('Delivered.')], [tool])

    await engine.process('please send it')

    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('COMPLETED')
    expect(trace.steps[0].observation?.kind).toBe('success')
    expect(trace.steps[0].verification?.status).toBe('verified')
    expect(log.join('\n')).toContain('[tool:fake-send] success')
    // The reasoning loop receives the [verified] marker.
    const second = provider.requests[1]
    const toolMsg = second.messages.find((m) => m.role === 'tool' && m.toolId === 'fake-send')
    expect(toolMsg).toBeDefined()
    expect((toolMsg as { content: string }).content).toContain('[verified]')
  })

  it('C/N/O — a verification-refuted action is failed, ok:false and honesty-tagged', async () => {
    const tool = new FakeSendTool(false, 'Destination is missing.')
    const { engine, log } = runWith([req('fake-send', { to: 'a' }), text('Let me recheck.')], [tool])

    await engine.process('please send it')

    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('FAILED')
    expect(trace.steps[0].observation?.kind).toBe('verification')
    expect(trace.steps[0].observation?.errorKind).toBe('tool_failure')
    expect(trace.steps[0].verification?.status).toBe('failed')
    expect(log.join('\n')).toContain('[tool:fake-send] error')
    expect(log.join('\n')).toContain('Destination is missing.')
  })

  it('E/H — retryable transient failures retry then complete with attempts=2', async () => {
    const tool = new FlakyTool()
    const { engine } = runWith([req('flaky'), text('Recovered.')], [tool])

    await engine.process('use the flaky tool')

    expect(tool.executions).toBe(2)
    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('COMPLETED')
    expect(trace.steps[0].observation?.attempts).toBe(2)
    expect(trace.steps[0].observation?.kind).toBe('informational')
  })

  it('D — invalid arguments are rejected before execution with invalid_input', async () => {
    const tool = new StrictTool()
    const { engine, log } = runWith([req('strict', {}), text('I gave bad input.')], [tool])

    await engine.process('call strict')

    expect(tool.executions).toBe(0)
    expect(log.join('\n')).toContain('Missing required argument(s): name')
    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('FAILED')
    expect(trace.steps[0].observation?.errorKind).toBe('invalid_input')
  })

  it('F — provider injection seam and registerTool are the extension points', async () => {
    const tool = new FakeSendTool(true)
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([text('Ready.')])] })
    engine.registerTool(tool)
    expect(engine.tools.get('fake-send')).toBe(tool)
    await engine.process('hi')
    expect(useJarvisStorePinned()).toBe('Ready.')
  })

  it('L — the same action is blocked once it repeats the limit', async () => {
    const tool = new RepeaterTool()
    const { engine } = runWith(
      [req('repeater', { n: 1 }), req('repeater', { n: 1 }), req('repeater', { n: 1 }), req('repeater', { n: 1 }), text('Done.')],
      [tool],
    )

    await engine.process('repeat it four times')

    expect(useJarvisStorePinned()).toBe('Done.')
    const trace = engine.lastRunTrace()
    // 3 genuine executions + 1 blocked duplicate.
    expect(trace.steps).toHaveLength(4)
    expect(trace.steps.slice(0, 3).every((s) => s.status === 'COMPLETED')).toBe(true)
    expect(trace.steps[3].status).toBe('FAILED')
    expect(trace.steps[3].observation?.errorKind).toBe('orchestration_limit')
    expect(trace.steps[3].observation?.summary).toContain('already been executed')
  })

  it('K/M — the loop stops at the step cap with a failed trace and a bounded final answer', async () => {
    // Four rounds, each carrying two distinct requests → exactly 8 steps, so
    // the STEP cap (not the round cap) is what halts the loop.
    const twoReq = (a: number, b: number): AIResponse => ({
      text: '',
      toolRequests: [
        { toolId: 'repeater', payload: { n: a } },
        { toolId: 'repeater', payload: { n: b } },
      ],
    })
    const script: AIResponse[] = [twoReq(0, 1), twoReq(2, 3), twoReq(4, 5), twoReq(6, 7)]
    const tool = new RepeaterTool()
    const { engine } = runWith(script, [tool])

    await engine.process('run eight steps')

    const trace = engine.lastRunTrace()
    expect(trace.steps).toHaveLength(AGENT_LIMITS.MAX_AGENT_STEPS)
    expect(trace.steps.every((s) => s.status === 'COMPLETED')).toBe(true)
    expect(trace.finalState).toBe('failed')
    expect(useJarvisStorePinned()).toMatch(/stop/i)
  })

  it('M/R — user cancellation stops the loop and records a cancelled trace', async () => {
    const tool = new ConfirmGateTool()
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([req('confirm-gate')])] })
    engine.registerTool(tool)

    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))
    const pending = engine.process('run the gated tool')
    await waitForType(events, 'tool-confirm')
    expect(engine.hasPendingConfirmation).toBe(true)

    engine.cancelCurrentTask()
    await pending

    expect(useJarvisStorePinned()).toMatch(/cancelled/i)
    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('cancelled')
    expect(tool.runs).toBe(0)
  })
})

async function waitForType(events: EngineOutMessage[], type: EngineOutMessage['type']): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (events.some((m) => m.type === type)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out waiting for ${type}`)
}

function useJarvisStorePinned(): string {
  return useJarvisStore.getState().lastAssistantText ?? ''
}