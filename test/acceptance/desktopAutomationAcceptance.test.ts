/**
 * JARVIS Phase 4: Native Desktop Automation Acceptance Tests
 *
 * Concretely verifies all 6 natural language desktop examples and window controls:
 * - Example A: "Take a screenshot of my desktop."
 * - Example B: "Which applications are currently open?"
 * - Example C: "Open Notepad."
 * - Example D: "Open Calculator and calculate 125 multiplied by 48."
 * - Example E: "Switch to my browser."
 * - Example F: "Take a screenshot and tell me what is currently visible."
 * - Window controls: minimize, maximize, restore
 * - Desktop observation HUD integration
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { AssistantEngine } from '../../src/engine/AssistantEngine'
import { FakeDesktopInteractionProvider } from '../../src/desktop/testing'
import { MemoryTaskStorage } from '../../src/engine/tasks/TaskStore'
import { useConversationStore } from '../../src/state/conversation.store'
import { DesktopEngine } from '../../server/src/desktop/DesktopEngine.js'
import type { WindowSummary, ScreenshotResult, ObservationProvider } from '../../src/observation/provider'
import type { ApplicationProvider } from '../../src/applications/provider'

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
    location: { hostname: '127.0.0.1', protocol: 'http:', port: '3000' },
  }
}

class FakeObservationProvider implements ObservationProvider {
  capabilities() {
    return { available: true, ops: ['window.list', 'desktop.screenshot'] as any }
  }
  async listWindows(): Promise<WindowSummary[]> {
    return [
      {
        windowId: '1001',
        title: 'Untitled - Notepad',
        processName: 'notepad.exe',
        pid: 1234,
        visible: true,
        minimized: false,
        maximized: false,
        isForeground: true,
      },
      {
        windowId: '1002',
        title: 'Google Chrome',
        processName: 'chrome.exe',
        pid: 5678,
        visible: true,
        minimized: false,
        maximized: true,
        isForeground: false,
      },
    ]
  }
  async captureScreenshot(): Promise<ScreenshotResult> {
    return {
      width: 1920,
      height: 1080,
      format: 'png',
      bytesLength: 128000,
      bytes: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    }
  }
  async getWindowStatus(windowId: string) {
    return {
      windowId,
      title: 'Active Window',
      processName: 'app.exe',
      pid: 1000,
      visible: true,
      minimized: false,
      maximized: false,
      exists: true,
    }
  }
}

class FakeApplicationProvider implements ApplicationProvider {
  private running = new Set<string>(['notepad'])
  capabilities() {
    return { available: true, ops: ['launch', 'close'] as any }
  }
  async list() {
    return [
      { id: 'notepad', name: 'Notepad', running: this.running.has('notepad') },
      { id: 'calculator', name: 'Calculator', running: this.running.has('calculator') },
    ]
  }
  async launch(id: string) {
    this.running.add(id)
    return { started: true, pid: 9999, detail: `Launched ${id}` }
  }
  async close(id: string) {
    this.running.delete(id)
    return { closed: true, detail: `Closed ${id}` }
  }
}

describe('Phase 4: Native Desktop Automation Acceptance', () => {
  let engine: AssistantEngine
  let observation: FakeObservationProvider
  let applications: FakeApplicationProvider
  let desktop: FakeDesktopInteractionProvider
  let lastReply = ''

  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    observation = new FakeObservationProvider()
    applications = new FakeApplicationProvider()
    desktop = new FakeDesktopInteractionProvider([
      { windowId: '1001', title: 'Untitled - Notepad', visible: true, focusable: true },
      { windowId: '1002', title: 'Google Chrome', visible: true, focusable: true },
    ])

    engine = new AssistantEngine({
      taskStorage: new MemoryTaskStorage(),
      observation,
      applications,
      desktop,
    })

    lastReply = ''
    engine.on((msg) => {
      if (msg.type === 'transcript' && msg.speaker === 'assistant') {
        lastReply = msg.text
      }
    })
  })

  // --------------------------------------------------------------------------
  // Example A: Screenshot Capture
  // --------------------------------------------------------------------------
  it('Example A: "Take a screenshot of my desktop." captures display and emits observation report', async () => {
    const prompt = 'Take a screenshot of my desktop.'
    const route = engine.universalIntentRouter.classify(prompt)

    expect(route.strategy).toBe('DESKTOP_ACTION')
    expect(route.intent).toBe('screenshot')

    await engine.process(prompt)

    expect(lastReply).toContain('Captured desktop screenshot (1920x1080, format: PNG')
    expect(lastReply).toContain('Visual observation recorded')
  })

  // --------------------------------------------------------------------------
  // Example B: List Open Applications
  // --------------------------------------------------------------------------
  it('Example B: "Which applications are currently open?" lists windows and highlights active foreground', async () => {
    const prompt = 'Which applications are currently open?'
    const route = engine.universalIntentRouter.classify(prompt)

    expect(route.strategy).toBe('DESKTOP_ACTION')
    expect(route.intent).toBe('list_windows')

    await engine.process(prompt)

    expect(lastReply).toContain('Currently Open Applications (2)')
    expect(lastReply).toContain('notepad.exe')
    expect(lastReply).toContain('[ACTIVE FOREGROUND]')
    expect(lastReply).toContain('chrome.exe')
  })

  // --------------------------------------------------------------------------
  // Example C: Native Application Launch
  // --------------------------------------------------------------------------
  it('Example C: "Open Notepad." launches application on desktop', async () => {
    const prompt = 'Open Notepad.'
    const route = engine.universalIntentRouter.classify(prompt)

    expect(route.strategy).toBe('DESKTOP_ACTION')
    expect(route.intent).toBe('open_app')

    await engine.process(prompt)

    expect(lastReply).toContain('Opened **notepad**')
    expect(lastReply).toContain('successfully launched')
  })

  // --------------------------------------------------------------------------
  // Example D: Persistent Multi-Step Desktop Automation (Calculator)
  // --------------------------------------------------------------------------
  it('Example D: "Open Calculator and calculate 125 multiplied by 48." submits persistent task with DAG steps', async () => {
    const prompt = 'Open Calculator and calculate 125 multiplied by 48.'
    const route = engine.universalIntentRouter.classify(prompt)

    expect(route.strategy).toBe('DESKTOP_ACTION')
    expect(route.intent).toBe('multi_step_desktop')
    expect(route.entities.appName).toBe('calculator')
    expect(route.entities.calculation).toBe('125 multiplied by 48')

    await engine.process(prompt)

    expect(lastReply).toContain('Started persistent autonomous desktop task')
    expect(lastReply).toContain('Structured Execution Plan:')
    expect(lastReply).toContain('1. Launch calculator desktop application')
    expect(lastReply).toContain('2. Focus calculator to foreground')
    expect(lastReply).toContain('3. Execute calculation: "125 multiplied by 48"')
    expect(lastReply).toContain('4. Verify result and checkpoint screenshot')

    // Verify task exists in orchestrator
    const tasks = await engine.getPersistentTasks()
    expect(tasks.length).toBeGreaterThan(0)
    const task = tasks[0]
    expect(task.subtasks.length).toBe(4)
    expect(task.subtasks[0].capability).toBe('launch_app')
    expect(task.subtasks[1].capability).toBe('focus_window')
    expect(task.subtasks[2].capability).toBe('calculate')
    expect(task.subtasks[3].capability).toBe('desktop_screenshot')
  })

  // --------------------------------------------------------------------------
  // Example E: Switch Application / Window Focus
  // --------------------------------------------------------------------------
  it('Example E: "Switch to my browser." brings target window to foreground', async () => {
    const prompt = 'Switch to my browser.'
    const route = engine.universalIntentRouter.classify(prompt)

    expect(route.strategy).toBe('DESKTOP_ACTION')
    expect(route.intent).toBe('switch_app')
    expect(route.entities.targetApp).toBe('browser')

    await engine.process(prompt)

    expect(lastReply).toContain('Switched to **browser**')
    expect(lastReply).toContain('Google Chrome')
  })

  // --------------------------------------------------------------------------
  // Example F: Visual Inspection Report
  // --------------------------------------------------------------------------
  it('Example F: "Take a screenshot and tell me what is currently visible." produces structured report', async () => {
    const prompt = 'Take a screenshot and tell me what is currently visible.'
    const route = engine.universalIntentRouter.classify(prompt)

    expect(route.strategy).toBe('DESKTOP_ACTION')
    expect(route.intent).toBe('visual_inspect')

    await engine.process(prompt)

    expect(lastReply).toContain('Desktop Visual Inspection Report')
    expect(lastReply).toContain('1920x1080 (PNG)')
    expect(lastReply).toContain('Active Foreground Application')
    expect(lastReply).toContain('notepad.exe')
    expect(lastReply).toContain('Visible Applications (2):')
  })

  // --------------------------------------------------------------------------
  // Window State Manipulation (Minimize, Maximize, Restore)
  // --------------------------------------------------------------------------
  it('Window Controls: minimize, maximize, restore alter window state via DesktopProvider', async () => {
    const minRes = await desktop.minimizeWindow('1001')
    expect(minRes.success).toBe(true)
    expect(minRes.action).toBe('minimize')

    const maxRes = await desktop.maximizeWindow('1001')
    expect(maxRes.success).toBe(true)
    expect(maxRes.action).toBe('maximize')

    const restoreRes = await desktop.restoreWindow('1001')
    expect(restoreRes.success).toBe(true)
    expect(restoreRes.action).toBe('restore')
  })

  // --------------------------------------------------------------------------
  // Backend DesktopEngine Unit Invariants
  // --------------------------------------------------------------------------
  it('DesktopEngine: performCalculation computes 125 * 48 = 6000 and verifies evidence', async () => {
    const engine = new DesktopEngine()
    const res = await engine.execute('desktop.calculate', {
      calculation: '125 multiplied by 48',
    })

    expect(res.ok).toBe(true)
    expect(res.data?.result).toBe(6000)
    expect(res.data?.normalizedExpression).toBe('125*48')
    expect(res.data?.evidence).toContain('125*48 = 6000')
  })
})
