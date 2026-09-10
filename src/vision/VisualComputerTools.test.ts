import { describe, expect, it } from 'vitest'
import { createFakeVisionProvider } from './testing'
import { FakeObservationProvider } from '../observation/testing'
import { FakeDesktopInteractionProvider } from '../desktop/testing'
import { createVisualComputerTools } from './VisualComputerTools'
import type { Tool, ToolContext, ToolInput, ToolResult } from '../tools/Tool'
import type { VisionProvider } from './provider'
import type { ScreenshotResult } from '../observation'

/**
 * Phase 1.7 — visual computer tools through the REAL tool classes +
 * deterministic fakes (all fakes sized to the 2x2 fake screenshot surface).
 */

function harness(): {
  vision: ReturnType<typeof createFakeVisionProvider>
  observation: FakeObservationProvider
  desktop: FakeDesktopInteractionProvider
  tools: Tool[]
  inspect: Tool
  click: Tool
  type: Tool
} {
  const observation = new FakeObservationProvider([
    { windowId: '1', title: 'App', bounds: { left: 0, top: 0, right: 2, bottom: 2 } },
  ])
  const desktop = new FakeDesktopInteractionProvider([{ windowId: '1' }], { left: 0, top: 0, width: 2, height: 2 })
  const vision = createFakeVisionProvider()
  const tools = createVisualComputerTools(vision, observation, desktop)
  const find = (id: string): Tool => {
    const tool = tools.find((t) => t.id === id)
    if (!tool) throw new Error(`missing tool ${id}`)
    return tool
  }
  return {
    vision,
    observation,
    desktop,
    tools,
    inspect: find('desktop.visualInspect'),
    click: find('desktop.visualClick'),
    type: find('desktop.visualType'),
  }
}

const CTX: ToolContext = { requestId: 'r1' }
const input = (params: Record<string, unknown>): ToolInput => ({ query: 'go', params })

/** Vision spy that aborts the run CANCELLATION signal after the first analysis
 * (proves a real mid-pipeline cancellation stops the injection). */
class AbortAfterFirstAnalysis implements VisionProvider {
  readonly id = 'abort-after-first'
  readonly testsOnly = true
  private readonly inner = createFakeVisionProvider()
  private readonly controller: AbortController

  constructor(controller: AbortController) {
    this.controller = controller
  }

  capabilities() {
    return this.inner.capabilities()
  }

  async analyzeScreenshot(screenshot: ScreenshotResult, options?: Parameters<VisionProvider['analyzeScreenshot']>[1]) {
    const result = await this.inner.analyzeScreenshot(screenshot, options)
    this.controller.abort()
    return result
  }
}

describe('createVisualComputerTools', () => {
  it('registers nothing when vision is missing (browser/app mode)', () => {
    expect(createVisualComputerTools(undefined, new FakeObservationProvider(), new FakeDesktopInteractionProvider([]))).toEqual([])
  })

  it('registers nothing when observation is missing', () => {
    expect(createVisualComputerTools(createFakeVisionProvider(), undefined, new FakeDesktopInteractionProvider([]))).toEqual([])
  })

  it('registers nothing when desktop is missing', () => {
    expect(createVisualComputerTools(createFakeVisionProvider(), new FakeObservationProvider(), undefined)).toEqual([])
  })

  it('registers all three tools only when the full triple is present', () => {
    const h = harness()
    expect(h.tools.map((t) => t.id)).toEqual(['desktop.visualInspect', 'desktop.visualClick', 'desktop.visualType'])
  })
})

describe('desktop.visualInspect', () => {
  it('reports a bounded, text-free element inventory', async () => {
    const h = harness()
    const result = (await h.inspect.execute(input({}), CTX)) as ToolResult & { data: { elements: Array<Record<string, unknown>> } }
    expect(result.ok).toBe(true)
    expect(result.data.elements.length).toBeGreaterThan(0)
    for (const e of result.data.elements) {
      expect(e).not.toHaveProperty('text')
      expect(e).not.toHaveProperty('bytes')
      expect(e).not.toHaveProperty('pixels')
    }
    expect(h.vision.analyzeCalls).toBe(1)
  })

  it('refuses when the provider reports vision unavailable', async () => {
    const h = harness()
    h.vision.setAvailable(false)
    const result = await h.inspect.execute(input({}), CTX)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not available/i)
  })

  it('refuses when the provider throws (analysis failure)', async () => {
    const h = harness()
    h.vision.setFailure('engine offline')
    const result = await h.inspect.execute(input({}), CTX)
    expect(result.ok).toBe(false)
    expect((result.data as { kind?: string }).kind).toBe('io')
  })

  it('refuses when the run is already cancelled', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort()
    const result = await h.inspect.execute(input({}), { ...CTX, signal: controller.signal })
    expect(result.ok).toBe(false)
    expect((result.data as { kind?: string }).kind).toBe('user_cancelled')
    expect(h.vision.analyzeCalls).toBe(0)
  })

  it('scopes the inventory to the measured window surface when window_id is given', async () => {
    // The window covers only the left half of the 2x2 surface.
    const observation = new FakeObservationProvider([
      { windowId: '1', title: 'App', bounds: { left: 0, top: 0, right: 1, bottom: 2 }, clientBounds: { left: 0, top: 0, right: 1, bottom: 2 } },
    ])
    const desktop = new FakeDesktopInteractionProvider([{ windowId: '1' }], { left: 0, top: 0, width: 2, height: 2 })
    const vision = createFakeVisionProvider()
    // Centers (JS Math.round rounds .5 up): a→(0,0) inside, b→(2,0) outside, c→(0,1) inside.
    vision.setElements([
      { id: 'a', type: 'button', label: 'A', bounds: { x: 0, y: 0, width: 0.5, height: 0.5 }, confidence: 1 },
      { id: 'b', type: 'button', label: 'B', bounds: { x: 1, y: 0, width: 1, height: 1 }, confidence: 1 },
      { id: 'c', type: 'text', label: 'C', bounds: { x: 0, y: 1, width: 0.5, height: 0.5 }, confidence: 1 },
    ])
    const inspect = createVisualComputerTools(vision, observation, desktop).find(
      (t) => t.id === 'desktop.visualInspect',
    ) as Tool
    const result = await inspect.execute(input({ window_id: '1' }), CTX)
    expect(result.ok).toBe(true)
    const data = result.data as { scopedTo: string; elements: Array<{ id: string }> }
    expect(data.scopedTo).toBe('1')
    expect(data.elements.map((e) => e.id)).toEqual(['a', 'c'])
  })

  it('falls back to the outer frame when no clientBounds are measured', async () => {
    const observation = new FakeObservationProvider([
      { windowId: '1', title: 'App', bounds: { left: 0, top: 0, right: 2, bottom: 2 } },
    ])
    const desktop = new FakeDesktopInteractionProvider([{ windowId: '1' }], { left: 0, top: 0, width: 2, height: 2 })
    const vision = createFakeVisionProvider()
    // a(0,0) inside the frame; b(2,0) on the exclusive right edge → outside.
    vision.setElements([
      { id: 'a', type: 'button', label: 'A', bounds: { x: 0, y: 0, width: 0.5, height: 0.5 }, confidence: 1 },
      { id: 'b', type: 'button', label: 'B', bounds: { x: 1, y: 0, width: 1, height: 1 }, confidence: 1 },
    ])
    const inspect = createVisualComputerTools(vision, observation, desktop).find(
      (t) => t.id === 'desktop.visualInspect',
    ) as Tool
    const result = await inspect.execute(input({ window_id: '1' }), CTX)
    expect(result.ok).toBe(true)
    expect((result.data as { elements: Array<{ id: string }> }).elements.map((e) => e.id)).toEqual(['a'])
  })

  it('refuses to scope to a window that no longer exists', async () => {
    const observation = new FakeObservationProvider([
      { windowId: '1', title: 'App', bounds: { left: 0, top: 0, right: 1, bottom: 2 }, clientBounds: { left: 0, top: 0, right: 1, bottom: 2 } },
    ])
    const desktop = new FakeDesktopInteractionProvider([{ windowId: '1' }], { left: 0, top: 0, width: 2, height: 2 })
    const vision = createFakeVisionProvider()
    const inspect = createVisualComputerTools(vision, observation, desktop).find(
      (t) => t.id === 'desktop.visualInspect',
    ) as Tool
    const result = await inspect.execute(input({ window_id: '999' }), CTX)
    expect(result.ok).toBe(false)
    // Nothing analysed — the scope is refused before the screen is ever seen.
    expect(vision.analyzeCalls).toBe(0)
  })
})

describe('desktop.visualClick', () => {
  it('locates the target, clicks once, re-observes and verifies', async () => {
    const h = harness()
    const result = await h.click.execute(input({ target: 'Settings', window_id: '1', expected_after: 'Saved' }), CTX)
    expect(result.ok).toBe(true)
    const data = result.data as { resolution: { status: string; element: { id: string } }; injected: { x: number; y: number }; verdict: { verdict: string } }
    expect(data.resolution.status).toBe('found')
    expect(data.resolution.element.id).toBe('el-settings')
    // Element centre (1,1) on the 2x2 surface → client (1,1).
    expect(data.injected).toMatchObject({ x: 1, y: 1 })
    expect(data.verdict.verdict).toBe('verified')
    // One action injected; two analyses (before + after); three captures
    // (analysis + stale-gate re-capture + post-action).
    expect(h.desktop.calls.click).toBe(1)
    expect(h.vision.analyzeCalls).toBe(2)
    expect(h.observation.screenshotCalls).toBe(3)
    // The verifier confirms on the existing engine rails.
    const verification = await (h.click as Tool & { verify(i: ToolInput, r: ToolResult): Promise<unknown> }).verify(input({}), result)
    expect(verification).toMatchObject({ ok: true })
  })

  it('refuses an ambiguous target — nothing is injected', async () => {
    const h = harness()
    const result = await h.click.execute(input({ target: 'Submit', window_id: '1' }), CTX)
    expect(result.ok).toBe(false)
    expect((result.data as { resolution?: string }).resolution).toBe('ambiguous')
    expect(h.desktop.calls.click).toBe(0)
  })

  it('uses EXACT clientBounds for injection when measured (frame offset removed)', async () => {
    // Frame covers the 2x2 surface; the CLIENT area starts 1px below the title bar.
    const observation = new FakeObservationProvider([
      { windowId: '1', title: 'App', bounds: { left: 0, top: 0, right: 2, bottom: 2 }, clientBounds: { left: 0, top: 1, right: 2, bottom: 2 } },
    ])
    const desktop = new FakeDesktopInteractionProvider([{ windowId: '1' }], { left: 0, top: 0, width: 2, height: 2 })
    const vision = createFakeVisionProvider()
    // Center rounds to (1,1): viewport → screen (1,1) → client (1,0) with the 1px title-bar offset.
    vision.setElements([
      { id: 'el-field', type: 'input', label: 'Search', bounds: { x: 0.5, y: 1, width: 1, height: 0.5 }, confidence: 1 },
    ])
    const click = createVisualComputerTools(vision, observation, desktop).find((t) => t.id === 'desktop.visualClick') as Tool
    const result = await click.execute(input({ target: 'Search', window_id: '1' }), CTX)
    expect(result.ok).toBe(true)
    const data = result.data as { injected: { windowId: string; x: number; y: number } }
    expect(data.injected).toEqual({ windowId: '1', x: 1, y: 0 })
    expect(desktop.calls.click).toBe(1)
  })

  it('refuses to click a target in the window FRAME (outside the measured client area)', async () => {
    // Element center (0,0) — inside the outer frame, above the measured client area.
    const observation = new FakeObservationProvider([
      { windowId: '1', title: 'App', bounds: { left: 0, top: 0, right: 2, bottom: 2 }, clientBounds: { left: 0, top: 1, right: 2, bottom: 2 } },
    ])
    const desktop = new FakeDesktopInteractionProvider([{ windowId: '1' }], { left: 0, top: 0, width: 2, height: 2 })
    const vision = createFakeVisionProvider()
    vision.setElements([
      { id: 'el-title', type: 'text', label: 'Title', bounds: { x: 0.3, y: 0.2, width: 0.3, height: 0.3 }, confidence: 1 },
    ])
    const click = createVisualComputerTools(vision, observation, desktop).find((t) => t.id === 'desktop.visualClick') as Tool
    const result = await click.execute(input({ target: 'Title', window_id: '1' }), CTX)
    expect(result.ok).toBe(false)
    expect((result.data as { kind?: string }).kind).toBe('invalid_input')
    expect(desktop.calls.click).toBe(0)
  })

  it('refuses to click a target that lands in ANOTHER window on the desktop', async () => {
    // The element center (2,0) sits at the exclusive right edge of the selected window → outside its scope.
    const observation = new FakeObservationProvider([
      { windowId: '1', title: 'App', bounds: { left: 0, top: 0, right: 2, bottom: 2 }, clientBounds: { left: 0, top: 0, right: 2, bottom: 2 } },
    ])
    const desktop = new FakeDesktopInteractionProvider([{ windowId: '1' }], { left: 0, top: 0, width: 2, height: 2 })
    const vision = createFakeVisionProvider()
    vision.setElements([
      { id: 'el-other', type: 'button', label: 'Outside', bounds: { x: 1.5, y: 0, width: 0.5, height: 0.5 }, confidence: 1 },
    ])
    const click = createVisualComputerTools(vision, observation, desktop).find((t) => t.id === 'desktop.visualClick') as Tool
    const result = await click.execute(input({ target: 'Outside', window_id: '1' }), CTX)
    expect(result.ok).toBe(false)
    expect(desktop.calls.click).toBe(0)
  })

  it('refuses a missing target — nothing is injected', async () => {
    const h = harness()
    const result = await h.click.execute(input({ target: 'Banana', window_id: '1' }), CTX)
    expect(result.ok).toBe(false)
    expect((result.data as { resolution?: string }).resolution).toBe('not_found')
    expect(h.desktop.calls.click).toBe(0)
  })

  it('refutes when expected_after did not appear (no fabricated success)', async () => {
    const h = harness()
    const result = await h.click.execute(input({ target: 'Settings', window_id: '1', expected_after: 'Totally new state' }), CTX)
    expect(result.ok).toBe(true)
    expect((result.data as { verdict: { verdict: string } }).verdict.verdict).toBe('refuted')
    const verification = await (h.click as Tool & { verify(i: ToolInput, r: ToolResult): Promise<unknown> }).verify(input({}), result)
    expect(verification).toMatchObject({ ok: false })
  })

  it('is unverified (not completed) when no expected_after was supplied', async () => {
    const h = harness()
    const result = await h.click.execute(input({ target: 'Settings', window_id: '1' }), CTX)
    expect(result.ok).toBe(true)
    expect((result.data as { verdict: { verdict: string } }).verdict.verdict).toBe('unverified')
    await expect(
      (h.click as Tool & { verify(i: ToolInput, r: ToolResult): Promise<unknown> }).verify(input({}), result),
    ).rejects.toThrow(/not confirmed/)
  })

  it('rejects invalid params before any analysis or injection', async () => {
    const h = harness()
    const before = h.vision.analyzeCalls
    const noArgs = await h.click.execute(input({}), CTX)
    expect(noArgs.ok).toBe(false)
    const badWindow = await h.click.execute(input({ target: 'x', window_id: 'notnumeric' }), CTX)
    expect(badWindow.ok).toBe(false)
    expect(h.vision.analyzeCalls).toBe(before)
    expect(h.desktop.calls.click).toBe(0)
  })

  it('does not inject when the run is cancelled mid-pipeline', async () => {
    const controller = new AbortController()
    const observation = new FakeObservationProvider([
      { windowId: '1', title: 'App', bounds: { left: 0, top: 0, right: 2, bottom: 2 } },
    ])
    const desktop = new FakeDesktopInteractionProvider([{ windowId: '1' }], { left: 0, top: 0, width: 2, height: 2 })
    const vision = new AbortAfterFirstAnalysis(controller)
    const click = createVisualComputerTools(vision, observation, desktop).find((t) => t.id === 'desktop.visualClick') as Tool
    const result = await click.execute(input({ target: 'Settings', window_id: '1' }), { ...CTX, signal: controller.signal })
    expect(result.ok).toBe(false)
    expect((result.data as { kind?: string }).kind).toBe('user_cancelled')
    expect(desktop.calls.click).toBe(0)
  })
})

describe('desktop.visualClick — stale-observation gate', () => {
  it('passes the gate when the observation is unchanged (deterministic success path)', async () => {
    const h = harness()
    const result = await h.click.execute(input({ target: 'Settings', window_id: '1' }), CTX)
    expect(result.ok).toBe(true)
    // Analysis capture + gate re-capture + post-action capture; status once for
    // coordinate conversion + once for the gate.
    expect(h.observation.screenshotCalls).toBe(3)
    expect(h.observation.statusCalls).toBe(2)
    expect(h.vision.analyzeCalls).toBe(2)
    expect(h.desktop.calls.click).toBe(1)
  })

  it('refuses injection when the screen changes after analysis', async () => {
    const h = harness()
    // Capture 1 (analysis) sees "screen-a"; the gate's re-capture sees "screen-b".
    h.observation.pushScreenshot({ bytes: 'screen-a' })
    h.observation.pushScreenshot({ bytes: 'screen-b' })
    const result = await h.click.execute(input({ target: 'Settings', window_id: '1' }), CTX)
    expect(result.ok).toBe(false)
    expect(result.data).toMatchObject({ kind: 'stale_observation', cause: 'screen_changed' })
    expect(result.message).toMatch(/changed between analysis and injection/)
    expect(h.desktop.calls.click).toBe(0)
  })

  it('refuses injection when the window moves after the coordinates were converted', async () => {
    const h = harness()
    // Status call 1 converts coordinates; call 2 (the gate) sees a moved window.
    h.observation.onStatusBefore(2, () => h.observation.mutateWindow('1', { bounds: { left: 1, top: 0, right: 3, bottom: 2 } }))
    const result = await h.click.execute(input({ target: 'Settings', window_id: '1' }), CTX)
    expect(result.ok).toBe(false)
    expect(result.data).toMatchObject({ kind: 'stale_observation', cause: 'window_changed' })
    expect(result.message).toMatch(/moved or resized after analysis/)
    expect(h.desktop.calls.click).toBe(0)
  })

  it('refuses a resize before injection via the measured clientBounds', async () => {
    const h = harness()
    h.observation.onStatusBefore(2, () => h.observation.mutateWindow('1', { clientBounds: { left: 0, top: 1, right: 2, bottom: 2 } }))
    const result = await h.click.execute(input({ target: 'Settings', window_id: '1' }), CTX)
    expect(result.ok).toBe(false)
    expect(result.data).toMatchObject({ kind: 'stale_observation', cause: 'window_changed' })
    expect(h.desktop.calls.click).toBe(0)
  })

  it('refuses injection when the window closes after analysis', async () => {
    const h = harness()
    h.observation.onStatusBefore(2, () => h.observation.close('1'))
    const result = await h.click.execute(input({ target: 'Settings', window_id: '1' }), CTX)
    expect(result.ok).toBe(false)
    expect(result.data).toMatchObject({ kind: 'stale_observation', cause: 'window_closed' })
    expect(result.message).toMatch(/closed before the action could be injected/)
    expect(h.desktop.calls.click).toBe(0)
  })

  it('charges the stale refusal as a refused action — nothing ever injects', async () => {
    const h = harness()
    h.observation.pushScreenshot({ bytes: 'gone' })
    h.observation.pushScreenshot({ bytes: 'changed' })
    const result = await h.click.execute(input({ target: 'Settings', window_id: '1', expected_after: 'Saved' }), CTX)
    expect(result.ok).toBe(false)
    // No post-action verification is even attempted on a refused gate.
    expect(h.vision.analyzeCalls).toBe(1)
    expect(h.desktop.calls.click).toBe(0)
  })
})

describe('desktop.visualType — stale-observation gate', () => {
  it('passes the gate when unchanged and still only reports the character count', async () => {
    const h = harness()
    const result = await h.type.execute(input({ target: 'Settings', window_id: '1', text: 'hunter2' }), CTX)
    expect(result.ok).toBe(true)
    expect(h.observation.screenshotCalls).toBe(3)
    expect(h.observation.statusCalls).toBe(2)
    expect(h.desktop.calls.click).toBe(1)
    expect(h.desktop.calls.type).toBe(1)
    expect(JSON.stringify(result)).not.toContain('hunter2')
  })

  it('refuses typing when the screen changed after analysis — no focus click, no text', async () => {
    const h = harness()
    h.observation.pushScreenshot({ bytes: 'before' })
    h.observation.pushScreenshot({ bytes: 'after' })
    const result = await h.type.execute(input({ target: 'Settings', window_id: '1', text: 'hunter2' }), CTX)
    expect(result.ok).toBe(false)
    expect(result.data).toMatchObject({ kind: 'stale_observation', cause: 'screen_changed' })
    expect(h.desktop.calls.click).toBe(0)
    expect(h.desktop.calls.type).toBe(0)
    expect(JSON.stringify(result)).not.toContain('hunter2')
  })
})

describe('desktop.visualType', () => {
  it('focus-clicks the field, types bounded text, and reports only the length', async () => {
    const h = harness()
    const result = await h.type.execute(input({ target: 'Settings', window_id: '1', text: 'hunter2' }), CTX)
    expect(result.ok).toBe(true)
    const data = result.data as { length: number }
    expect(data.length).toBe('hunter2'.length)
    // The text itself never leaves the tool: no message/data echo.
    expect(JSON.stringify(result)).not.toContain('hunter2')
    expect(h.desktop.calls.click).toBe(1)
    expect(h.desktop.calls.type).toBe(1)
    expect(h.desktop.interactionLog.every((e) => e.name !== 'type' || e.textLength === 7)).toBe(true)
  })

  it('requires text', async () => {
    const h = harness()
    const result = await h.type.execute(input({ target: 'Search', window_id: '1', text: '' }), CTX)
    expect(result.ok).toBe(false)
    expect(h.desktop.calls.type).toBe(0)
  })
})