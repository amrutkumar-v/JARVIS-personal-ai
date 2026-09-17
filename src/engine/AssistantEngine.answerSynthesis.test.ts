import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantEngine } from './AssistantEngine'
import type { EngineOutMessage } from './contracts'
import type { AIProvider, AIRequest, AIResponse } from './provider'
import type { StructuredPlanProvider } from './reasoning/provider'
import type { ReasoningRequest } from './reasoning/contract'
import { FakeApplicationProvider } from '../applications/testing'
import type { WebCapabilities, WebProvider, WebSearchResponse } from '../web/provider'
import { useConversationStore } from '../state/conversation.store'

// Deterministic "no native surfaces" bootstrap, mirroring the other
// process()-level suites.
vi.mock('../native/nativeAgentEnv', () => ({
  readAgentEnv: () => undefined,
  readNativeAgentEnv: () => undefined,
}))

/**
 * Grounded answer synthesis (orchestrator/answerSynthesis) end-to-end.
 *
 * The reply for an orchestrated run is composed of two parts:
 *
 *   1. the model's prose, written ONLY from the observed execution record, and
 *   2. the ENGINE's deterministic evidence line, ALWAYS appended.
 *
 * These tests prove (a) the prose is grounded in real observations, (b) the
 * model is handed no tools, and (c) prose that claims more than the record holds
 * (a partial run described as a success) is REJECTED, leaving the deterministic
 * verdict to stand alone.
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

/** A REAL (non-mock) provider: scripted synthesis text, scripted plans. */
class SynthesisScriptedProvider implements AIProvider, StructuredPlanProvider {
  readonly id = 'synthesis-scripted'
  readonly label = 'Synthesis Scripted'
  /** Synthesis prose returned by the next generate() call. */
  nextText = 'Synthesis not scripted.'
  generateCalls: AIRequest[] = []
  planCalls = 0

  async plan(_request: ReasoningRequest): Promise<unknown> {
    this.planCalls += 1
    return { intent: 'unsupported', reason: 'Not used in these tests.' }
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    this.generateCalls.push(request)
    return { text: this.nextText }
  }

  isConfigured(): boolean {
    return true
  }

  isReachable(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

const NOTEPAD_SEED = { applicationId: 'notepad', name: 'Notepad', displayName: 'Notepad', launchOutcome: 'verified' as const }

/** The REAL web provider surface: the search returns a verifiable fact. */
function recordingWebProvider(): { provider: WebProvider; queries: string[] } {
  const queries: string[] = []
  const provider: WebProvider = {
    id: 'recording-web',
    capabilities(): WebCapabilities {
      return { available: true, search: true, fetch: true, download: true }
    },
    async search(query: string): Promise<WebSearchResponse> {
      queries.push(query)
      return {
        query,
        provider: 'recording',
        servedAt: Date.now(),
        results: [
          {
            title: 'NVIDIA Driver Downloads',
            url: 'https://www.nvidia.com/downloads',
            snippet: 'Latest Game Ready Driver: 616.92 WHQL. Released for the RTX 50 series.',
          },
        ],
        freshness: { detectable: false, note: 'not detectable' },
      }
    },
    async fetchDocument(url: string) {
      throw new Error(`not used: ${url}`)
    },
    async download(url: string) {
      throw new Error(`not used: ${url}`)
    },
  }
  return { provider, queries }
}

function collectReplies(engine: AssistantEngine): { replies: string[] } {
  const replies: string[] = []
  engine.on((m: EngineOutMessage) => {
    if (m.type === 'transcript' && m.speaker === 'assistant') replies.push(m.text)
  })
  return { replies }
}

function bootstrap(): void {
  stubBrowserStorage()
  useConversationStore.getState().clearConversation()
}

describe('grounded answer synthesis — successful multi-step run', () => {
  beforeEach(bootstrap)

  it('answers from the REAL observations and keeps the engine verdict line', async () => {
    const apps = new FakeApplicationProvider([NOTEPAD_SEED])
    const { provider, queries } = recordingWebProvider()
    const ai = new SynthesisScriptedProvider()
    ai.nextText = 'Notepad is open, and the latest NVIDIA driver I found is 616.92 WHQL.'
    const engine = new AssistantEngine({ providers: [ai], applications: apps, web: provider })
    const { replies } = collectReplies(engine)

    await engine.process('Open Notepad and search for the latest NVIDIA driver version, then tell me the version')

    const reply = replies.at(-1) ?? ''
    // 1. The model's prose leads the answer...
    expect(reply).toContain('616.92 WHQL')
    // 2. ...and the deterministic evidence line is still there, verbatim.
    expect(reply).toMatch(/Done\.|Partially done\./)

    // The search really ran on CLEANED terms (no "then tell me the version").
    expect(queries).toHaveLength(1)
    expect(queries[0]).toBe('the latest NVIDIA driver version')

    // The synthesis call was handed the observed record and NO tools.
    const synthesis = ai.generateCalls.at(-1)!
    expect(synthesis.toolDefinitions).toEqual([])
    expect(synthesis.availableTools).toEqual([])
    const prompt = synthesis.messages.map((m) => m.content).join('\n')
    expect(prompt).toContain('616.92 WHQL')
    expect(prompt).toContain('EXECUTION RECORD')
  })
})

describe('grounded answer synthesis — partial run cannot be upgraded', () => {
  beforeEach(bootstrap)

  it('drops prose that claims success when a step was NOT verified', async () => {
    const apps = new FakeApplicationProvider([NOTEPAD_SEED])
    const { provider } = recordingWebProvider()
    const ai = new SynthesisScriptedProvider()
    ai.nextText = 'All steps completed successfully and everything is verified.'
    const engine = new AssistantEngine({ providers: [ai], applications: apps, web: provider })
    const { replies } = collectReplies(engine)

    await engine.process('Open Notepad and search for the latest NVIDIA driver version, then tell me the version')

    const reply = replies.at(-1) ?? ''
    expect(reply).not.toContain('All steps completed successfully')
    expect(reply).not.toContain('successfully')
    // The engine's own honest verdict stands alone: 2 steps ran, only 1 could
    // be independently verified (the web read has no verifier).
    expect(reply).toMatch(/Partially done\. .*1 of 2 steps verified/)
    expect(reply).not.toMatch(/all 2 steps completed and verified/)
  })

  it('keeps grounded prose on a partial run when it does NOT overclaim', async () => {
    const apps = new FakeApplicationProvider([NOTEPAD_SEED])
    const { provider } = recordingWebProvider()
    const ai = new SynthesisScriptedProvider()
    ai.nextText = 'Notepad is open. The search returned NVIDIA driver 616.92 WHQL from nvidia.com.'
    const engine = new AssistantEngine({ providers: [ai], applications: apps, web: provider })
    const { replies } = collectReplies(engine)

    await engine.process('Open Notepad and search for the latest NVIDIA driver version, then tell me the version')

    const reply = replies.at(-1) ?? ''
    expect(reply).toContain('616.92 WHQL')
    expect(reply).toMatch(/Partially done\. .*1 of 2 steps verified/)
  })

  it('never invents a synthesis step when NO real AI provider is configured', async () => {
    const apps = new FakeApplicationProvider([NOTEPAD_SEED])
    const engine = new AssistantEngine({ applications: apps })
    const { replies } = collectReplies(engine)

    await engine.process('Open Notepad.')

    const reply = replies.at(-1) ?? ''
    expect(reply).toMatch(/Done\. Open Notepad\. — all 1 step completed and verified\./)
  })
})

describe('grounded answer synthesis — honesty gate unit behaviour', () => {
  beforeEach(bootstrap)

  it('does not call synthesis for a blocked (never executed) request', async () => {
    const { provider } = recordingWebProvider()
    const ai = new SynthesisScriptedProvider()
    ai.nextText = 'Anything at all.'
    const engine = new AssistantEngine({ providers: [ai], applications: new FakeApplicationProvider([NOTEPAD_SEED]), web: provider })
    const { replies } = collectReplies(engine)

    // The deterministic planner refuses this target (a file, not an app) and the
    // reasoning provider answers 'unsupported' — nothing was executed.
    await engine.process('Open the quarterly-report')

    expect(replies.at(-1)).toContain('I cannot')
    // Nothing ran, so there is nothing to narrate: no synthesis request at all.
    expect(ai.generateCalls.filter((c) => c.messages.some((m) => m.content.includes('EXECUTION RECORD')))).toHaveLength(0)
  })

  it('keeps synthesizing when a step FAILED, because the failure is an observation', async () => {
    const { provider } = recordingWebProvider()
    const ai = new SynthesisScriptedProvider()
    ai.nextText = 'I could not launch Chrome, but the search returned 616.92 WHQL.'
    const engine = new AssistantEngine({ providers: [ai], applications: new FakeApplicationProvider([NOTEPAD_SEED]), web: provider })
    const { replies } = collectReplies(engine)

    await engine.process('Open Chrome and search for the latest NVIDIA driver version, then tell me the version')

    const reply = replies.at(-1) ?? ''
    expect(reply).toContain('616.92 WHQL')
    expect(reply).toMatch(/I tried to|failed/i)
  })
})
