/**
 * JARVIS 3.1 — Phase One: Natural-Language Intelligence Stress Test Suite
 *
 * Evaluates 30 completely unfamiliar natural-language instructions across 4 categories:
 *   Category A: Direct Questions (8 prompts - math, concepts, facts) -> DIRECT_ANSWER, zero task overhead
 *   Category B: Multi-Step Instructions (8 prompts - dev, analysis, doc comparison) -> Multi-step DAG planning
 *   Category C: Ambiguous Instructions (7 prompts - vague deictic references) -> CLARIFICATION_REQUIRED
 *   Category D: Mixed-Intent Requests (7 prompts - research+write, analyze+chart, debug+test) -> Multi-capability resolution
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantEngine } from '../../src/engine/AssistantEngine'
import { UniversalIntentRouter } from '../../src/engine/orchestrator/UniversalIntentRouter'
import type { EngineOutMessage } from '../../src/engine/contracts'
import { useConversationStore } from '../../src/state/conversation.store'

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

describe('Phase 1 — Natural-Language Intelligence Stress Test (30 Prompts)', () => {
  let engine: AssistantEngine
  let router: UniversalIntentRouter
  let lastReply: string

  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    router = new UniversalIntentRouter()
    lastReply = ''

    engine = new AssistantEngine({})
    engine.on((msg: EngineOutMessage) => {
      if (msg.type === 'transcript' && msg.speaker === 'assistant') {
        lastReply = msg.text
      }
    })
  })

  // ==========================================================================
  // Category A: Direct Questions (8 Prompts)
  // Expected: DIRECT_ANSWER, immediate tool calculation or response, 0 tasks
  // ==========================================================================
  describe('Category A: Direct Questions', () => {
    const directPrompts = [
      { q: 'Explain why the sky appears blue on a clear day.', topic: 'Rayleigh scattering' },
      { q: 'What is the physical difference between RAM and persistent storage?', topic: 'volatile' },
      { q: 'Calculate (12500 * 4) + 3750.', expectedCalc: '53750' },
      { q: 'What is 15 percent of 8400?', expectedCalc: '1260' },
      { q: 'Explain recursion in programming with a simple countdown example.', topic: 'base case' },
      { q: 'What is the boiling point of water at sea level in Celsius and Fahrenheit?', topic: '100' },
      { q: 'What is the function of an operating system kernel?', topic: 'hardware' },
      { q: 'Evaluate 2 to the power of 12.', expectedCalc: '4096' },
    ]

    for (let i = 0; i < directPrompts.length; i++) {
      const item = directPrompts[i]
      it(`Prompt A${i + 1}: "${item.q}" routes directly with no task creation overhead`, async () => {
        const route = router.classify(item.q)
        expect(route.strategy).toBe('DIRECT_ANSWER')

        await engine.process(item.q)
        expect(lastReply).toBeDefined()
        expect(lastReply.length).toBeGreaterThan(0)

        // For calculation prompts, verify arithmetic accuracy
        if (item.expectedCalc) {
          expect(lastReply).toContain(item.expectedCalc)
        }

        // Verify that no background task was created
        expect(lastReply).not.toContain('Autonomous development task initialized')
        expect(lastReply).not.toContain('Started persistent autonomous desktop task')
      })
    }
  })

  // ==========================================================================
  // Category B: Multi-Step Instructions (8 Prompts)
  // Expected: Structured multi-step planning, proper capability suggestions
  // ==========================================================================
  describe('Category B: Multi-Step Instructions', () => {
    const multiStepPrompts = [
      {
        q: 'Find three reliable sources about autonomous AI agents, compare their approaches and prepare a concise report.',
        expectedStrategy: ['DEEP_RESEARCH', 'WEB_RESEARCH'],
        suggested: 'web_search',
      },
      {
        q: 'Inspect D:\\TestProject, create a Python program that validates email addresses, run tests and generate a report.',
        expectedStrategy: ['AUTONOMOUS_DEV'],
        suggested: 'dev.inspectProject',
      },
      {
        q: 'Find the largest CSV file in D:\\DataLogs, analyze the sales trends and generate a bar chart.',
        expectedStrategy: ['DATA_ANALYSIS', 'AUTONOMOUS_DEV'],
        suggested: 'data.analyze',
      },
      {
        q: 'Read the architectural PDF and Excel spreadsheet in D:\\Docs, and create a structured comparison.',
        expectedStrategy: ['DOCUMENT_INTELLIGENCE'],
        suggested: 'doc.summarize',
      },
      {
        q: 'Open the browser, navigate to multiple documentation pages, extract the API tables, and take screenshots.',
        expectedStrategy: ['BROWSER_WORKFLOW'],
        suggested: 'browser.navigate',
      },
      {
        q: 'Open Notepad and Calculator, perform the financial calculation, and save the result to a text file.',
        expectedStrategy: ['DESKTOP_ACTION', 'AUTONOMOUS_DEV'],
        suggested: 'launch_app',
      },
      {
        q: 'Inspect the repository at D:\\Workspace, audit the security vulnerabilities, run unit tests, and create a git checkpoint.',
        expectedStrategy: ['AUTONOMOUS_DEV'],
        suggested: 'dev.auditProject',
      },
      {
        q: 'Conduct deep research into WebAssembly garbage collection performance benchmarks across modern browser engines.',
        expectedStrategy: ['DEEP_RESEARCH', 'WEB_RESEARCH'],
        suggested: 'web_search',
      },
    ]

    for (let i = 0; i < multiStepPrompts.length; i++) {
      const item = multiStepPrompts[i]
      it(`Prompt B${i + 1}: "${item.q.slice(0, 40)}..." plans multi-step execution correctly`, async () => {
        const route = router.classify(item.q)
        expect(item.expectedStrategy).toContain(route.strategy)
        if (item.suggested) {
          expect(route.suggestedCapabilities).toContain(item.suggested)
        }
      })
    }
  })

  // ==========================================================================
  // Category C: Ambiguous Instructions (7 Prompts)
  // Expected: CLARIFICATION_REQUIRED with concise, actionable question
  // ==========================================================================
  describe('Category C: Ambiguous Instructions', () => {
    const ambiguousPrompts = [
      { q: 'Open it.', target: 'application or file' },
      { q: 'Delete that.', target: 'file' },
      { q: 'Use the second one.', target: 'candidate' },
      { q: 'Fix that.', target: 'error or issue' },
      { q: 'Make it better.', target: 'code or document' },
      { q: 'Run the other file.', target: 'test or script' },
      { q: 'Send it now.', target: 'email or message' },
    ]

    for (let i = 0; i < ambiguousPrompts.length; i++) {
      const item = ambiguousPrompts[i]
      it(`Prompt C${i + 1}: "${item.q}" asks for clarification rather than guessing randomly`, async () => {
        const route = router.classify(item.q)
        expect(route.strategy).toBe('CLARIFICATION_REQUIRED')
        expect(route.clarificationQuestion).toBeDefined()
        expect(route.clarificationQuestion!.length).toBeGreaterThan(5)

        await engine.process(item.q)
        expect(lastReply).toBeDefined()
        expect(lastReply).toContain(route.clarificationQuestion!)
      })
    }
  })

  // ==========================================================================
  // Category D: Mixed-Intent Requests (7 Prompts)
  // Expected: Resolves combined capabilities without conflicting orchestrators
  // ==========================================================================
  describe('Category D: Mixed-Intent Requests', () => {
    const mixedPrompts = [
      {
        q: 'Research micro-frontend architectures, save the findings in a Markdown document and cite your sources.',
        expectedStrategy: ['DEEP_RESEARCH', 'WEB_RESEARCH', 'DOCUMENT_INTELLIGENCE'],
      },
      {
        q: 'Analyze this financial spreadsheet, compute quarterly trends and prepare an executive summary with charts.',
        expectedStrategy: ['DATA_ANALYSIS', 'DOCUMENT_INTELLIGENCE'],
      },
      {
        q: 'Find the syntax error in D:\\App\\main.py, patch the file, run the automated tests and explain the fix.',
        expectedStrategy: ['AUTONOMOUS_DEV'],
      },
      {
        q: 'Search for the latest TypeScript release notes, extract the breaking changes table and remember them for our project.',
        expectedStrategy: ['DEEP_RESEARCH', 'WEB_RESEARCH', 'MEMORY_OPERATION'],
      },
      {
        q: 'Inspect this PDF contract, extract the payment liability clause, and check for calendar conflicts on the milestone dates.',
        expectedStrategy: ['DOCUMENT_INTELLIGENCE', 'PRODUCTIVITY'],
      },
      {
        q: 'Open the web browser to our localhost dashboard, capture a screenshot, inspect the visual layout and note any rendering defects.',
        expectedStrategy: ['BROWSER_WORKFLOW', 'MULTIMODAL_REQUEST', 'DESKTOP_ACTION'],
      },
      {
        q: 'Take a desktop screenshot of the running IDE, analyze what window is open and focus Visual Studio Code.',
        expectedStrategy: ['DESKTOP_ACTION', 'MULTIMODAL_REQUEST'],
      },
    ]

    for (let i = 0; i < mixedPrompts.length; i++) {
      const item = mixedPrompts[i]
      it(`Prompt D${i + 1}: "${item.q.slice(0, 45)}..." resolves mixed intent coherently`, () => {
        const route = router.classify(item.q)
        expect(item.expectedStrategy).toContain(route.strategy)
        expect(route.confidence).toBeGreaterThan(0.6)
      })
    }
  })
})

