import { describe, expect, it, vi } from 'vitest'
import type { ProbeResult } from './jsonrpc.js'
import { probeNativeAgent } from './jsonrpc.js'
import { buildNativeAgentArgs, buildNativeAgentEnv, NativeSupervisor } from './native.js'
import type { SpawnFactory, SpawnHandle } from './native.js'
import { nullLogger } from './log.js'

function fakeProbe(result: ProbeResult) {
  return vi.fn(async (): Promise<ProbeResult> => result)
}

function fakeSpawn(factory: { spawn?: () => SpawnHandle; count?: () => number } = {}) {  const spawned: SpawnHandle[] = []
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

/** Fire a child's exit callbacks. */
function crashHandle(handle: SpawnHandle): void {
  const h = handle as unknown as { _exitCbs: Array<(code: number | null, signal: string | null) => void> }
  for (const cb of h._exitCbs) cb(1, null)
}

describe('buildNativeAgentArgs', () => {
  it('requires explicit opt-in before emitting tokenless development mode', () => {
    expect(() => buildNativeAgentArgs({ port: 8765, token: '' })).toThrow(/token is required/i)
    expect(buildNativeAgentArgs({ port: 8765, token: '', allowNoToken: true })).toEqual([
      '--port',
      '8765',
      '--no-token',
      '--root',
      '{workspace}',
    ])
  })

  it('never puts the token in argv when a token is provided', () => {
    const args = buildNativeAgentArgs({ port: 9000, token: 's3cret' })
    expect(args).toEqual([
      '--port',
      '9000',
      '--root',
      '{workspace}',
    ])
    // The secret must never appear as a command-line argument.
    expect(args).not.toContain('--token')
    expect(args.join(' ')).not.toContain('s3cret')
  })

  it('passes --config only when a config file is set (agent app registration)', () => {
    const args = buildNativeAgentArgs({ port: 8765, token: '', allowNoToken: true, config: 'D:\\JARVIS\\native\\agent.config.json' })
    expect(args).toEqual([
      '--port',
      '8765',
      '--no-token',
      '--root',
      '{workspace}',
      '--config',
      'D:\\JARVIS\\native\\agent.config.json',
    ])
    expect(buildNativeAgentArgs({ port: 8765, token: '', allowNoToken: true }).join(' ')).not.toContain('--config')
  })

  it('passes --allowed-origins only when an allow-list is configured', () => {
    const args = buildNativeAgentArgs({
      port: 8765,
      token: '',
      allowNoToken: true,
      allowedOrigins: ['http://localhost:5173', 'https://jarvis.example'],
    })
    expect(args.join(' ')).toContain('--allowed-origins http://localhost:5173,https://jarvis.example')
    expect(buildNativeAgentArgs({ port: 8765, token: '', allowNoToken: true }).join(' ')).not.toContain('--allowed-origins')
  })
})

describe('buildNativeAgentEnv', () => {
  it('passes the token through JARVIS_NATIVE_TOKEN, the variable the agent already reads', () => {
    expect(buildNativeAgentEnv({ token: 's3cret' })).toEqual({ JARVIS_NATIVE_TOKEN: 's3cret' })
  })

  it('forwards nothing when running tokenless', () => {
    expect(buildNativeAgentEnv({ token: '' })).toEqual({})
  })

  it('does not forward unrelated credentials', () => {
    const env = buildNativeAgentEnv({ token: 's3cret' })
    expect(Object.keys(env)).toEqual(['JARVIS_NATIVE_TOKEN'])
    expect(env).not.toHaveProperty('GEMINI_API_KEY')
    expect(env).not.toHaveProperty('JARVIS_BACKEND_TOKEN')
    expect(env).not.toHaveProperty('JARVIS_BACKEND_NATIVE_TOKEN')
  })
})

describe('supervisor spawn credential handling', () => {
  /** Capturing spawn factory: records exactly what argv/env the child receives. */
  function capturingSpawn() {
    const calls: Array<{ script: string; args: string[]; env: Record<string, string> }> = []
    const spawn: SpawnFactory = (script, args, env) => {
      calls.push({ script, args, env })
      return {
        pid: 4242,
        onExit: () => undefined,
        onError: () => undefined,
        onLine: () => undefined,
        kill: vi.fn(),
      }
    }
    return { spawn, calls }
  }

  it('spawns with no token in argv and the token in the child environment', async () => {
    const { spawn, calls } = capturingSpawn()
    const supervisor = new NativeSupervisor({
      probeUrl: 'http://127.0.0.1:8765',
      token: 'top-secret-token',
      supervise: true,
      agentScript: 'native/dist/agentMain.js',
      agentArgs: buildNativeAgentArgs({ port: 8765, token: 'top-secret-token' }),
      probe: fakeProbe({ ok: false, connected: false, reachable: false }),
      spawn,
      log: nullLogger(),
    })
    supervisor.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    supervisor.stop()

    expect(calls.length).toBe(1)
    const call = calls[0]!
    // Requirement: no secret anywhere on the command line.
    expect(call.args).not.toContain('--token')
    expect(call.args.join(' ')).not.toContain('top-secret-token')
    // Requirement: the child receives it via the env var the agent already reads.
    expect(call.env.JARVIS_NATIVE_TOKEN).toBe('top-secret-token')
    // Requirement: no unrelated credentials are handed to the child.
    expect(Object.keys(call.env)).toEqual(['JARVIS_NATIVE_TOKEN'])
  })

  it('keeps --no-token development spawning unchanged (no token env forwarded)', async () => {
    const { spawn, calls } = capturingSpawn()
    const supervisor = new NativeSupervisor({
      probeUrl: 'http://127.0.0.1:8765',
      token: '',
      allowInsecureNoToken: true,
      supervise: true,
      agentScript: 'native/dist/agentMain.js',
      agentArgs: buildNativeAgentArgs({ port: 8765, token: '', allowNoToken: true }),
      probe: fakeProbe({ ok: false, connected: false, reachable: false }),
      spawn,
      log: nullLogger(),
    })
    supervisor.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    supervisor.stop()

    expect(calls.length).toBe(1)
    const call = calls[0]!
    expect(call.args).toContain('--no-token')
    expect(call.env.JARVIS_NATIVE_TOKEN).toBeUndefined()
  })

  it('still adopts an already-running agent instead of spawning a duplicate', async () => {
    const { spawn, calls } = capturingSpawn()
    const supervisor = new NativeSupervisor({
      probeUrl: 'http://127.0.0.1:8765',
      token: 'top-secret-token',
      supervise: true,
      agentScript: 'native/dist/agentMain.js',
      agentArgs: buildNativeAgentArgs({ port: 8765, token: 'top-secret-token' }),
      probe: fakeProbe({ ok: true, connected: true, reachable: true, protocol: 'jarvis-native-1', version: '2.9.1', tokenRequired: true }),
      spawn,
      log: nullLogger(),
    })
    supervisor.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    supervisor.stop()

    expect(calls.length).toBe(0)
    expect(supervisor.status().connected).toBe(true)
    expect(supervisor.status().childRunning).toBe(false)
  })
})

describe('probeNativeAgent', () => {
  it('reports connected when identity succeeds', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocol: 'jarvis-native-1', version: '2.8.0', platform: 'win32', connected: true, tokenRequired: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    const result = await probeNativeAgent('http://127.0.0.1:8765', '', { fetchImpl })
    expect(result.ok).toBe(true)
    expect(result.connected).toBe(true)
    expect(result.version).toBe('2.8.0')
    expect(result.tokenRequired).toBe(true)
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
    const probe = fakeProbe({ ok: true, connected: true, reachable: true, protocol: 'jarvis-native-1', version: '2.8.0', tokenRequired: true })
    const supervisor = new NativeSupervisor({
      probeUrl: 'http://127.0.0.1:8765',
      token: 'test-token',
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

  it('starts the native agent child when supervision is on and the port is dead', async () => {
    const probe = fakeProbe({ ok: false, connected: false, reachable: false })
    const spawned = fakeSpawn()
    const supervisor = new NativeSupervisor({
      probeUrl: 'http://127.0.0.1:8765',
      token: 'test-token',
      supervise: true,
      agentScript: 'agentMain.js',
      agentArgs: ['--port', '8765'],
      probe,
      spawn: spawned.spawn,
      log: nullLogger(),
    })
    supervisor.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(spawned.all().length).toBe(1)
    expect(supervisor.status().childRunning).toBe(true)
    expect(supervisor.status().adopted).toBe(false)
    supervisor.stop()
  })

  it('adopts an agent already running on the port instead of spawning a duplicate', async () => {
    const probe = fakeProbe({ ok: true, connected: true, reachable: true, protocol: 'jarvis-native-1', version: '2.8.0', tokenRequired: true })
    const spawned = fakeSpawn()
    const supervisor = new NativeSupervisor({
      probeUrl: 'http://127.0.0.1:8765',
      token: 'test-token',
      supervise: true,
      agentScript: 'agentMain.js',
      agentArgs: ['--port', '8765'],
      probe,
      spawn: spawned.spawn,
      log: nullLogger(),
    })
    supervisor.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(spawned.all().length).toBe(0)
    expect(supervisor.status().adopted).toBe(true)
    expect(supervisor.status().connected).toBe(true)
    expect(supervisor.status().childRunning).toBe(false)
    supervisor.stop()
  })

  it('never spawns a second agent while a restart is already pending', async () => {
    const tick = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const probe = fakeProbe({ ok: false, connected: false, reachable: false })
    const spawned = fakeSpawn()
    const supervisor = new NativeSupervisor({
      probeUrl: 'http://127.0.0.1:8765',
      token: 'test-token',
      supervise: true,
      agentScript: 'agentMain.js',
      agentArgs: ['--port', '8765'],
      probe,
      spawn: spawned.spawn,
      // A long backoff keeps the restart pending, so a SECOND crash arrives
      // while a restart is already queued.
      restartBackoff: () => 60_000,
      log: nullLogger(),
    })
    supervisor.start()
    await tick(10)
    expect(spawned.all().length).toBe(1)

    const crash = (handle: SpawnHandle): void => {
      const h = handle as unknown as { _exitCbs: Array<(code: number | null, signal: string | null) => void> }
      for (const cb of h._exitCbs) cb(1, null)
    }
    crash(spawned.all()[0]!)
    await tick()
    // A second exit event for the same child must not queue a second restart.
    crash(spawned.all()[0]!)
    await tick()

    // Exactly ONE restart is pending, and no second agent exists.
    expect(supervisor.status().restarts).toBe(1)
    expect(spawned.all().length).toBe(1)
    supervisor.stop()
  })

  it('kills EVERY child it spawned, so no orphan keeps holding the port', async () => {
    const tick = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const probe = fakeProbe({ ok: false, connected: false, reachable: false })
    const spawned = fakeSpawn()
    const supervisor = new NativeSupervisor({
      probeUrl: 'http://127.0.0.1:8765',
      token: 'test-token',
      supervise: true,
      agentScript: 'agentMain.js',
      agentArgs: ['--port', '8765'],
      probe,
      spawn: spawned.spawn,
      restartBackoff: () => 0,
      log: nullLogger(),
    })
    supervisor.start()
    await tick(10)
    const first = spawned.all()[0]!
    crashHandle(first)
    await tick(20)
    expect(spawned.all().length).toBeGreaterThan(1)

    supervisor.stop()
    for (const handle of spawned.all()) {
      expect((handle as unknown as { kill: { mock: { calls: unknown[] } } }).kill.mock.calls.length).toBeGreaterThan(0)
    }
  })

  it('restarts a crashed child with bounded backoff; stops retrying past the limit', async () => {
    const tick = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const probe = fakeProbe({ ok: false, connected: false, reachable: false })
    const spawned = fakeSpawn()
    const supervisor = new NativeSupervisor({
      probeUrl: 'http://127.0.0.1:8765',
      token: 'test-token',
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
    await tick()
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
