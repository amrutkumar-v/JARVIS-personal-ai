import { describe, expect, it } from 'vitest'
import {
  MAX_INVENTORY_CHARS,
  MAX_RUNNING_APPS,
  MAX_TITLES_PER_APP,
  deriveRunningApps,
  renderRunningApps,
} from './runningApps'
import type { WindowSummary } from './provider'

/**
 * "What applications are open?" is answered from a REAL window enumeration.
 *
 * These tests pin the honesty rules: only visible titled windows count, Windows
 * shell surfaces are excluded (and counted), the application identity is the
 * owning process (a real observation) with a title-based fallback that is
 * FLAGGED as inferred, and the output is bounded and deterministic.
 */

function win(over: Partial<WindowSummary> & { windowId: string; title: string }): WindowSummary {
  return {
    visible: true,
    minimized: false,
    maximized: false,
    ...over,
  } as WindowSummary
}

const DESKTOP: WindowSummary[] = [
  win({ windowId: '1', title: 'Program Manager', processName: 'explorer.exe' }),
  win({ windowId: '2', title: 'New Tab - Google Chrome', processName: 'chrome.exe' }),
  win({ windowId: '3', title: 'Docs - Google Chrome', processName: 'chrome.exe' }),
  win({ windowId: '4', title: 'Untitled - Notepad', processName: 'notepad.exe' }),
  win({ windowId: '5', title: 'Spotify Premium', processName: 'Spotify.exe' }),
  win({ windowId: '6', title: 'Hidden Helper', processName: 'helper.exe', visible: false }),
  win({ windowId: '7', title: '   ', processName: 'ghost.exe' }),
  win({ windowId: '8', title: 'Calculator', processName: 'ApplicationFrameHost.exe' }),
  win({ windowId: '9', title: 'Windows Input Experience', processName: 'TextInputHost.exe' }),
]

describe('deriveRunningApps — real observation only', () => {
  it('lists user-facing applications from real visible windows', () => {
    const report = deriveRunningApps(DESKTOP)
    const labels = report.apps.map((a) => a.label)

    expect(labels).toContain('chrome')
    expect(labels).toContain('notepad')
    expect(labels).toContain('Spotify')
    expect(labels).toContain('Calculator')
    // Shell surfaces and unattributable windows are NEVER applications.
    expect(labels).not.toContain('explorer')
    expect(labels).not.toContain('ghost')
    expect(labels).not.toContain('TextInputHost')
  })

  it('groups windows by their real owning process', () => {
    const chrome = deriveRunningApps(DESKTOP).apps.find((a) => a.label === 'chrome')!
    expect(chrome.processName).toBe('chrome')
    expect(chrome.windowCount).toBe(2)
    expect(chrome.titles).toEqual(['New Tab - Google Chrome', 'Docs - Google Chrome'])
    expect(chrome.labelInferred).toBe(false)
    expect(chrome.windowIds).toEqual(['2', '3'])
  })

  it('flags a title-derived identity as inferred and says why', () => {
    const calculator = deriveRunningApps(DESKTOP).apps.find((a) => a.label === 'Calculator')!
    expect(calculator.labelInferred).toBe(true)
    expect(calculator.processName).toBe('ApplicationFrameHost')
    expect(renderRunningApps(deriveRunningApps(DESKTOP))).toContain(
      'Calculator (identified from its window title)',
    )
  })

  it('reports what it set aside instead of pretending to have filtered it', () => {
    const report = deriveRunningApps(DESKTOP)
    // 9 windows: 2 not attributable (hidden + blank title), 2 shell surfaces.
    expect(report.notAttributable).toBe(2)
    expect(report.excludedShell).toBe(2)
    expect(report.considered).toBe(5)
  })

  it('is deterministic (most windows first, then label)', () => {
    expect(deriveRunningApps(DESKTOP).apps.map((a) => a.label)).toEqual(
      deriveRunningApps([...DESKTOP].reverse()).apps.map((a) => a.label),
    )
  })

  it('reports an empty desktop honestly', () => {
    const report = deriveRunningApps([])
    expect(report.apps).toEqual([])
    expect(renderRunningApps(report)).toBe('')
  })

  it('bounds the inventory and per-app titles', () => {
    const many: WindowSummary[] = Array.from({ length: 40 }, (_, i) =>
      win({ windowId: `${i}`, title: `Window ${i}`, processName: `app${i}.exe` }),
    )
    const report = deriveRunningApps(many)
    expect(report.apps).toHaveLength(MAX_RUNNING_APPS)

    const chatty: WindowSummary[] = Array.from({ length: 10 }, (_, i) =>
      win({ windowId: `${i}`, title: `Tab ${i} - Chrome`, processName: 'chrome.exe' }),
    )
    expect(deriveRunningApps(chatty).apps[0]!.titles).toHaveLength(MAX_TITLES_PER_APP)

    const rendered = renderRunningApps(deriveRunningApps(many))
    expect(rendered.length).toBeLessThanOrEqual(MAX_INVENTORY_CHARS)
  })
})
