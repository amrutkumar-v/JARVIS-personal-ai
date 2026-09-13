import { describe, expect, it } from 'vitest'
import type { Tool } from '../tools/Tool'
import type { ApplicationProvider } from './provider'
import type { AppLaunchResult, AppOp, AppSpec, AppStatus, ApplicationCapabilities } from './provider'
import { normalizeAppTarget, normalizeApplicationId } from './provider'
import { createApplicationTools } from './ApplicationTools'
import { toAppId } from '../engine/orchestrator/planner'
import { classifyRequest } from '../engine/action/classifier'
import type { ActionRegistryView } from '../engine/action/types'
import { FileSystemError } from '../filesystem'
import { mapNativeCode } from '../native/nativeRpc'

/**
 * Phase 1.3 / 3.0B — name → app-id resolution and request routing.
 *
 * The web side must accept human names ("Google Chrome", "WhatsApp") and shape
 * them into app-id targets the native registry resolves authoritatively; the
 * classifier must prefer the apps domain for bare "open X" launch requests
 * when an application mechanism is actually connected — and never steal them
 * when the request is about a file, folder or path.
 */

/* ---------------------------------------------------------------- target shaping */

describe('name → app-id target shaping', () => {
  it('slugs a display name into an id-shaped target', () => {
    expect(normalizeAppTarget('Google Chrome')).toBe('google-chrome')
    expect(normalizeAppTarget('  VS Code  ')).toBe('vs-code')
    expect(normalizeAppTarget('WhatsApp')).toBe('whatsapp')
    expect(normalizeAppTarget('Microsoft Windows Calculator')).toBe('microsoft-windows-calculator')
  })

  it('never produces absolute paths or shell-adjacent fragments', () => {
    expect(normalizeAppTarget('a/b.exe')).toBe('a-b-exe')
    expect(normalizeAppTarget('C:\\Program Files')).toBe('c-program-files')
    expect(normalizeAppTarget('..\\..\\chrome')).toBe('chrome')
  })

  it('strips non-ascii, bounds to the id-charset length', () => {
    expect(normalizeAppTarget('café')).toBe('caf')
    expect(normalizeAppTarget('x'.repeat(200)).length).toBeLessThanOrEqual(64)
    expect(normalizeApplicationId(normalizeAppTarget('Google Chrome'))).toEqual({ id: 'google-chrome' })
  })

  it('planner toAppId mirrors the web normalizeAppTarget', () => {
    for (const phrase of ['Google Chrome', 'WhatsApp', 'Visual Studio Code', '  Notepad  ', 'a/b.exe', 'café', 'MS', '']) {
      expect(toAppId(phrase), phrase).toBe(normalizeAppTarget(phrase))
    }
  })
})

/* ---------------------------------------------------------------- launch tool routing */

class RecordingProvider implements ApplicationProvider {
  readonly id = 'recording'
  last: Array<{ applicationId: string; options?: { folder?: string } }> = []

  capabilities(): ApplicationCapabilities {
    const ops = Object.fromEntries((['list', 'status', 'launch', 'refresh'] as const).map((op) => [op, true])) as Record<AppOp, boolean>
    return { available: true, ops }
  }
  async list(): Promise<AppSpec[]> {
    return [{ applicationId: 'chrome', name: 'Google Chrome', displayName: 'Google Chrome', source: 'configured', enabled: true, launchable: true } as AppSpec]
  }
  async status(applicationId: string): Promise<AppStatus> {
    return {
      applicationId,
      name: applicationId,
      displayName: applicationId,
      source: 'configured',
      enabled: true,
      launchable: true,
      running: false,
      runningVerified: true,
    }
  }
  async launch(applicationId: string, options?: { folder?: string }): Promise<AppLaunchResult> {
    this.last.push({ applicationId, options })
    return { applicationId, started: true, verified: true, detail: 'ok' }
  }
}

function makeLaunchTool(): { tool: Tool; provider: RecordingProvider } {
  const provider = new RecordingProvider()
  const tools = new Map(createApplicationTools(provider).map((t) => [t.id, t]))
  return { tool: tools.get('app.launch')!, provider }
}

describe('app.launch target routing', () => {
  it('shapes a human name into a slug before calling the provider', async () => {
    const { tool, provider } = makeLaunchTool()
    const out = await tool.execute({ query: '', params: { application_id: 'Google Chrome' } }, { requestId: 'u' })
    expect(out.ok).toBe(true)
    expect(provider.last).toEqual([{ applicationId: 'google-chrome' }])
  })

  it('passes canonical ids through unchanged', async () => {
    const { tool, provider } = makeLaunchTool()
    await tool.execute({ query: '', params: { application_id: 'chrome' } }, { requestId: 'u' })
    expect(provider.last[0].applicationId).toBe('chrome')
  })

  it('forwards the optional folder to the provider', async () => {
    const { tool, provider } = makeLaunchTool()
    await tool.execute(
      { query: '', params: { application_id: 'explorer', folder: 'C:\\Users\\me\\Downloads' } },
      { requestId: 'u' },
    )
    expect(provider.last[0]).toEqual({ applicationId: 'explorer', options: { folder: 'C:\\Users\\me\\Downloads' } })
  })
})

/* ---------------------------------------------------------------- canRun broadening */

describe('app.launch canRun — broad launch-verb coverage', () => {
  function canRun(text: string): boolean {
    return makeLaunchTool().tool.canRun(text)
  }

  it('accepts explicit well-known apps', () => {
    for (const t of ['open WhatsApp', 'Open Google Chrome', 'start Spotify', 'run Notepad', 'launch Visual Studio Code', 'wake Calculator']) {
      expect(canRun(t), t).toBe(true)
    }
  })

  it('does NOT claim file/folder/path requests', () => {
    for (const t of ['open the document', 'open my file.txt', 'open the folder', 'open C:\\Users\\me', 'open Downloads', 'open "report.pdf"']) {
      expect(canRun(t), t).toBe(false)
    }
  })

  it('accepts the explicit app-noun fallback', () => {
    expect(canRun('open the Settings application')).toBe(true)
    expect(canRun('launch the program called photo')).toBe(true)
  })

  it('rejects non-launch intents', () => {
    for (const t of ['close WhatsApp', 'is Notepad running', 'list installed apps']) {
      expect(canRun(t), t).toBe(false)
    }
  })
})

/* ---------------------------------------------------------------- classifier tie-break */

function appsView(): ActionRegistryView {
  return {
    tools: [{ id: 'app.launch', label: 'Launch application', permission: 'low_risk', canRun: () => false }],
    capabilities: [
      {
        id: 'open_application',
        label: 'Open application',
        description: 'Launch the app identified by its registered app key.',
        toolIds: ['app.launch'],
      },
    ],
  }
}

function noAppsView(): ActionRegistryView {
  return {
    tools: [],
    capabilities: [],
  }
}

describe('classifier — apps domain takes bare launch requests', () => {
  it('routes "open WhatsApp" to apps when an app mechanism is connected', () => {
    const d = classifyRequest('open WhatsApp', appsView())
    expect(d.kind).toBe('executable')
    expect(d.domain).toBe('apps')
  })

  it('routes "open Spotify" to apps on a bare launch verb alone', () => {
    const d = classifyRequest('open Spotify', appsView())
    expect(d.domain).toBe('apps')
  })

  it('never steals file-target requests into apps', () => {
    for (const t of ['open the file', 'open report.pdf', 'open the folder', 'open in Downloads']) {
      const d = classifyRequest(t, appsView())
      expect(d.domain, t).not.toBe('apps')
    }
  })

  it('without a connected app mechanism it stays in the recognised domain', () => {
    const d = classifyRequest('open WhatsApp', noAppsView())
    expect(d.domain).not.toBe('apps')
  })
})

/* ---------------------------------------------------------------- native code mapping */

describe('native error mapping — ambiguous resolution', () => {
  it('maps the structured ambiguous code onto a web-friendly error', () => {
    const e = mapNativeCode('ambiguous', '"calc" matches Calculator and CalcDev; name one.', 'calc')
    expect(e).toBeInstanceOf(FileSystemError)
    expect(e.kind).toBe('unavailable')
    expect(e.message).toMatch(/multiple|be more specific/i)
  })
})