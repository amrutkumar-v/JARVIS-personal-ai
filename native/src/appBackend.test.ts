import { describe, expect, it } from 'vitest'
import { RealAppBackend, confirmRunning, observeRunningStable, type RunningProbe } from './appBackend.js'
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
        'launchMechanism',
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

  it('launch(): rejects a folder argument for an app that does not allow it', async () => {
    const err = await backend.launch('notepad', { folder: 'C:\\Somewhere' }).catch((e) => e)
    expect(isNativeError(err)).toBe(true)
    expect((err as NativeError).code).toBe('invalid_path')
  })

  it('launch(): rejects relative / non-directory folder arguments even for File Explorer', async () => {
    const reg = new AppRegistry({
      configured: { explorer: { target: 'C:\\Windows\\explorer.exe', allowFolder: true } },
      discover: false,
    })
    const b = new RealAppBackend(reg)
    const relative = await b.launch('explorer', { folder: 'relative\\path' }).catch((e) => e)
    expect(isNativeError(relative)).toBe(true)
    expect((relative as NativeError).code).toBe('invalid_path')
    const notDir = await b.launch('explorer', { folder: 'C:\\No\\Such\\Dir' }).catch((e) => e)
    expect(isNativeError(notDir)).toBe(true)
    expect((notDir as NativeError).code).toBe('not_found')
  })

  it('status(): shell-route apps without a process image report an unavailable observation', async () => {
    const reg = new AppRegistry({
      configured: {
        'calc-store': { mechanism: 'aumid', aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
        settings: { mechanism: 'uri', uri: 'ms-settings:' },
      },
      discover: false,
    })
    const b = new RealAppBackend(reg)
    const calc = await b.status('calc-store')
    expect(calc).toMatchObject({ running: false, runningVerified: false, launchMechanism: 'aumid' })
    const settings = await b.status('settings')
    expect(settings).toMatchObject({ running: false, runningVerified: false, launchMechanism: 'uri' })
  })

  // A process that STARTS and EXITS immediately (a broken Store package, a
  // one-shot launcher stub) must never be reported as a running application.
  // This is the regression guard for a real false "verified" launch.
  it('a flashing process is NOT reported as running (positive must survive the settle window)', async () => {
    let probes = 0
    const flash: RunningProbe = async () => {
      probes += 1
      return { running: probes === 1, observed: true }
    }
    const settled = await confirmRunning(flash, 'CalculatorApp.exe', 5)
    expect(settled.running).toBe(false)
    expect(settled.observed).toBe(true)

    const window = await observeRunningStable(flash, 'CalculatorApp.exe', 120, 5)
    expect(window.running).toBe(false)
    expect(window.observed).toBe(true)
  })

  it('a process that stays up IS reported as running', async () => {
    const stable: RunningProbe = async () => ({ running: true, observed: true })
    expect(await confirmRunning(stable, 'notepad.exe', 5)).toEqual({ running: true, observed: true })
    expect(await observeRunningStable(stable, 'notepad.exe', 120, 5)).toEqual({ running: true, observed: true })
  })

  it('an unobservable process is never claimed as running or refused', async () => {
    const blind: RunningProbe = async () => ({ running: false, observed: false })
    expect(await observeRunningStable(blind, 'ghost.exe', 120, 5)).toEqual({ running: false, observed: false })
    // A positive first probe that cannot be re-confirmed keeps the honest
    // "observed" answer instead of inventing a failure.
    let first = true
    const halfBlind: RunningProbe = async () => {
      if (first) {
        first = false
        return { running: true, observed: true }
      }
      return { running: false, observed: false }
    }
    expect(await confirmRunning(halfBlind, 'half.exe', 5)).toEqual({ running: true, observed: true })
  })

  it('status(): a Store app is reported running only from a probe that really says so', async () => {
    const reg = new AppRegistry({
      configured: {
        calculator: {
          name: 'Calculator',
          mechanism: 'aumid',
          aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
          processImage: 'CalculatorApp',
        },
      },
      discover: false,
    })
    const running = new RealAppBackend(reg, async () => ({ running: true, observed: true }))
    expect(await running.status('calculator')).toMatchObject({ running: true, runningVerified: true })

    const stopped = new RealAppBackend(reg, async () => ({ running: false, observed: true }))
    expect(await stopped.status('calculator')).toMatchObject({ running: false, runningVerified: true })

    const unknown = new RealAppBackend(reg, async () => ({ running: false, observed: false }))
    expect(await unknown.status('calculator')).toMatchObject({ running: false, runningVerified: false })
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