import { describe, expect, it } from 'vitest'
import { RealAppBackend } from './appBackend.js'
import { AppRegistry } from './appRegistry.js'
import { isNativeError } from './errors.js'
import type { NativeError } from './errors.js'
import type { ApplicationBackend } from './applications.js'

/**
 * RealAppBackend unit tests run PRE-spawn validation only: everything that
 * must be rejected before any OS process would start — unknown ids, disabled
 * apps, non-launchable targets and missing executables. They NEVER spawn.
 */
describe('RealAppBackend — pre-spawn validation (Phase 1.3)', () => {
  const registry = new AppRegistry({
    configured: {
      notepad: { target: 'C:\\Windows\\System32\\notepad.exe' },
      locked: { name: 'Locked App', target: 'C:\\Windows\\System32\\write.exe', enabled: false },
      script: { target: 'C:\\scripts\\run.cmd' },
      ghost: { target: 'C:\\No\\Such\\Place\\ghost.exe' },
    },
    discover: false,
  })
  const backend = new RealAppBackend(registry)

  it('lists wire specs only — never target paths', async () => {
    const apps = await backend.list()
    expect(apps.map((a) => a.applicationId).sort()).toEqual(['ghost', 'locked', 'notepad', 'script'])
    for (const app of apps) {
      expect(Object.keys(app).sort()).toEqual([
        'applicationId',
        'displayName',
        'enabled',
        'launchable',
        'name',
        'source',
      ])
    }
    expect(apps.find((a) => a.applicationId === 'notepad')).toMatchObject({ launchable: true })
    expect(apps.find((a) => a.applicationId === 'script')).toMatchObject({ launchable: false })
  })

  it('status(): unknown application → not_found', async () => {
    const err = await backend.status('nope').catch((e) => e)
    expect(isNativeError(err)).toBe(true)
    expect((err as NativeError).code).toBe('not_found')
    expect((err as NativeError).wirePath).toBe('nope')
  })

  it('status(): non-launchable application reports an honest unavailable observation', async () => {
    const status = await backend.status('script')
    expect(status).toMatchObject({ running: false, runningVerified: false })
  })

  it('launch(): unknown application → not_found', async () => {
    const err = await backend.launch('nope').catch((e) => e)
    expect(isNativeError(err)).toBe(true)
    expect((err as NativeError).code).toBe('not_found')
  })

  it('launch(): disabled application → permission_denied before any spawn attempt', async () => {
    const err = await backend.launch('locked').catch((e) => e)
    expect(isNativeError(err)).toBe(true)
    expect((err as NativeError).code).toBe('permission_denied')
  })

  it('launch(): non-launchable target (script / shell host) → invalid_path before any spawn attempt', async () => {
    const err = await backend.launch('script').catch((e) => e)
    expect(isNativeError(err)).toBe(true)
    expect((err as NativeError).code).toBe('invalid_path')
  })

  it('launch(): missing executable on disk → not_found without spawning', async () => {
    const err = await backend.launch('ghost').catch((e) => e)
    expect(isNativeError(err)).toBe(true)
    expect((err as NativeError).code).toBe('not_found')
  })

  it('is a production backend, never testsOnly', async () => {
    expect((backend as ApplicationBackend).testsOnly).toBeUndefined()
    expect(backend.id).toBe('real-app')
  })

  // Phase 4.1: app.close must target the REGISTRY-PROVEN process image of a
  // registered app, never an arbitrary name. resolveProcessName is the
  // registry-only source of that process name.
  it('resolveProcessName(): registered exe → basename without .exe', () => {
    expect(backend.resolveProcessName('notepad')).toBe('notepad')
  })

  it('resolveProcessName(): unknown id → empty (never a process to terminate)', () => {
    expect(backend.resolveProcessName('nope')).toBe('')
  })

  it('resolveProcessName(): non-launchable target (script) → empty', () => {
    expect(backend.resolveProcessName('script')).toBe('')
  })

  it('resolveProcessName(): launchable app stays resolvable even when disabled (close may still clean it up)', () => {
    expect(backend.resolveProcessName('locked')).toBe('write')
  })
})