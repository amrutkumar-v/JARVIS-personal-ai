import { describe, expect, it, vi } from 'vitest'
import { RealAppBackend, confirmRunning, observeRunningStable, reconcileLaunchPid, spawnProcess, type ProcessReconciler, type ReconciledProcess, type RunningProbe, type ShellRouteRunner } from './appBackend.js'
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

  /* --------------------------------------------------------- PID reconcile */

  it('TR-P0-1: a settle-confirmed observation carries its REAL reconciled pid', async () => {
    const stable: RunningProbe = async () => ({ running: true, observed: true, pid: 22080 })
    expect(await observeRunningStable(stable, 'notepad.exe', 120, 5)).toEqual({
      running: true,
      observed: true,
      pid: 22080,
    })
  })

  it('TR-P0-2: transient LAUNCHER pid is NOT the identity — real app pid wins after settle', async () => {
    let probes = 0
    const handoff: RunningProbe = async () => {
      probes += 1
      // First observation is only ever at image level (no reliable pid pinned);
      // the REAL application process settles with its own pid afterward. This
      // models classic→packaged handoff where the transient spawn pid must not
      // be reported as the application.
      return probes <= 2 ? { running: true, observed: true } : { running: true, observed: true, pid: 22080 }
    }
    const observed = await observeRunningStable(handoff, 'Notepad.exe', 120, 5)
    expect(observed).toEqual({ running: true, observed: true, pid: 22080 })
  })

  it('TR-P0-3: reconcile never fabricates — a pid that cannot be pinned stays undefined', async () => {
    const unreconcilable: RunningProbe = async () => ({ running: true, observed: true })
    const observed = await observeRunningStable(unreconcilable, 'stub.exe', 40, 5)
    // Honest: running by image, but no reliable process identity was pinned.
    expect(observed.running).toBe(true)
    expect(observed.observed).toBe(true)
    expect(observed.pid).toBeUndefined()
  })

  it('TR-P0-4: a pid observed but NOT surviving the settle window is never reported', async () => {
    let probes = 0
    const flash: RunningProbe = async () => {
      probes += 1
      return probes === 1 ? { running: true, observed: true, pid: 12345 } : { running: false, observed: true }
    }
    const observed = await observeRunningStable(flash, 'flash.exe', 5, 5)
    expect(observed.running).toBe(false)
    expect(observed.pid).toBeUndefined()
  })

  it('an unobservable process is never claimed as running or refused', async () => {
    const blind: RunningProbe = async () => ({ running: false, observed: false })
    expect(await observeRunningStable(blind, 'ghost.exe', 120, 5)).toEqual({ running: false, observed: false })
    // A positive first probe followed by an unavailable probe is unverified;
    // the first reading is not carried forward as a current-state claim.
    let first = true
    const halfBlind: RunningProbe = async () => {
      if (first) {
        first = false
        return { running: true, observed: true }
      }
      return { running: false, observed: false }
    }
    expect(await confirmRunning(halfBlind, 'half.exe', 5)).toEqual({ running: false, observed: false })
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
    const child = Object.assign(new EventEmitter(), { pid: 1234, unref: vi.fn() }) as unknown as ChildProcess
    const fakeSpawn = vi.fn((_target: string, _args: string[], _options: Record<string, unknown>) => child)
    const pending = spawnProcess('allowed-app.exe', [], 'allowed-app', { detached: true, windowsHide: true }, fakeSpawn as never)
    queueMicrotask(() => child.emit('spawn'))
    await expect(pending).resolves.toBe(child)
    expect(fakeSpawn).toHaveBeenCalledTimes(1)
    expect(fakeSpawn.mock.calls[0]?.[2]).toMatchObject({ shell: false, detached: true })
    // No exit event is ever emitted: success here proves the spawn helper
    // returns on the spawn event and does not wait for the app to exit.
  })
})

describe('RealAppBackend — executable PID snapshot ordering', () => {
  it.skipIf(process.platform !== 'win32')('captures existing image PIDs before spawning the executable', async () => {
    const events: string[] = []
    const reg = new AppRegistry({
      configured: { notepad: { target: 'C:\\Windows\\System32\\notepad.exe' } },
      discover: false,
    })
    const child = Object.assign(new EventEmitter(), { pid: 4200, unref: vi.fn() }) as unknown as ChildProcess
    const listPids = vi.fn(async () => {
      events.push('snapshot')
      return [31]
    })
    const spawnExe = vi.fn(async () => {
      events.push('spawn')
      return child
    })
    const reconcile: ProcessReconciler = async (prePids, image, _settleMs, launchedPid) => {
      events.push('reconcile')
      expect(prePids).toEqual([31])
      expect(image).toBe('notepad.exe')
      expect(launchedPid).toBe(4200)
      return { pid: 4200, handoff: false }
    }
    const backend = new RealAppBackend(reg, undefined, undefined, reconcile, listPids, spawnExe)

    const result = await backend.launch('notepad')
    expect(events).toEqual(['snapshot', 'spawn', 'reconcile'])
    expect(result).toMatchObject({ started: true, verified: true, pid: 4200 })
    expect(spawnExe).toHaveBeenCalledTimes(1)
  })
})

/* ------------------------------------ Task: launch PID reconciliation ---- */

/**
 * Simulated hand-off world for the reconciler: `listPids` returns the pids
 * currently alive for the image; `isAlive` answers per-pid liveness queries.
 * Scripted so tests can stage a launcher exiting and a replacement appearing.
 */
function makeWorld(initialPids: number[], replace: { from: number; to: number }) {
  let pids = new Set(initialPids)
  const listPids = async (): Promise<number[]> => [...pids]
  let kills = 0
  const isAlive = async (pid: number): Promise<boolean> => {
    if (!pids.has(pid)) return false
    // First liveness check after the settle sleep: perform the scripted
    // hand-off (launcher exits, replacement appears) exactly once.
    if (pid === replace.from && pids.has(replace.from) && kills === 0) {
      pids.delete(replace.from)
      pids.add(replace.to)
      kills += 1
      return false
    }
    return true
  }
  return { listPids, isAlive, current: () => [...pids] }
}

describe('reconcileLaunchPid — launch-window correlation logic', () => {
  const TR_SETTLE = 20

  it('TR-PID-1: stable direct spawn → returned pid equals the observed new pid, no hand-off', async () => {
    // New pid 4242 appears for the image and survives the settle window;
    // the launched pid IS the application pid.
    const listPids = async (): Promise<number[]> => [4242]
    const isAlive = async (pid: number): Promise<boolean> => pid === 4242
    const reconciled = await reconcileLaunchPid([], 'app.exe', listPids, isAlive, TR_SETTLE, 4242)
    expect(reconciled).toEqual({ pid: 4242, handoff: false })
  })

  it('TR-PID-2: transient launcher exits, real replacement survives → replacement pid is returned', async () => {
    // Launcher 111 is alive at first observation, then exits during hand-off;
    // the packaged application continues as pid 222 and persists.
    const world = makeWorld([111], { from: 111, to: 222 })
    const reconciled = await reconcileLaunchPid([], 'notepad.exe', world.listPids, world.isAlive, TR_SETTLE, 111)
    expect(reconciled).toEqual({
      pid: 222,
      handoff: true,
      handoffFromPid: 111,
      handoffToImage: 'notepad.exe',
      handoffToPid: 222,
    })
  })

  it('TR-PID-3: launcher disappears and no replacement can be identified → undefined (honest failure)', async () => {
    // pid 111 is observed once, then nothing is ever alive again.
    const listPids = async (): Promise<number[]> => [111]
    const isAlive = async (): Promise<boolean> => false
    const reconciled = await reconcileLaunchPid([], 'flashy.exe', listPids, isAlive, TR_SETTLE, 111)
    expect(reconciled).toBeUndefined()
  })

  it('a pid that already ran BEFORE the launch is never attributed to this launch', async () => {
    const listPids = async (): Promise<number[]> => [55]
    const isAlive = async (): Promise<boolean> => true
    const reconciled = await reconcileLaunchPid([55], 'single.exe', listPids, isAlive, TR_SETTLE)
    expect(reconciled).toBeUndefined()
  })

  it('a null pre-launch snapshot (observation unavailable) → undefined, never a guess', async () => {
    const listPids = async (): Promise<number[]> => [4242]
    const isAlive = async (): Promise<boolean> => true
    const reconciled = await reconcileLaunchPid(null, 'app.exe', listPids, isAlive, TR_SETTLE, 4242)
    expect(reconciled).toBeUndefined()
  })

  it('multiple new survivors → undefined (ambiguous attribution)', async () => {
    const listPids = async (): Promise<number[]> => [1, 2]
    const isAlive = async (): Promise<boolean> => true
    const reconciled = await reconcileLaunchPid([], 'multi.exe', listPids, isAlive, TR_SETTLE)
    expect(reconciled).toBeUndefined()
  })
})

describe('RealAppBackend — shell-route launch reports the application pid, never the helper pid', () => {
  function shellBackend(reconcileAnswer: ReconciledProcess | undefined) {
    const reg = new AppRegistry({
      configured: {
        calc: { mechanism: 'aumid', aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', processImage: 'CalculatorApp' },
        uri: { mechanism: 'uri', uri: 'ms-settings:', processImage: 'SystemSettings' },
      },
      discover: false,
    })
    const probe: RunningProbe = async () => ({ running: true, observed: true, pid: 777 })
    const runner: ShellRouteRunner = async () => {
      const { child, emitSpawnThenExit } = fakeShellExecChild(0)
      const promise = new Promise<{ child: ChildProcess; exitCode: number }>((resolve) => {
        child.once('exit', (code, _sig) => resolve({ child, exitCode: typeof code === 'number' ? code : -1 }))
      })
      emitSpawnThenExit()
      return promise
    }
    const reconcile: ProcessReconciler = async () => reconcileAnswer
    return { b: new RealAppBackend(reg, probe, runner, reconcile), reg }
  }

  it('TR-PID-4: AUMID/ShellExec launch → helper pid 99999 is NOT returned; reconciled application pid is', async () => {
    const { b } = shellBackend({ pid: 777, handoff: true, handoffFromPid: 99999 })
    const result = await b.launch('calc')
    expect(result.started).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.pid).toBe(777)
    expect(result.pid).not.toBe(99999)
    expect(result.handoff).toBe(true)
    expect(result.handoffFromPid).toBe(99999)
  })

  it('TR-PID-5: URI launch → same identity rule (helper pid never surfaces)', async () => {
    const { b } = shellBackend({ pid: 888, handoff: false })
    const result = await b.launch('uri')
    expect(result.verified).toBe(true)
    expect(result.pid).toBe(888)
    expect(result.pid).not.toBe(99999)
  })

  it('no stable new process could be reconciled → pid undefined + verified:false (honest failure, no helper pid)', async () => {
    const { b } = shellBackend(undefined)
    const calc = await b.launch('calc')
    expect(calc.verified).toBe(false)
    expect(calc.pid).toBeUndefined()
    const uri = await b.launch('uri')
    expect(uri.verified).toBe(false)
    expect(uri.pid).toBeUndefined()
  })
})
