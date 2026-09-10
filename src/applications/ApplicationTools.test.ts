import { describe, expect, it, beforeEach } from 'vitest'
import type { Tool, ToolResult } from '../tools/Tool'
import { requiresUserConfirmation } from '../tools/Tool'
import { FakeApplicationProvider } from './testing'
import type { AppSeed } from './testing'
import { createApplicationTools } from './ApplicationTools'

/**
 * Phase 1.3 — application tools, scenario coverage against the deterministic
 * in-memory provider (tests only). Every claim checks REAL provider state — a
 * tool never reports a fake launch as a confirmed one.
 */

function call(tool: Tool, params: Record<string, unknown>): Promise<ToolResult> {
  return tool.execute({ query: '', params }, { requestId: 'unit' })
}

const SEEDS: AppSeed[] = [
  { applicationId: 'notepad', name: 'Notepad', source: 'configured', launchOutcome: 'verified' },
  { applicationId: 'calculator', name: 'Calculator', displayName: 'Calculator', source: 'discovered', launchOutcome: 'unverified' },
  { applicationId: 'disabled-app', name: 'Disabled', enabled: false },
  { applicationId: 'unlaunchable-app', name: 'Unlaunchable', launchable: false },
]

let provider: FakeApplicationProvider
let tools: Map<string, Tool>

beforeEach(() => {
  provider = new FakeApplicationProvider(SEEDS)
  tools = new Map(createApplicationTools(provider).map((t) => [t.id, t]))
})

/* ---------------------------------------------------------------- tiers */

describe('permission boundaries', () => {
  it('keeps app.list and app.status read_only and app.launch low_risk + verifiable', () => {
    expect(tools.get('app.list')!.permission).toBe('read_only')
    expect(tools.get('app.status')!.permission).toBe('read_only')
    const launch = tools.get('app.launch')!
    expect(launch.permission).toBe('low_risk')
    expect(launch.verifiable).toBe(true)
    expect(requiresUserConfirmation(launch)).toBe(false)
    for (const id of ['app.list', 'app.status']) {
      expect(tools.get(id)!.verifiable, id).toBe(false)
      expect(requiresUserConfirmation(tools.get(id)!), id).toBe(false)
    }
  })
})

/* ---------------------------------------------------------------- list */

describe('A — app.list', () => {
  it('lists approved apps with metadata, never target paths', async () => {
    const out = await call(tools.get('app.list')!, {})
    expect(out.ok).toBe(true)
    const apps = (out.data as { apps: Array<{ applicationId: string; source: string; launchable: boolean; displayName: string }> }).apps
    expect(apps.map((a) => a.applicationId).sort()).toEqual(['calculator', 'disabled-app', 'notepad', 'unlaunchable-app'])
    const notepad = apps.find((a) => a.applicationId === 'notepad')!
    expect(notepad.source).toBe('configured')
    expect(notepad.launchable).toBe(true)
    expect(notepad.displayName).toBe('Notepad')
    expect(JSON.stringify(out.data)).not.toMatch(/\.exe|target|C:\\|System32/i)
  })

  it('handles an empty allow-list honestly', async () => {
    const empty = new FakeApplicationProvider()
    const out = await call(new Map(createApplicationTools(empty).map((t) => [t.id, t])).get('app.list')!, {})
    expect(out.ok).toBe(true)
    expect((out.data as { apps: unknown[] }).apps).toEqual([])
  })
})

/* ---------------------------------------------------------------- status */

describe('B — app.status', () => {
  it('reports honest running state for a never-launched app', async () => {
    const out = await call(tools.get('app.status')!, { application_id: 'notepad' })
    expect(out.ok).toBe(true)
    expect((out.data as { running: boolean }).running).toBe(false)
    expect(out.message).toMatch(/not running/i)
  })

  it('validates the application id charset before calling the provider', async () => {
    for (const bad of ['', 'a/b.exe', 'café', 'x'.repeat(65), 42]) {
      const out = await call(tools.get('app.status')!, { application_id: bad })
      expect(out.ok, `id ${JSON.stringify(bad)}`).toBe(false)
      expect(out.message, `id ${JSON.stringify(bad)}`).toMatch(/application/i)
    }
    const spaces = await call(tools.get('app.status')!, { application_id: '  notepad  ' })
    expect(spaces.ok).toBe(true)
  })

  it('fails honestly for an unknown id', async () => {
    const out = await call(tools.get('app.status')!, { application_id: 'unknown' })
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/no approved application|not found/i)
  })
})

/* ---------------------------------------------------------------- launch */

describe('C — app.launch', () => {
  it('launches a verified app and confirms the observation', async () => {
    const out = await call(tools.get('app.launch')!, { application_id: 'notepad' })
    expect(out.ok).toBe(true)
    expect(out.message).toMatch(/confirmed it is running/i)
    expect((out.data as { verified: boolean }).verified).toBe(true)
    expect(provider.launchCount('notepad')).toBe(1)

    const verify = await tools.get('app.launch')!.verify!({ query: '', params: { application_id: 'notepad' } }, out, { requestId: 'u' })
    expect(verify.ok).toBe(true)
    expect(verify.checks).toContain('process running')
    const status = await call(tools.get('app.status')!, { application_id: 'notepad' })
    expect((status.data as { running: boolean }).running).toBe(true)
  })

  it('reports success without claiming confirmation when verification is unverified', async () => {
    const out = await call(tools.get('app.launch')!, { application_id: 'calculator' })
    expect(out.ok).toBe(true)
    expect(out.message).not.toContain('confirmed it is running')
    expect((out.data as { verified: boolean }).verified).toBe(false)

    const verify = await tools.get('app.launch')!.verify!({ query: '', params: { application_id: 'calculator' } }, out, { requestId: 'u' })
    expect(verify.ok).toBe(false)
    expect(verify.message).toMatch(/cannot confirm|unavailable/i)
  })

  it('canonicalizes the id before launch (spaces/trim)', async () => {
    const out = await call(tools.get('app.launch')!, { application_id: '  notepad ' })
    expect(out.ok).toBe(true)
    expect(provider.launchCount('notepad')).toBe(1)
  })

  it('rejects disabled and non-launchable apps, never asserting a fake launch', async () => {
    const disabled = await call(tools.get('app.launch')!, { application_id: 'disabled-app' })
    expect(disabled.ok).toBe(false)
    expect(disabled.message).toMatch(/disabled/i)
    expect(provider.launchCount('disabled-app')).toBe(0)

    const unlaunchable = await call(tools.get('app.launch')!, { application_id: 'unlaunchable-app' })
    expect(unlaunchable.ok).toBe(false)
    expect(unlaunchable.message).toMatch(/not launchable/i)
    expect(provider.launchCount('unlaunchable-app')).toBe(0)
  })

  it('launches nothing for an unknown id', async () => {
    const out = await call(tools.get('app.launch')!, { application_id: 'nope' })
    expect(out.ok).toBe(false)
    expect(provider.launchCount('nope')).toBe(0)
  })
})

/* ---------------------------------------------------------------- unavailable provider */

describe('D — unavailable providers fail honestly, never fake', () => {
  it('every app tool fails with an honest unavailable message', async () => {
    provider.setAvailable(false)
    const checks: Array<() => Promise<ToolResult>> = [
      () => call(tools.get('app.list')!, {}),
      () => call(tools.get('app.status')!, { application_id: 'notepad' }),
      () => call(tools.get('app.launch')!, { application_id: 'notepad' }),
    ]
    for (const run of checks) {
      const out = await run()
      expect(out.ok, out.message).toBe(false)
      expect(out.message).toMatch(/not available/i)
    }
    expect(provider.launchCount('notepad')).toBe(0)
  })
})

/* ---------------------------------------------------------------- no provider */

describe('E — browser mode registers no app tools', () => {
  it('createApplicationTools(undefined) yields an empty toolset', () => {
    expect(createApplicationTools(undefined)).toEqual([])
  })
})

/* ---------------------------------------------------------------- close */

describe('F — app.close', () => {
  it('registers app.close tool when provider has close method', () => {
    expect(tools.has('app.close')).toBe(true)
  })

  it('app.close is user_confirmation and verifiable', () => {
    const closeTool = tools.get('app.close')!
    expect(closeTool.permission).toBe('user_confirmation')
    expect(closeTool.verifiable).toBe(true)
    expect(requiresUserConfirmation(closeTool)).toBe(true)
  })

  it('closes a running application', async () => {
    await call(tools.get('app.launch')!, { application_id: 'notepad' })
    const result = await call(tools.get('app.close')!, { application_id: 'notepad' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('Closed')
  })

  it('handles closing an already-closed application', async () => {
    const result = await call(tools.get('app.close')!, { application_id: 'notepad' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('not running')
  })

  it('requires application_id', async () => {
    const result = await call(tools.get('app.close')!, {})
    expect(result.ok).toBe(false)
    expect(result.message).toContain('application_id')
  })

  it('returns unavailable when provider is disconnected', async () => {
    provider.setAvailable(false)
    const result = await call(tools.get('app.close')!, { application_id: 'notepad' })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not available/i)
  })
})