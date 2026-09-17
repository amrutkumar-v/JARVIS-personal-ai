import { describe, expect, it, beforeEach } from 'vitest'
import type { Tool, ToolResult } from '../tools/Tool'
import { requiresUserConfirmation } from '../tools/Tool'
import { FakeObservationProvider } from './testing'
import type { ObservationSeed } from './testing'
import { createObservationTools } from './ObservationTools'

/**
 * Phase 1.4 — observation tools, scenario coverage against the deterministic
 * in-memory provider (tests only). Every claim checks REAL provider state —
 * a tool never reports a screen that was not actually returned.
 */

function call(tool: Tool, params: Record<string, unknown>): Promise<ToolResult> {
  return tool.execute({ query: '', params }, { requestId: 'unit' })
}

const SEEDS: ObservationSeed[] = [
  { windowId: '1003', title: 'Explorer', pid: 300, processName: 'explorer.exe', visible: true, minimized: false, maximized: false, bounds: { left: 0, top: 0, right: 800, bottom: 600 } },
  { windowId: '1001', title: 'Notepad', pid: 401, processName: 'notepad.exe', visible: true, minimized: false, maximized: true },
  { windowId: '1002', title: 'Hidden Helper', pid: 500, processName: 'helper.exe', visible: false, minimized: true, maximized: false },
]

let provider: FakeObservationProvider
let tools: Map<string, Tool>

beforeEach(() => {
  provider = new FakeObservationProvider(SEEDS)
  tools = new Map(createObservationTools(provider).map((t) => [t.id, t]))
})

/* ---------------------------------------------------------------- surface */

describe('registration surface', () => {
  it('registers exactly the three read-only observation tools', () => {
    expect([...tools.keys()].sort()).toEqual(['desktop.screenshot', 'window.list', 'window.status'])
  })

  it('produces NO tools when no provider is supplied (browser mode)', () => {
    expect(createObservationTools(undefined)).toEqual([])
  })

  it('keeps window.list / window.status read_only and screenshot gated + verifiable', () => {
    expect(tools.get('window.list')!.permission).toBe('read_only')
    expect(tools.get('window.list')!.verifiable).toBe(false)
    expect(tools.get('window.status')!.permission).toBe('read_only')
    expect(tools.get('window.status')!.verifiable).toBe(true)
    const shot = tools.get('desktop.screenshot')!
    expect(shot.permission).toBe('user_confirmation')
    expect(shot.verifiable).toBe(true)
    expect(shot.requiresPermission).toBe(true)
    expect(requiresUserConfirmation(shot)).toBe(true)
    expect(shot.timeoutMs).toBe(10_000)
  })
})

/* ---------------------------------------------------------------- list */

describe('window.list', () => {
  it('returns deterministic, visible-first ordering and honest counts', async () => {
    const result = await call(tools.get('window.list')!, {})
    expect(result.ok).toBe(true)
    const windows = (result.data as { windows: Array<{ windowId: string; title: string }> }).windows.map((w) => ({
      windowId: w.windowId,
      title: w.title,
    }))
    expect(windows).toEqual([
      { windowId: '1003', title: 'Explorer' },
      { windowId: '1001', title: 'Notepad' },
      { windowId: '1002', title: 'Hidden Helper' },
    ])
    expect((result.data as { count: number }).count).toBe(3)
    expect((result.data as { visible: number }).visible).toBe(2)
    expect(result.message).toMatch(/3 windows.*\(2 visible\)/)
  })

  it('reports the REAL user-facing application inventory alongside the raw windows', async () => {
    const result = await call(tools.get('window.list')!, {})
    const data = result.data as {
      count: number
      apps: Array<{ label: string; processName?: string; labelInferred: boolean }>
      appCount: number
      appsNotAttributable: number
    }
    // The MODE's only input is the tool message, so the real inventory must be
    // part of it — the raw window list alone cannot answer "what is open?".
    expect(result.message).toMatch(/user-facing application/)
    // Application identity is the REAL process name (verbatim, not prettified).
    expect(result.message).toContain('notepad')
    expect(result.message).toContain('explorer')
    expect(data.appCount).toBe(2)
    expect(data.apps.map((a) => a.label).sort()).toEqual(['explorer', 'notepad'])
    expect(data.apps.find((a) => a.label === 'notepad')?.labelInferred).toBe(false)
    // The hidden window is reported as not attributable, never as an app.
    expect(data.appsNotAttributable).toBe(1)
    // ...and the raw window list is unchanged.
    expect(data.count).toBe(3)
  })

  it('reports an empty desktop honestly', async () => {
    const none = new FakeObservationProvider([])
    const list = createObservationTools(none).find((t) => t.id === 'window.list')!
    const result = await call(list, {})
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/No top-level windows/)
    expect((result.data as { windows: unknown[] }).windows).toEqual([])
  })

  it('refuses to fabricate a desktop when the provider is unavailable', async () => {
    provider.setAvailable(false, 'Native agent currently offline.')
    const result = await call(tools.get('window.list')!, {})
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not available/)
    expect((result.data as { reason: string }).reason).toBe('Native agent currently offline.')
  })
})

/* ---------------------------------------------------------------- status */

describe('window.status', () => {
  it('reports the current state of a window', async () => {
    const result = await call(tools.get('window.status')!, { window_id: '1001' })
    expect(result.ok).toBe(true)
    const status = result.data as { windowId: string; title: string; exists: boolean; visible: boolean }
    expect(status.windowId).toBe('1001')
    expect(status.title).toBe('Notepad')
    expect(status.visible).toBe(true)
    expect(status.exists).toBe(true)
    expect(result.message).toMatch(/Notepad.*visible, maximized/)
  })

  it('rejects non-decimal window ids before any provider call', async () => {
    const result = await call(tools.get('window.status')!, { window_id: '0x1A2B' })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/plain decimal/)
    expect((result.data as { kind: string }).kind).toBe('invalid_input')
    // The provider never saw the malformed id.
    expect(provider.statusCalls).toBe(0)
  })

  it('rejects an absent window_id', async () => {
    const result = await call(tools.get('window.status')!, {})
    expect(result.ok).toBe(false)
    expect((result.data as { kind: string }).kind).toBe('invalid_input')
  })

  it('honestly reports a closed window as not found', async () => {
    provider.close('1001')
    const result = await call(tools.get('window.status')!, { window_id: '1001' })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/does not exist/i)
  })

  it('verify confirms a window that exists and refutes one that left', async () => {
    const tool = tools.get('window.status')!
    const input = { query: '', params: { window_id: '1001' } as Record<string, unknown> }
    const ctx = { requestId: 'unit' }
    const ok = await tool.verify!(input, { ok: true, message: 'x' }, ctx)
    expect(ok.ok).toBe(true)
    expect(ok.checks).toEqual(['window exists'])

    provider.close('1001')
    const refuted = await tool.verify!(input, { ok: true, message: 'x' }, ctx)
    expect(refuted.ok).toBe(false)
    expect(refuted.message).toMatch(/does not exist|no longer exists/)
  })
})

/* ------------------------------------------------------------- screenshot */

describe('desktop.screenshot', () => {
  it('returns a real transient PNG and never claims vision', async () => {
    const result = await call(tools.get('desktop.screenshot')!, {})
    expect(result.ok).toBe(true)
    const data = result.data as { format: string; bytesLength: number; dataUrl: string; availableForVision: boolean }
    expect(data.format).toBe('png')
    expect(data.bytesLength).toBeGreaterThan(0)
    expect(data.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(data.availableForVision).toBe(false)
    expect(result.message).toMatch(/2x2 PNG \(\d+ bytes\)/)
  })

  it('verifies the claimed envelope structurally (signature, geometry, inflate)', async () => {
    const raw = await provider.captureScreenshot()
    const verification = await tools.get('desktop.screenshot')!.verify!(
      { query: '', params: {} as Record<string, unknown> },
      { ok: true, message: 'x', data: raw },
      { requestId: 'unit' },
    )
    expect(verification.ok).toBe(true)
    expect(verification.checks).toEqual(['png signature', 'ihdr geometry', 'chunk crc', 'inflate size'])
  })

  it('verifies the REAL engine result shape, whose payload lives in the dataUrl (live regression)', async () => {
    // The executor sees what execute() returned — data with a dataUrl and NO
    // raw `bytes` field. That shape used to fail verification with "no
    // verifiable payload", so a real capture was reported as unverifiable.
    const result = await call(tools.get('desktop.screenshot')!, {})
    expect(result.ok).toBe(true)
    const verification = await tools.get('desktop.screenshot')!.verify!(
      { query: '', params: {} as Record<string, unknown> },
      result,
      { requestId: 'unit' },
    )
    expect(verification.ok).toBe(true)
    expect(verification.message).toMatch(/2x2 PNG/)
  })

  it('refutes a tampered payload as verification failed', async () => {
    // The tool result only carries the dataUrl; the tamper test uses the raw
    // provider payload directly to prove the verifier is structural.
    const raw = await provider.captureScreenshot()
    const bytes = raw.bytes
    // Flip one base64 character inside the 8-byte PNG signature.
    const tampered = bytes.slice(0, 4) + 'W' + bytes.slice(5)
    const verification = await tools.get('desktop.screenshot')!.verify!(
      { query: '', params: {} as Record<string, unknown> },
      { ok: true, message: 'x', data: { width: 2, height: 2, format: 'png', bytesLength: tampered.length, bytes: tampered } },
      { requestId: 'unit' },
    )
    expect(verification.ok).toBe(false)
    expect(verification.message).toMatch(/not a PNG|invalid/)
  })

  it('honestly fails when the capture itself fails', async () => {
    provider.setAvailable(false, 'Screenshot disabled in this test.')
    const result = await call(tools.get('desktop.screenshot')!, {})
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not available/)
  })
})

/* ---------------------------------------------------------------- leaks */

describe('metadata leak rail', () => {
  it('never exposes targets, paths or raw handles', async () => {
    const list = await call(tools.get('window.list')!, {})
    const serialized = JSON.stringify(list.data)
    expect(serialized).not.toMatch(/target|handle|hwnd|\\\\/i)
  })
})