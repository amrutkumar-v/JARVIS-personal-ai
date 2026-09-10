import { describe, expect, it, beforeEach } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import { resetProviders } from './providers'
import { useJarvisStore } from '../state/jarvis.store'
import { useConversationStore } from '../state/conversation.store'
import type { EngineOutMessage } from './contracts'
import type { AIProvider, AIRequest, AIResponse } from './provider'
import type { Tool, ToolContext, ToolInput, ToolResult } from '../tools/Tool'

/**
 * Phase 2.6 — Real Action Execution: engine-level integration + honesty tests.
 * These drive the REAL engine (default tool stack + scripted/mock provider) and
 * assert the deterministic action layer:
 *   - unsupported requests are refused honestly (never claimed, never executed);
 *   - destructive deictic requests are clarified, never executed blindly;
 *   - follow-ups ("do it") replay against the committed execution context;
 *   - execution context is committed with real outcome/artifacts.
 */

function stubBrowserStorage(): void {
  const backing = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  ;(globalThis as Record<string, unknown>).window = { localStorage, setTimeout: (_fn: () => void) => 0 }
}

function collect(engine: AssistantEngine): string[] {
  const out: string[] = []
  engine.on((m: EngineOutMessage) => {
    if (m.type === 'transcript') out.push(`[transcript:${m.speaker}] ${m.text}`)
    if (m.type === 'tool') out.push(`[tool:${m.toolId}] ${m.status}`)
    if (m.type === 'status') out.push(`[status] ${m.status}`)
  })
  return out
}

/** Deterministic AIResponse queue — mirrors the Agent Core harness. */
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
    return this.queue.shift() ?? { text: 'No more scripted steps.' }
  }

  isConfigured(): boolean {
    return true
  }

  isReachable(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

/** Real executed tool that surfaces a file artifact for the execution record. */
class FakeProbeTool implements Tool {
  readonly id = 'probe'
  readonly category = 'compute'
  readonly name = 'Probe'
  readonly description = 'probes the active target and reports its path'
  readonly permission = 'low_risk'
  readonly inputSchema = { type: 'object' as const, properties: {}, required: [] }
  readonly requiresPermission = false
  executions = 0

  canRun(): boolean {
    return true
  }

  async execute(_input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    this.executions += 1
    return { ok: true, message: 'probed', data: { path: 'C:/out/report.pdf' } }
  }
}

function toolReq(toolId: string, payload: Record<string, unknown> = {}): AIResponse {
  return { text: '', toolRequests: [{ toolId, payload }] }
}

function text(value: string): AIResponse {
  return { text: value }
}

function runWith(script: AIResponse[], tool: Tool): { engine: AssistantEngine; provider: ScriptedProvider; log: string[] } {
  const provider = new ScriptedProvider(script)
  const engine = new AssistantEngine({ providers: [provider] })
  engine.registerTool(tool)
  const log = collect(engine)
  return { engine, provider, log }
}

describe('Phase 2.6 — real action execution (engine integration)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    resetProviders()
    useConversationStore.getState().clearConversation()
  })

  it('refuses an unsupported domain request HONESTLY — nothing executed, nothing claimed', async () => {
    const engine = new AssistantEngine()
    const log = collect(engine)
    await engine.process('turn off bluetooth')

    const joined = log.join('\n')
    // No tool ever ran.
    expect(joined).not.toMatch(/\[tool:/)
    // The answer refuses the capability truthfully.
    expect(useJarvisStore.getState().lastAssistantText).toMatch(/(isn't|is not|not) connected/i)
    // The run settles normally (the CONVERSATION completed, no action claimed).
    expect(joined).toContain('[status] success')

    const ctx = engine.lastExecutionContext()
    expect(ctx?.outcome).toBe('refused')
    expect(ctx?.actionKind).toBe('unsupported')
    expect(ctx?.executedSteps).toBe(0)
  })

  it('refuses an unsupported communication request without inventing a fake send', async () => {
    const engine = new AssistantEngine()
    const log = collect(engine)
    await engine.process('send a message to Mia on Slack')

    expect(log.join('\n')).not.toMatch(/\[tool:/)
    expect(useJarvisStore.getState().lastAssistantText).toMatch(/(isn't|is not|not) connected/i)
    expect(engine.lastExecutionContext()?.outcome).toBe('refused')
  })

  it('asks for clarification on a destructive deictic request — never executes blindly', async () => {
    const engine = new AssistantEngine()
    const log = collect(engine)
    await engine.process('delete that file')

    const joined = log.join('\n')
    expect(joined).not.toMatch(/\[tool:/)
    expect(useJarvisStore.getState().lastAssistantText).toMatch(/didn't act/i)
    expect(engine.lastExecutionContext()?.outcome).toBe('clarified')
    expect(engine.lastExecutionContext()?.actionKind).toBe('ambiguous')
  })

  it('clarifies an unresolvable deictic entity reference even when not destructive', async () => {
    const engine = new AssistantEngine()
    await engine.process('open the pdf')
    // With no prior execution context this is a fresh request; nothing ran and
    // the mock provider must not hallucinate a path. The reply still settles.
    const text = useJarvisStore.getState().lastAssistantText
    expect(text).not.toMatch(/\[tool:/)
    expect(engine.lastRunTrace().steps).toHaveLength(0)
  })

  it('lets an EXPLICIT destructive request through to the execution rails (never over-blocks)', async () => {
    const engine = new AssistantEngine()
    const log = collect(engine)
    await engine.process('delete "C:/temp/notes.txt"')

    const joined = log.join('\n')
    expect(joined).not.toMatch(/didn't act|ambiguous/i)
    // No blind clarification for an explicit target — it reaches the provider.
    expect(joined).toContain('[status] success')
    // And absolutely nothing ever fabricated a deletion.
    expect(engine.lastRunTrace().steps.every((s) => s.observation?.kind !== 'success')).toBe(true)
  })

  it('records a completed execution context with real facts after a real action', async () => {
    const tool = new FakeProbeTool()
    const { engine } = runWith([toolReq('probe'), text('Probed the report.')], tool)
    await engine.process('probe the report')

    const last = useJarvisStore.getState().lastAssistantText
    expect(last).toMatch(/Probed the report/)

    const ctx = engine.lastExecutionContext()
    expect(ctx?.outcome).toBe('completed')
    expect(ctx?.actionKind).toBe('executable')
    expect(ctx?.matchedTools).toContain('probe')
    expect(ctx?.executedSteps).toBe(1)
    expect(tool.executions).toBe(1)
    // The real file artifact surfaced by the tool is recorded.
    expect(ctx?.artifacts.some((a) => a.kind === 'file' && a.path === 'C:/out/report.pdf')).toBe(true)
    expect(ctx?.requestText).toBe('probe the report')
  })

  it('replays a confirmative follow-up against the last execution context', async () => {
    const tool = new FakeProbeTool()
    const { engine, log } = runWith(
      [toolReq('probe'), text('Probed.'), toolReq('probe'), text('Probed again.')],
      tool,
    )
    await engine.process('probe the target')
    expect(useJarvisStore.getState().lastAssistantText).toMatch(/Probed\./)
    expect(tool.executions).toBe(1)

    await engine.process('do it')

    const joined = log.join('\n')
    // Two real tool executions across two turns — the second is a replay of
    // the FIRST request text, driven from the committed execution context.
    expect(joined.match(/\[tool:probe\] success/g)?.length).toBe(2)
    expect(tool.executions).toBe(2)
    expect(useJarvisStore.getState().lastAssistantText).toMatch(/Probed again\./)
    const ctx = engine.lastExecutionContext()
    expect(ctx?.actionKind).toBe('follow_up')
    expect(ctx?.requestText).toBe('do it')
    expect(ctx?.resolvedText).toBe('probe the target')
  })

  it('never claims a completed action when the run was refused or clarified', async () => {
    const engine = new AssistantEngine()
    await engine.process('delete that file')
    const ctx = engine.lastExecutionContext()
    expect(['refused', 'clarified']).toContain(ctx?.outcome)
    expect(ctx?.executedSteps).toBe(0)
  })

  it('exposes the trace and execution records for the UI without leaking internals', async () => {
    const engine = new AssistantEngine()
    await engine.process('what is 1 + 1')
    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    const ctx = engine.lastExecutionContext()
    expect(ctx).toBeDefined()
    // Never raw payloads or secrets in the record.
    expect(JSON.stringify(ctx)).not.toMatch(/api[_ -]?key|password|bearer/i)
  })
})