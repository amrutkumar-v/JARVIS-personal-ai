import { beforeEach, describe, expect, it } from 'vitest'
import { AssistantEngine } from '../AssistantEngine'
import { FakeApplicationProvider } from '../../applications/testing'
import type { AIProvider, AIRequest, AIResponse } from '../provider'
import type { EngineOutMessage, ToolConfirmationRequest } from '../contracts'
import type { Tool, ToolContext, ToolInput, ToolResult, ToolVerification } from '../../tools/Tool'
import type { CapabilityDefinition } from '../capabilities'
import type { StructuredPlanProvider } from './provider'
import type { ReasoningRequest } from './contract'
import { ProviderError } from '../providers/ProviderError'
import { useConversationStore } from '../../state/conversation.store'

/**
 * Phase 13 — REAL reasoning end-to-end through the engine. A reasoning-capable
 * provider REPLACES the default mock and answers ONLY via structured plans.
 * Whatever the AI "says" is never trusted: it is validated against the
 * registered capability allow-list, arguments are coerced/rejected under the
 * strict plan schema, and any valid plan runs through the EXACT same
 * deterministic rails (validatePlan → permission → confirmation → execution
 * → verification). Provider failures, invalidity and unsafety are honest
 * refusals with NOTHING executed.
 *
 * Routing rule also covered: the deterministic planner runs FIRST for every
 * provider class. Requests it can plan (simple opens / status / folders) run
 * WITHOUT ever calling the AI's plan(). Only genuine planner gaps (chained
 * goals, file targets) are handed to the reasoning provider.
 */

const NOTEPAD_SEED = { applicationId: 'notepad', name: 'Notepad', displayName: 'Notepad' } as const
const CALCULATOR_SEED = { applicationId: 'calculator', name: 'Calculator', displayName: 'Calculator' } as const
/** A deterministic folder plan resolves to the real folder-capable app id. */
const FILE_EXPLORER_SEED = { applicationId: 'file-explorer', name: 'File Explorer', displayName: 'File Explorer' } as const

/** The deterministic planner BLOCKS this as "a file or folder, not an app"
 * (contains the noun "report"), but it is classified executable — so it
 * reaches the reasoning gate when a reasoning-capable provider is active. */
const BLOCKED_FILE_REQUEST = 'Open the quarterly-report'

/** The deterministic planner BLOCKS this as an unsupported multi-step goal
 * (two chained opens — no compound pattern covers it). */
const BLOCKED_MULTI_REQUEST = 'Open Notepad, then open Calculator'

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

beforeEach(() => {
  stubBrowserStorage()
  useConversationStore.getState().clearConversation()
})

/**
 * A provider that is a REAL reasoning provider (has plan()) but is scripted in
 * tests. planCalls proves whether a request ever consulted the AI.
 */
class StructuredScriptedProvider implements AIProvider, StructuredPlanProvider {
  readonly id = 'scripted-reasoning'
  readonly label = 'Scripted Reasoning'
  planCalls = 0
  lastReasoningRequest: ReasoningRequest | undefined
  readonly planResults: Array<unknown | ((request: ReasoningRequest) => unknown | Promise<unknown>)>

  constructor(planResults: Array<unknown | ((request: ReasoningRequest) => unknown | Promise<unknown>)>) {
    this.planResults = [...planResults]
  }

  async plan(request: ReasoningRequest, _signal?: AbortSignal): Promise<unknown> {
    this.planCalls += 1
    this.lastReasoningRequest = request
    const next = this.planResults.shift()
    if (typeof next === 'function') return (next as (r: ReasoningRequest) => unknown)(request)
    return next
  }

  async generate(_request: AIRequest, transmit: (m: EngineOutMessage) => void): Promise<AIResponse> {
    transmit({ type: 'transcript', speaker: 'assistant', text: 'Not used.' })
    return { text: 'Not used.' }
  }

  isConfigured(): boolean {
    return true
  }

  isReachable(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

/** A write-capable registered tool the deterministic planner can never produce
 * (used to prove reasoned plans ride the real confirmation/verification rails). */
class LockScreenTool implements Tool {
  readonly id = 'screen.lock'
  readonly category = 'system'
  readonly name = 'Lock screen'
  readonly description = 'Locks the workstation.'
  readonly permission = 'user_confirmation'
  readonly inputSchema = {
    type: 'object' as const,
    properties: {},
    required: [],
  }
  readonly requiresPermission = true
  readonly verifiable = true
  locks = 0

  canRun(): boolean {
    return true
  }

  async execute(_input: ToolInput): Promise<ToolResult> {
    this.locks += 1
    return { ok: true, message: 'screen locked' }
  }

  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    return { ok: true, message: 'lock reported by the desktop session', checks: ['effect'] }
  }
}

const LOCK_CAPABILITY: CapabilityDefinition = {
  id: 'lock_screen',
  name: 'Lock screen',
  description: 'Lock the current workstation (write).',
  category: 'desktop',
  tools: ['screen.lock'],
  contexts: ['generic'],
  riskLevel: 'action',
  risk: 'medium',
  destructive: true,
  readOnly: false,
  requiresConfirmation: true,
  verification: 'strong',
}

function makeEngine(
  planResults: Array<unknown | ((request: ReasoningRequest) => unknown | Promise<unknown>)>,
  opts: { withLock?: boolean } = {},
): {
  engine: AssistantEngine
  provider: StructuredScriptedProvider
  apps: FakeApplicationProvider
  lock?: LockScreenTool
  texts: string[]
  events: EngineOutMessage[]
} {
  const provider = new StructuredScriptedProvider(planResults)
  const apps = new FakeApplicationProvider([NOTEPAD_SEED, CALCULATOR_SEED, FILE_EXPLORER_SEED])
  const lock = opts.withLock ? new LockScreenTool() : undefined
  const engine = new AssistantEngine({
    providers: [provider],
    applications: apps,
    capabilities: lock ? [LOCK_CAPABILITY] : undefined,
    device: { capabilities: () => ({ available: true }), refresh: async () => [] } as never,
  })
  if (lock) engine.registerTool(lock)
  const texts: string[] = []
  const events: EngineOutMessage[] = []
  engine.on((m) => {
    events.push(m)
    if (m.type === 'transcript' && 'speaker' in m && m.speaker === 'assistant') texts.push(m.text)
  })
  return { engine, provider, apps, lock, texts, events }
}

const lastReply = (texts: string[]): string => texts[texts.length - 1] ?? ''
const joined = (texts: string[]): string => texts.join('\n')

async function waitForToolConfirmRequest(events: EngineOutMessage[]): Promise<ToolConfirmationRequest> {
  for (let i = 0; i < 100; i += 1) {
    const found = events.find((m) => m.type === 'tool-confirm')
    if (found) return (found as { request: ToolConfirmationRequest }).request
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('Timed out waiting for tool-confirm')
}

/** Same as waitForToolConfirmRequest but skips already-seen requests and
 * returns the NEXT one as the run proceeds (a gated capability may legitimately
 * raise a second confirmation via the tool permission rail). */
async function waitForNextToolConfirmRequest(
  events: EngineOutMessage[],
  seen: ToolConfirmationRequest[],
): Promise<ToolConfirmationRequest> {
  for (let i = 0; i < 100; i += 1) {
    const found = events
      .filter((m): m is EngineOutMessage & { request: ToolConfirmationRequest } => m.type === 'tool-confirm')
      .map((m) => m.request)
      .find((r) => !seen.includes(r))
    if (found) return found
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('Timed out waiting for the next tool-confirm')
}

const traceEvents = (engine: AssistantEngine): unknown[] => engine.lastRunTrace().events ?? []
const eventTypes = (engine: AssistantEngine): string[] =>
  traceEvents(engine).map((e) => (e as { type?: string }).type ?? '')
const findEvent = (engine: AssistantEngine, type: string): Record<string, unknown> | undefined =>
  traceEvents(engine).find((e) => (e as { type?: string }).type === type) as Record<string, unknown> | undefined

const EXECUTE_OPEN_MULTI: unknown = {
  intent: 'execute',
  steps: [
    { capabilityId: 'open_application', arguments: { application_id: 'notepad' }, reason: 'notepad' },
    { capabilityId: 'open_application', arguments: { application_id: 'calculator' }, reason: 'calculator' },
  ],
}

describe('Phase 13 — deterministic-first routing (reasoning provider present)', () => {
  it('a simple app launch the planner CAN produce never calls plan()', async () => {
    const { engine, provider, apps, texts } = makeEngine([EXECUTE_OPEN_MULTI])
    await engine.process('Open Notepad.')
    expect(provider.planCalls).toBe(0)
    expect(apps.launchCount('notepad')).toBe(1)
    expect(engine.lastRunTrace().finalState).toBe('completed')
    expect(lastReply(texts)).toContain('Done.')
  })

  it('a deterministic status question is answered from a live reading; plan() is never called', async () => {
    const { engine, provider, apps, texts } = makeEngine([EXECUTE_OPEN_MULTI])
    await engine.process('Is Notepad running?')
    expect(provider.planCalls).toBe(0)
    expect(apps.launchCount('notepad')).toBe(0)
    expect(engine.lastRunTrace().finalState).toBe('completed')
    expect(lastReply(texts)).toContain('answered from a live reading')
  })

  it('a deterministic folder open never consults the AI', async () => {
    const { engine, provider, apps } = makeEngine([EXECUTE_OPEN_MULTI])
    await engine.process('Open my Downloads folder')
    expect(provider.planCalls).toBe(0)
    expect(apps.launchCount('file-explorer')).toBe(1)
    expect(engine.lastRunTrace().finalState).toBe('completed')
  })

  it('deterministic execution is independent of AI reachability', async () => {
    const { engine, provider, apps, texts } = makeEngine([
      () => {
        throw new ProviderError('timeout', 'ai never answered')
      },
    ])
    await engine.process('Open Notepad.')
    expect(provider.planCalls).toBe(0)
    expect(apps.launchCount('notepad')).toBe(1)
    expect(engine.lastRunTrace().finalState).toBe('completed')
    expect(lastReply(texts)).toContain('Done.')
  })
})

describe('Phase 13 — structured reasoning execution (AI-planned)', () => {
  it('a chained goal the planner cannot plan is planned by the AI and executed through the rails', async () => {
    const { engine, provider, apps } = makeEngine([EXECUTE_OPEN_MULTI])
    await engine.process(BLOCKED_MULTI_REQUEST)
    expect(provider.planCalls).toBe(1)
    expect(provider.lastReasoningRequest?.text).toContain('Notepad')
    const trace = engine.lastRunTrace()
    expect(trace.steps.length).toBe(2)
    expect(trace.steps.every((s) => s.status === 'COMPLETED')).toBe(true)
    expect(trace.finalState).toBe('completed')
    expect(apps.launchCount('notepad')).toBe(1)
    expect(apps.launchCount('calculator')).toBe(1)
    expect(findEvent(engine, 'reasoning_plan_validated')?.steps).toBe(2)
    expect(eventTypes(engine)).toContain('reasoning_requested')
  })

  it('the reasoning request advertises ONLY capabilities whose tool is actually registered', async () => {
    const { engine, provider } = makeEngine([EXECUTE_OPEN_MULTI])
    await engine.process(BLOCKED_MULTI_REQUEST)
    const ids = provider.lastReasoningRequest?.capabilities.map((c) => c.id) ?? []
    expect(ids).toContain('open_application')
    expect(ids).toContain('application_status')
    expect(ids).not.toContain('run_any_command')
    expect(ids).not.toContain('open_folder')
    expect(ids).not.toContain('lock_screen')
    expect(ids.length).toBeGreaterThan(0)
  })

  it('an AI-planned read-only status answer stays a live reading, never a FAILED partial', async () => {
    const { engine, provider, apps, texts } = makeEngine([
      { intent: 'status', steps: [{ capabilityId: 'application_status', arguments: { application_id: 'notepad' } }] },
    ])
    await engine.process(BLOCKED_MULTI_REQUEST)
    expect(provider.planCalls).toBe(1)
    expect(apps.launchCount('notepad')).toBe(0)
    expect(engine.lastRunTrace().finalState).toBe('completed')
    expect(lastReply(texts)).toContain('answered from a live reading')
  })

  it('a reasoned write step rides the real confirmation dialog rail (accept)', async () => {
    const { engine, provider, apps, lock, events } = makeEngine(
      [
        {
          intent: 'execute',
          steps: [
            { capabilityId: 'open_application', arguments: { application_id: 'notepad' } },
            { capabilityId: 'lock_screen', arguments: {} },
          ],
        },
      ],
      { withLock: true },
    )
    const pending = engine.process('Open Notepad, then lock the screen')
    // Capability-level confirmation (the app policy says this write needs it)...
    const first = await waitForToolConfirmRequest(events)
    expect(first.toolId).toBe('screen.lock')
    await first.onConfirm()
    // ...then the tool permission rail re-raises one confirmation for the
    // same gated write BEFORE it runs — confirming it too, like the UI would.
    const second = await waitForNextToolConfirmRequest(events, [first])
    expect(second.toolId).toBe('screen.lock')
    await second.onConfirm()
    await pending
    expect(provider.planCalls).toBe(1)
    expect(apps.launchCount('notepad')).toBe(1)
    expect(lock?.locks).toBe(1)
    const trace = engine.lastRunTrace()
    expect(trace.steps.every((s) => s.status === 'COMPLETED')).toBe(true)
    expect(trace.steps.some((s) => s.toolId === 'screen.lock')).toBe(true)
    expect(engine.hasPendingConfirmation).toBe(false)
  })

  it('a reasoned write step declined in the dialog is refused and never chained', async () => {
    const { engine, provider, apps, lock, events } = makeEngine(
      [
        {
          intent: 'execute',
          steps: [
            { capabilityId: 'open_application', arguments: { application_id: 'notepad' } },
            { capabilityId: 'lock_screen', arguments: {} },
          ],
        },
      ],
      { withLock: true },
    )
    const pending = engine.process('Open Notepad, then lock the screen')
    const request = await waitForToolConfirmRequest(events)
    expect(request.toolId).toBe('screen.lock')
    request.onCancel()
    await pending
    expect(provider.planCalls).toBe(1)
    expect(apps.launchCount('notepad')).toBe(1)
    expect(lock?.locks).toBe(0)
    const trace = engine.lastRunTrace()
    const eventsOut = trace.events ?? []
    expect(eventsOut.some((e) => e.type === 'confirmation_required' && e.capability === 'lock_screen')).toBe(true)
    expect(eventsOut.some((e) => e.type === 'confirmation_refused' && e.capability === 'lock_screen')).toBe(true)
    expect(eventsOut.some((e) => e.type === 'step_failed')).toBe(true)
    expect(engine.goalPlan().steps.some((s) => s.state === 'failed')).toBe(true)
    expect(engine.hasPendingConfirmation).toBe(false)
  })
})

describe('Phase 13 — AI output is NEVER trusted (fail-safe refusals, nothing executed)', () => {
  it('provider failure (timeout) → honest refusal, NOTHING executed', async () => {
    const { engine, provider, apps, texts } = makeEngine([
      () => {
        throw new ProviderError('timeout', 'ai timed out')
      },
    ])
    await engine.process(BLOCKED_FILE_REQUEST)
    expect(provider.planCalls).toBe(1)
    expect(apps.launchCount('notepad')).toBe(0)
    expect(engine.lastRunTrace().finalState).toBe('failed')
    expect(lastReply(texts)).toContain('nothing was executed')
    expect(findEvent(engine, 'reasoning_unavailable')?.reason).toBe('timeout')
  })

  it('provider auth failure → same honest shape', async () => {
    const { engine, provider, apps } = makeEngine([
      () => {
        throw new ProviderError('auth', 'bad key')
      },
    ])
    await engine.process(BLOCKED_FILE_REQUEST)
    expect(provider.planCalls).toBe(1)
    expect(apps.launchCount('notepad')).toBe(0)
    expect(engine.lastRunTrace().finalState).toBe('failed')
  })

  it('non-object output → malformed refusal', async () => {
    const { engine, provider, apps } = makeEngine(['completely not json'])
    await engine.process(BLOCKED_FILE_REQUEST)
    expect(provider.planCalls).toBe(1)
    expect(apps.launchCount('notepad')).toBe(0)
    expect(engine.lastRunTrace().finalState).toBe('failed')
    expect(findEvent(engine, 'reasoning_rejected')?.code).toBe('malformed')
  })

  it('unknown capability (malware-style) → rejected; NOTHING runs', async () => {
    const { engine, provider, apps } = makeEngine([
      { intent: 'execute', steps: [{ capabilityId: 'run_any_command', arguments: { command: 'whoami' } }] },
    ])
    await engine.process(BLOCKED_FILE_REQUEST)
    expect(provider.planCalls).toBe(1)
    expect(apps.launchCount('notepad')).toBe(0)
    expect(apps.launchCount('calculator')).toBe(0)
    expect(engine.lastRunTrace().finalState).toBe('failed')
    expect(findEvent(engine, 'reasoning_rejected')?.code).toBe('unknown_capability')
  })

  it('unsafe absolute-path folder argument → rejected with the VALUE never echoed', async () => {
    const { engine, provider, apps, texts } = makeEngine([
      {
        intent: 'execute',
        steps: [
          { capabilityId: 'open_application', arguments: { application_id: 'explorer', folder: 'C:\\Windows\\System32' } },
        ],
      },
    ])
    await engine.process(BLOCKED_FILE_REQUEST)
    expect(provider.planCalls).toBe(1)
    expect(apps.launchCount('explorer')).toBe(0)
    expect(engine.lastRunTrace().finalState).toBe('failed')
    expect(joined(texts)).not.toContain('C:\\Windows\\System32')
    expect(findEvent(engine, 'reasoning_rejected')?.code).toBe('unsafe_path')
  })

  it('too many steps is rejected whole-plan', async () => {
    const { engine, provider, apps } = makeEngine([
      {
        intent: 'execute',
        steps: Array.from({ length: 6 }, () => ({ capabilityId: 'open_application', arguments: { application_id: 'notepad' } })),
      },
    ])
    await engine.process(BLOCKED_FILE_REQUEST)
    expect(provider.planCalls).toBe(1)
    expect(apps.launchCount('notepad')).toBe(0)
    expect(findEvent(engine, 'reasoning_rejected')?.code).toBe('too_many_steps')
  })
})

describe('Phase 13 — AI intent routing (unsupported / clarification / reject)', () => {
  it('unsupported intent (file target) → refused honestly, nothing executed', async () => {
    const { engine, provider, apps, texts } = makeEngine([
      { intent: 'unsupported', reason: 'no capability for that', steps: [] },
    ])
    await engine.process(BLOCKED_FILE_REQUEST)
    expect(provider.planCalls).toBe(1)
    expect(apps.launchCount('notepad')).toBe(0)
    expect(engine.lastRunTrace().finalState).toBe('failed')
    expect(lastReply(texts)).toContain('no capability for that')
  })

  it('clarification intent → asks the user, completes normally, nothing executed', async () => {
    const { engine, provider, apps, texts } = makeEngine([
      { intent: 'clarification', asking: 'Do you mean the quarterly report as a file?', steps: [] },
    ])
    await engine.process(BLOCKED_FILE_REQUEST)
    expect(provider.planCalls).toBe(1)
    expect(apps.launchCount('notepad')).toBe(0)
    expect(engine.lastRunTrace().finalState).toBe('completed')
    expect(joined(texts)).toContain('Do you mean the quarterly report as a file')
  })

  it('reject intent → refuses without executing', async () => {
    const { engine, provider, apps, texts } = makeEngine([
      { intent: 'reject', reason: 'that would modify system configuration', steps: [] },
    ])
    await engine.process(BLOCKED_FILE_REQUEST)
    expect(provider.planCalls).toBe(1)
    expect(apps.launchCount('notepad')).toBe(0)
    expect(engine.lastRunTrace().finalState).toBe('failed')
    expect(joined(texts)).toContain('system configuration')
  })
})

describe('Phase 13 — secret / value redaction in the AI path', () => {
  it('a secret that leaks into a provider error is NEVER echoed back to the user', async () => {
    const SECRET = 'NYC-SECRET-0F4E'
    const { engine, provider, apps, texts } = makeEngine([
      () => {
        throw new Error(`leaked ${SECRET}`)
      },
    ])
    await engine.process(`Open the quarterly-report using code ${SECRET}`)
    expect(provider.planCalls).toBe(1)
    expect(apps.launchCount('notepad')).toBe(0)
    expect(joined(texts)).not.toContain(SECRET)
  })

  it('rejection reasons never name model-supplied argument keys or values', async () => {
    const SECRET = 'NAME-VALUE-SECRET'
    const { engine, provider, apps, texts } = makeEngine([
      {
        intent: 'execute',
        steps: [{ capabilityId: 'open_application', arguments: { application_id: 'notepad', displayTitle: SECRET } }],
      },
    ])
    await engine.process(BLOCKED_FILE_REQUEST)
    expect(provider.planCalls).toBe(1)
    expect(apps.launchCount('notepad')).toBe(0)
    expect(joined(texts)).not.toContain(SECRET)
    expect(joined(texts)).not.toContain('displayTitle')
  })
})

describe('Phase 13 — honest completeness of trace events', () => {
  it('a successful AI run records reasoning lifecycle events with operational data only', async () => {
    const { engine } = makeEngine([EXECUTE_OPEN_MULTI])
    await engine.process(BLOCKED_MULTI_REQUEST)
    const types = eventTypes(engine)
    expect(types).toContain('reasoning_requested')
    expect(types).toContain('reasoning_plan_validated')
    const requested = findEvent(engine, 'reasoning_requested')
    expect(typeof requested?.capabilities).toBe('number')
    expect(requested?.capabilities).toBeGreaterThan(0)
  })
})