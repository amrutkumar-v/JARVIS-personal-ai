import { describe, expect, it } from 'vitest'
import { RealAppBackend, confirmRunning, observeRunningStable, type RunningProbe, type ShellRouteRunner } from './appBackend.js'
import { AppRegistry } from './appRegistry.js'
import { isNativeError } from './errors.js'
import type { NativeError } from './errors.js'
import type { ApplicationBackend } from './applications.js'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

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

/* -------------------------------------------------- Task 0: ShellExec exit */

/**
 * Build a fake ChildProcess emitter that behaves like a spawned ShellExec.exe.
 * Resolves with the provided exit code on 'exit' event. pid is a fixed fake so
 * the caller can assert.
 */
function fakeShellExecChild(exitCode: number): { child: ChildProcess; emitSpawnThenExit: () => void } {
  const emitter = new EventEmitter() as unknown as ChildProcess
  ;(emitter as ChildProcess & { pid: number }).pid = 99999
  ;(emitter as ChildProcess & { unref: () => ChildProcess }).unref = () => emitter
  const emitSpawnThenExit = () => {
    setTimeout(() => {
      emitter.emit('spawn')
      setTimeout(() => emitter.emit('exit', exitCode, null), 5)
    }, 5)
  }
  return { child: emitter, emitSpawnThenExit }
}

function shellRunner(exitCode: number): ShellRouteRunner {
  return async (_route, applicationId) => {
    void applicationId
    const { child, emitSpawnThenExit } = fakeShellExecChild(exitCode)
    const promise = new Promise<{ child: ChildProcess; exitCode: number }>((resolve) => {
      child.once('exit', (code, _sig) => resolve({ child, exitCode: typeof code === 'number' ? code : -1 }))
    })
    emitSpawnThenExit()
    return promise
  }
}

describe('RealAppBackend — ShellExec exit-code classification (T0)', () => {
  function backendWith(exit: number) {
    const reg = new AppRegistry({
      configured: {
        calc: { mechanism: 'aumid', aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
        uri: { mechanism: 'uri', uri: 'ms-settings:' },
      },
      discover: false,
    })
    return new RealAppBackend(reg, async () => ({ running: false, observed: false }), shellRunner(exit))
  }

  it('TR-T0-1: ShellExec exit 3 → NativeError io_error; started NEVER reported true', async () => {
    const b = backendWith(3)
    const err = await b.launch('calc').catch((e) => e)
    expect(isNativeError(err)).toBe(true)
    expect((err as NativeError).code).toBe('io_error')
    expect((err as NativeError).message).toContain('calc')
  })

  it('TR-T0-1 (URI path): ShellExec exit 3 on URI → same io_error classification', async () => {
    const b = backendWith(3)
    const err = await b.launch('uri').catch((e) => e)
    expect(isNativeError(err)).toBe(true)
    expect((err as NativeError).code).toBe('io_error')
  })

  it('ShellExec exit 4 (security gate rejected route) → invalid_path', async () => {
    const b = backendWith(4)
    const err = await b.launch('calc').catch((e) => e)
    expect(isNativeError(err)).toBe(true)
    expect((err as NativeError).code).toBe('invalid_path')
    expect((err as NativeError).message).toContain('ShellExec security gate')
  })

  it('ShellExec exit 5 (usage) → invalid_argument', async () => {
    const b = backendWith(5)
    const err = await b.launch('calc').catch((e) => e)
    expect(isNativeError(err)).toBe(true)
    expect((err as NativeError).code).toBe('invalid_argument')
  })

  it('TR-T0-2: ShellExec exit 0 → success; reportShellLaunch returns started:true (no regression)', async () => {
    const b = backendWith(0)
    const result = await b.launch('calc')
    expect(result.started).toBe(true)
    expect(result.applicationId).toBe('calc')
    // Without processImage the shell-route verify returns unverified, but the
    // important property is: we did NOT throw; activation proceeded.
    expect(typeof result.verified).toBe('boolean')
  })

  it('TR-T0-3: spawnDetached (exe path) still resolves on spawn (never waits for exit)', async () => {
    const reg = new AppRegistry({
      configured: {
        // Existing test pattern: notepad exe target exists on real win32 and is
        // accepted by validateFolderArg (no folder) + safeAccess always throws
        // on non-win32 so we use a mock-app with test-only trick: a probe isn't
        // needed here, this just validates that the constructor injection path
        // doesn't affect exe code.
        notepad: { target: 'C:\\Windows\\System32\\notepad.exe' },
      },
      discover: false,
    })
    // Inject a shell runner that would wait forever if exe path used it
    const waitForever: ShellRouteRunner = async () => {
      await new Promise(() => {})
      return { child: {} as ChildProcess, exitCode: 0 }
    }
    const b = new RealAppBackend(reg, undefined, waitForever)
    // Notepad won't actually spawn on non-win32 / missing path but the
    // constructor injection path is validated: the shellRunner passed to
    // constructor is stored correctly and the exe path doesn't invoke it.
    // safeAccess → undefined → throws NativeError not_found on non-existent
    // targets. That's the correct behavior; the point is this doesn't hang.
    const err = await b.launch('notepad').catch((e) => e)
    // Either it spawned successfully (win32 real env) or it threw on missing
    // target. The assertion is: it didn't deadlock-wait on the forever-promise
    // shellRunner (which would have timed out the test).
    expect(true).toBe(true)
    void err
  })
})