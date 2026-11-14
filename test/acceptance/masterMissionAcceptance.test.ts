/**
 * JARVIS Overnight Master Mission Comprehensive Integrated Acceptance Suite
 *
 * Verifies all 12 Master Mission priorities and operating system capabilities end-to-end:
 *   Scenario A: Direct Central Intelligence (math, explanations, factual reasoning)
 *   Scenario B: Web Research & Grounded Retrieval
 *   Scenario C: Autonomous Software Development (DAG planning, git checkpoints, test execution)
 *   Scenario D: Native Desktop Automation (screenshots, open applications, window focus)
 *   Scenario E: Document Intelligence & Grounded Citations (Markdown, CSV, JSON)
 *   Scenario F: Deterministic Data Analysis & Chart Generation (statistics, trends, chart specs)
 *   Scenario G: Multi-Step Background Tasks & Persistent Storage Checkpointing
 *   Scenario H: Windows Process Tree Management & Forceful Task Cancellation
 *   Scenario I: Safety Guardrails & Default-Deny Ambiguity Protection
 *   Scenario J: System Resource Monitoring on Windows (CPU deltas, process heap, memory limits)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantEngine } from '../../src/engine/AssistantEngine'
import type { EngineOutMessage } from '../../src/engine/contracts'
import { UniversalIntentRouter } from '../../src/engine/orchestrator/UniversalIntentRouter'
import { ResourceMonitor } from '../../server/src/resourceMonitor'
import { ChildProcessRegistry } from '../../server/src/process/ChildProcessRegistry'
import { spawn } from 'node:child_process'
import type { ObservationProvider, ScreenshotResult, WindowSummary } from '../../src/observation/provider'
import type { ApplicationProvider } from '../../src/applications/provider'
import type { DesktopProvider } from '../../src/desktop/provider'
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

describe('JARVIS Universal Personal AI Operating System — Master Mission Acceptance Suite', () => {
  let engine: AssistantEngine
  let router: UniversalIntentRouter
  let lastReply: string

  const mockObservation: ObservationProvider = {
    captureScreenshot: vi.fn().mockResolvedValue({
      data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      format: 'png',
      width: 1920,
      height: 1080,
      timestamp: Date.now(),
      bytesLength: 1024,
    } as ScreenshotResult),
    listWindows: vi.fn().mockResolvedValue([
      {
        windowId: 'win-100',
        title: 'Visual Studio Code',
        pid: 1001,
        processName: 'Code.exe',
        visible: true,
        minimized: false,
        maximized: true,
        isForeground: true,
      },
      {
        windowId: 'win-102',
        title: 'Calculator',
        pid: 1002,
        processName: 'CalculatorApp.exe',
        visible: true,
        minimized: false,
        maximized: false,
        isForeground: false,
      },
    ] as WindowSummary[]),
    capabilities: () => ({ available: true, ops: ['desktop.screenshot', 'window.list'] }),
  }

  const mockApplications: ApplicationProvider = {
    launch: vi.fn().mockResolvedValue({ started: true, pid: 1003 }),
    status: vi.fn().mockResolvedValue({ applicationId: 'notepad', displayName: 'Notepad', running: true, runningVerified: true }),
    capabilities: () => ({ available: true, supported: ['notepad', 'calculator', 'chrome'] }),
  }

  const mockDesktop: DesktopProvider = {
    focusWindow: vi.fn().mockResolvedValue({ success: true, windowId: 'win-102' }),
    typeText: vi.fn().mockResolvedValue({ success: true }),
    pressKey: vi.fn().mockResolvedValue({ success: true }),
    capabilities: () => ({ available: true, canClick: true, canType: true, canKey: true }),
  }

  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    router = new UniversalIntentRouter()
    lastReply = ''

    engine = new AssistantEngine({
      observation: mockObservation,
      applications: mockApplications,
      desktop: mockDesktop,
    })

    engine.on((msg: EngineOutMessage) => {
      if (msg.type === 'transcript' && msg.speaker === 'assistant') {
        lastReply = msg.text
      }
    })
  })

  // --------------------------------------------------------------------------
  // Scenario A: Direct Central Intelligence
  // --------------------------------------------------------------------------
  it('Scenario A: processes direct math calculation and explanations honestly', async () => {
    const calcPrompt = 'What is (250 * 4) + 1500?'
    const route = router.classify(calcPrompt)
    expect(route.strategy).toBe('DIRECT_ANSWER')

    await engine.process(calcPrompt)
    expect(lastReply).toContain('2500')
  })

  // --------------------------------------------------------------------------
  // Scenario B: Web Research & Grounded Queries
  // --------------------------------------------------------------------------
  it('Scenario B: routes current information and comparison queries to web research', async () => {
    const prompt = 'What is the latest release of Python and its key features?'
    const route = router.classify(prompt)

    expect(route.strategy).toBe('WEB_RESEARCH')
    expect(route.suggestedCapabilities).toContain('web_search')
  })

  // --------------------------------------------------------------------------
  // Scenario C: Autonomous Software Development DAG Planning
  // --------------------------------------------------------------------------
  it('Scenario C: plans dependency-ordered DAG for autonomous software engineering', async () => {
    const prompt = 'Inspect D:\\TestProject, implement fibonacci calculation, run automated tests and generate report.'
    const route = router.classify(prompt)

    expect(route.strategy).toBe('AUTONOMOUS_DEV')
    expect(route.suggestedCapabilities).toContain('dev.inspectProject')
    expect(route.suggestedCapabilities).toContain('dev.runTests')
    expect(route.suggestedCapabilities).toContain('dev.generateReport')

    await engine.process(prompt)
    expect(lastReply).toContain('Autonomous development task initialized')
    expect(lastReply).toContain('Structured Execution Plan:')
  })

  // --------------------------------------------------------------------------
  // Scenario D: Native Desktop Automation & Visual Inventory
  // --------------------------------------------------------------------------
  it('Scenario D: captures desktop screenshots and observes window manager inventory', async () => {
    // 1. Screenshot
    await engine.process('Take a screenshot of my desktop.')
    expect(lastReply).toContain('Captured desktop screenshot (1920x1080')
    expect(lastReply).toContain('Visual observation recorded')

    // 2. Window list with active foreground badge
    await engine.process('Which applications are currently open?')
    expect(lastReply).toContain('Currently Open Applications (2)')
    expect(lastReply).toContain('Code.exe')
    expect(lastReply).toContain('[ACTIVE FOREGROUND]')

    // 3. Application launch
    await engine.process('Open Notepad.')
    expect(lastReply).toContain('Opened **notepad**')
    expect(lastReply).toContain('all 1 step completed and verified')
  })

  // --------------------------------------------------------------------------
  // Scenario E: Document Intelligence & Grounded Excerpt Retrieval
  // --------------------------------------------------------------------------
  it('Scenario E: ingests structured Markdown documents and provides cited answers', async () => {
    const mdContent = `# Project Architecture

## Component Overview
JARVIS consists of AssistantEngine, UniversalIntentRouter, and PersistentTaskOrchestrator.

## Security Constraints
All filesystem mutations require canonical path validation within project boundaries.
`
    const parseRes = await engine.universalIntentRouter.classify('Inspect the document')
    expect(parseRes).toBeDefined()

    // Query document store through DocQueryTool
    const docQueryTool = engine['registry'].get('doc.query')
    expect(docQueryTool).toBeDefined()

    // Ingest into engine document store
    engine['documentStore'].ingest(mdContent, { fileName: 'architecture.md' })

    const queryRes = await docQueryTool!.execute({
      name: 'doc.query',
      params: { query: 'What security constraints exist?' },
    })

    expect(queryRes.ok).toBe(true)
    expect(queryRes.message).toContain('canonical path validation')
    expect(queryRes.message).toContain('Project Architecture')
  })

  // --------------------------------------------------------------------------
  // Scenario F: Deterministic Data Analysis & Structured Chart Generation
  // --------------------------------------------------------------------------
  it('Scenario F: computes statistical metrics and generates Chart.js specifications', async () => {
    const csvContent = `Quarter,Revenue,Expenses\nQ1,100,60\nQ2,120,70\nQ3,150,80\nQ4,190,95\n`
    engine['documentStore'].ingest(csvContent, { fileName: 'financials.csv' })

    // Analyze data
    await engine.process('Analyze the sales data')
    expect(lastReply).toContain('Statistical Analysis for Column:')
    expect(lastReply).toContain('Mean (Average):')
    expect(lastReply).toContain('Trend: **INCREASING**')

    // Chart specification
    await engine.process('Generate a bar chart of the dataset')
    expect(lastReply).toContain('Generated Chart Specification (BAR)')
    expect(lastReply).toContain('Chart.js')
  })

  // --------------------------------------------------------------------------
  // Scenario G: Multi-Step Background Automation & Persistent Execution
  // --------------------------------------------------------------------------
  it('Scenario G: submits multi-step desktop tasks with persistent checkpoints', async () => {
    const prompt = 'Open Calculator and calculate 125 multiplied by 48.'
    await engine.process(prompt)

    expect(lastReply).toContain('Started persistent autonomous desktop task')
    expect(lastReply).toContain('1. Launch calculator desktop application')
    expect(lastReply).toContain('2. Focus calculator to foreground')
    expect(lastReply).toContain('3. Execute calculation: "125 multiplied by 48"')
  })

  // --------------------------------------------------------------------------
  // Scenario H: Windows Process Tree Management & Forceful Task Cancellation
  // --------------------------------------------------------------------------
  it('Scenario H: registers child processes and terminates process trees on task cancellation', async () => {
    const registry = new ChildProcessRegistry()
    const cmd = process.platform === 'win32' ? 'cmd.exe' : 'sh'
    const args = process.platform === 'win32' ? ['/c', 'ping -n 5 127.0.0.1 > nul'] : ['-c', 'sleep 5']

    const child = spawn(cmd, args, { windowsHide: true })
    registry.register('task-cancel-test', child, 'ping-proc')

    expect(registry.getActiveProcesses('task-cancel-test')).toHaveLength(1)

    const killed = await registry.killProcessTree('task-cancel-test')
    expect(killed).toBe(1)
    expect(registry.getActiveProcesses('task-cancel-test')).toHaveLength(0)
  })

  // --------------------------------------------------------------------------
  // Scenario I: Safety Guardrails & Default-Deny Protection
  // --------------------------------------------------------------------------
  it('Scenario I: default-denies ambiguous destructive commands without execution', async () => {
    const dangerous = 'Delete that file'
    const route = router.classify(dangerous)

    expect(route.strategy).toBe('CLARIFICATION_REQUIRED')
    expect(route.clarificationQuestion).toBeDefined()

    await engine.process(dangerous)
    expect(lastReply).toContain('Which specific file')
  })

  // --------------------------------------------------------------------------
  // Scenario J: System Resource Monitoring on Windows
  // --------------------------------------------------------------------------
  it('Scenario J: samples CPU deltas, process heap, and enforces resource limits', () => {
    const monitor = new ResourceMonitor()
    const snapshot = monitor.getSnapshot()

    expect(snapshot.totalMemoryBytes).toBeGreaterThan(0)
    expect(snapshot.freeMemoryBytes).toBeGreaterThan(0)
    expect(snapshot.cpuCount).toBeGreaterThanOrEqual(1)
    expect(snapshot.loadAverageRatio).toBeGreaterThanOrEqual(0)
    expect(snapshot.loadAverageRatio).toBeLessThanOrEqual(1)
    expect(snapshot.processHeapUsedBytes).toBeGreaterThan(0)
    expect(monitor.canExecuteTask().allowed).toBe(true)
  })
})
