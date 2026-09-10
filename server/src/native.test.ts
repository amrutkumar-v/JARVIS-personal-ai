import { describe, expect, it, vi } from 'vitest'
import type { ProbeResult } from './jsonrpc.js'
import { probeNativeAgent } from './jsonrpc.js'
import { NativeSupervisor } from './native.js'
import type { SpawnFactory, SpawnHandle } from './native.js'
import { nullLogger } from './log.js'

function fakeProbe(result: ProbeResult) {
  return vi.fn(async (): Promise<ProbeResult> => result)
}

function fakeSpawn(factory: { spawn?: () => SpawnHandle; count?: () => number } = {}) {
  const spawned: SpawnHandle[] = []
  const current = () => spawned[spawned.length - 1]!
  const spawn: SpawnFactory = () => {
    const exitCbs: Array<(code: number | null, signal: string | null) => void> = []
    const errorCbs: Array<(error: Error) => void> = []
    const lineCbs: Array<(stream: 'stdout' | 'stderr', line: string) => void> = []
    const handle: SpawnHandle = {
      pid: 5000 + spawned.length,
      onExit: (cb) => exitCbs.push(cb),
      onError: (cb) => errorCbs.push(cb),
      onLine: (cb) => lineCbs.push(cb),
      kill: vi.fn(),
    }
    const augmented = { ...handle, _exitCbs: exitCbs, _errorCbs: errorCbs } as unknown as SpawnHandle
    spawned.push(augmented)
    factory.spawn?.()
    return augmented
  }
  return { spawn, current, all: () => spawned }
}

describe('probeNativeAgent', () => {
  it('reports connected when identity succeeds', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocol: 'jarvis-native-1', version: '2.8.0', platform: 'win32', connected: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    const result = await probeNativeAgent('http://127.0.0.1:8765', '', { fetchImpl })
    expect(result.ok).toBe(true)
    expect(result.connected).toBe(true)
    expect(result.version).toBe('2.8.0')
  })

  it('reports unreachable when fetch throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('fetch failed')
    }) as typeof fetch
    const result = await probeNativeAgent('http://127.0.0.1:8765', '', { fetchImpl })
    expect(result.reachable).toBe(false)
    expect(result.connected).toBe(false)
  })

  it('reports reachable-but-failed on 401', async () => {
    const fetchImpl = (async () => new Response('Unauthorized', { status: 401 })) as typeof fetch
    const result = await probeNativeAgent('http://127.0.0.1:8765', '', { fetchImpl })
    expect(result.reachable).toBe(true)
    expect(result.connected).toBe(false)
  })
})

describe('NativeSupervisor', () => {
  it('probe-only mode (no supervision) reports honest connection state', async () => {
    const probe = fakeProbe({ ok: true, connected: true, reachable: true, protocol: 'jarvis-native-1', version: '2.8.0' })
    const supervisor = new NativeSupervisor({
      probeUrl: 'http://127.0.0.1:8765',
      supervise: false,
      agentScript: 'nope.js',
      agentArgs: [],
      probe,
      spawn: vi.fn(),
      log: nullLogger(),
    })
    supervisor.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    supervisor.stop()
    expect(probe).toHaveBeenCalled()
    expect(supervisor.status().connected).toBe(true)
    expect(supervisor.status().childRunning).toBe(false)
  })

  it('starts the native agent child when supervision is on', async () => {
    const probe = fakeProbe({ ok: false, connected: false, reachable: false })
    const spawned = fakeSpawn()
    const supervisor = new NativeSupervisor({
      probeUrl: 'http://127.0.0.1:8765',
      supervise: true,
      agentScript: 'agentMain.js',
      agentArgs: ['--port', '8765'],
      probe,
      spawn: spawned.spawn,
      log: nullLogger(),
    })
    supervisor.start()
    expect(spawned.all().length).toBe(1)
    expect(supervisor.status().childRunning).toBe(true)
    supervisor.stop()
  })

  it('restarts a crashed child with bounded backoff; stops retrying past the limit', async () => {
    const tick = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const probe = fakeProbe({ ok: true, connected: true, reachable: true })
    const spawned = fakeSpawn()
    const supervisor = new NativeSupervisor({
      probeUrl: 'http://127.0.0.1:8765',
      supervise: true,
      agentScript: 'agentMain.js',
      agentArgs: [],
      probe,
      spawn: spawned.spawn,
      restartBackoff: () => 0,
      childRestartLimit: 2,
      childRestartWindowMs: 60_000,
      log: nullLogger(),
    })
    supervisor.start()
    expect(spawned.all().length).toBe(1)

    // Simulate child crashes: exit → supervisor respawns, up to the limit.
    const crash = (handle: SpawnHandle): void => {
      const h = handle as unknown as { _exitCbs: Array<(code: number | null, signal: string | null) => void> }
      for (const cb of h._exitCbs) cb(1, null)
    }

    crash(spawned.all()[0]!)
    await tick()
    crash(spawned.all()[1]!)
    await tick()
    crash(spawned.all()[2]!)
    await tick()
    supervisor.stop()

    // Crash 1 → restart (h2). Crash 2 → restart (h3). Crash 3 trips the limit.
    expect(spawned.all().length).toBe(3)
    expect(supervisor.status().restarts).toBe(2)
    const restartTimerActive = (supervisor as unknown as { restartTimer: ReturnType<typeof setTimeout> | null }).restartTimer
    expect(restartTimerActive).toBeNull()
  })
})