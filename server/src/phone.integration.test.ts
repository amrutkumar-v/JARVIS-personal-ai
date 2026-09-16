import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceRegistry } from './registry.js'
import { EventBus } from './events.js'
import { FileStore } from './files.js'
import { buildHealth } from './health.js'
import { startHttpServer, type RuntimeContext, type RunningHttp } from './http.js'
import { startPhoneServer, type RunningPhoneServer } from './phoneServer.js'
import { PhoneTrust } from './phoneTrust.js'
import { PhoneCommandQueue } from './phoneCommands.js'
import { BACKEND_NAME, BACKEND_PROTOCOL, BACKEND_VERSION } from './version.js'

async function jsonPost(port: number, path: string, body: unknown, token = ''): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as any }
}

async function jsonGet(port: number, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: res.status, body: (await res.json()) as any }
}

describe('JARVIS core + phone listener end-to-end', () => {
  let dir: string
  let nowValue: number
  let registry: DeviceRegistry
  let bus: EventBus
  let files: FileStore
  let pairing: PhoneTrust
  let commands: PhoneCommandQueue
  let dataDir: string
  let main: RunningHttp
  let phone: RunningPhoneServer

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jarvis-phone-int-'))
    dataDir = join(dir, 'data')
    nowValue = 1_000_000
    registry = new DeviceRegistry({ now: () => nowValue })
    bus = new EventBus()
    files = new FileStore({ dir: join(dir, 'files'), now: () => nowValue, generateId: () => 'f-1' })
    pairing = new PhoneTrust({ now: () => nowValue })
    commands = new PhoneCommandQueue({ now: () => nowValue })

    const assistant: Record<string, unknown> = {}
    const wake = { browserOnly: true as const }
    const context: RuntimeContext = {
      name: BACKEND_NAME,
      version: BACKEND_VERSION,
      protocol: BACKEND_PROTOCOL,
      pid: 4321,
      startedAt: nowValue - 500,
      dataDir,
      lockFile: join(dataDir, 'backend.pid'),
      logFile: join(dataDir, 'logs', 'test.log'),
      registry,
      bus,
      files,
      nativeStatus: () => ({ supervising: true, connected: true, reachable: true, childRunning: true, childPid: 777, protocol: 'jarvis-native-1', version: '2.8.0', restarts: 0, lastProbeAt: nowValue }),
      assistant,
      wake,
      now: () => nowValue,
      pairing,
      deviceCommands: commands,
      health: () =>
        buildHealth({
          name: BACKEND_NAME,
          version: BACKEND_VERSION,
          protocol: BACKEND_PROTOCOL,
          pid: 4321,
          startedAt: nowValue - 500,
          now: nowValue,
          native: { supervising: true, connected: true, reachable: true, childRunning: true, childPid: 777, protocol: 'jarvis-native-1', version: '2.8.0', restarts: 0, lastProbeAt: nowValue },
          registry,
          assistant,
          wake,
          filesCount: files.count(),
          dataDir,
          lockFile: join(dataDir, 'backend.pid'),
          logFile: join(dataDir, 'logs', 'test.log'),
        }),
    }
    main = await startHttpServer({ host: '127.0.0.1', port: 0, context, staticDir: undefined, publicDir: join(dir, 'public') })
    phone = await startPhoneServer({ host: '127.0.0.1', port: 0, registry, pairing, commands, now: () => nowValue })
  })

  afterEach(async () => {
    await phone.close()
    await main.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('pairs over the phone listener, heartbeats online, queues + verifies a ping', async () => {
    // 1. laptop starts a pairing session (loopback core endpoint)
    const began = await jsonPost(main.port, '/api/device/pair/begin', { device: 's26-ultra' })
    expect(began.status).toBe(200)
    expect(began.body.ok).toBe(true)
    expect(began.body.device).toBe('s26-ultra')
    expect(began.body.code).toMatch(/^\d{6}$/)

    // 2. phone exchanges the code for a per-device token over the LAN listener
    const pair = await jsonPost(phone.port, '/phone/pair', { device: 's26-ultra', code: began.body.code })
    expect(pair.status).toBe(200)
    const token: string = pair.body.token
    expect(token).toHaveLength(64)

    // 3. phone heartbeats with its declared capabilities and telemetry
    const hb = await jsonPost(phone.port, '/phone/heartbeat', {
      id: 's26-ultra',
      meta: {
        battery: 82,
        charging: true,
        network: 'wifi',
        version: '1.0.0',
        capabilities: ['status', 'battery', 'network', 'ping', 'heartbeat', 'connection'],
      },
    }, token)
    expect(hb.status).toBe(200)

    // 4. the main backend now reports the phone ONLINE with real telemetry
    const listed = await jsonGet(main.port, '/api/device/list')
    const s26 = (listed.body as { devices: any[] }).devices.find((d) => d.id === 's26-ultra')
    expect(s26.online).toBe(true)
    expect(s26.battery).toBe(82)
    expect(s26.charging).toBe(true)
    expect(s26.network).toBe('wifi')

    // 5. laptop queues a verifiable ping (device considered online)
    const ping = await jsonPost(main.port, '/api/device/ping', { device: 's26-ultra' })
    expect(ping.status).toBe(200)
    expect(ping.body.delivered).toBe(true)
    expect(ping.body.status).toBe('queued')
    const requestId: string = ping.body.requestId

    // 6. the phone drains the ping and acknowledges with a concrete result
    const poll = await jsonPost(phone.port, '/phone/poll', { id: 's26-ultra' }, token)
    expect((poll.body.commands as any[]).length).toBeGreaterThan(0)
    const pingCommand = (poll.body.commands as any[]).find((c) => c.kind === 'ping')!
    const ack = await jsonPost(phone.port, '/phone/ack', { id: 's26-ultra', commandId: pingCommand.commandId, ok: true, detail: 'pong 9ms' }, token)
    expect(ack.body).toMatchObject({ ok: true, acknowledged: true })

    // 7. the laptop can read the verified result
    const result = await jsonPost(main.port, '/api/device/ping/result', { device: 's26-ultra', requestId })
    expect(result.status).toBe(200)
    expect(result.body.acknowledged).toBe(true)
    expect(result.body.result).toBe(true)
    expect(result.body.detail).toBe('pong 9ms')
    expect(result.body.pending).toBe(false)
  })

  it('detects offline phones and reconnects them via a fresh heartbeat', async () => {
    pairing.begin('s23-fe')
    const code = pairing['sessions'].get('s23-fe')!.code
    const pair = await jsonPost(phone.port, '/phone/pair', { device: 's23-fe', code })
    const token: string = pair.body.token
    await jsonPost(phone.port, '/phone/heartbeat', { id: 's23-fe', meta: { battery: 12 } }, token)
    expect(registry.get('s23-fe')?.online).toBe(true)

    // no heartbeat for more than the 40s TTL → honestly offline
    nowValue += 41_000
    const listed = await jsonGet(main.port, '/api/device/list')
    const s23 = (listed.body as { devices: any[] }).devices.find((d) => d.id === 's23-fe')
    expect(s23.online).toBe(false)

    // reconnect: the phone heartbeats again
    await jsonPost(phone.port, '/phone/heartbeat', { id: 's23-fe', meta: { battery: 12, charging: true } }, token)
    expect(registry.get('s23-fe')?.online).toBe(true)
    expect(registry.get('s23-fe')?.charging).toBe(true)
  })

  it('queues a ping for an offline phone and honestly reports it as offline + no result yet', async () => {
    const ping = await jsonPost(main.port, '/api/device/ping', { device: 's23-fe' })
    expect(ping.status).toBe(200)
    expect(ping.body.delivered).toBe(false)
    expect(ping.body.status).toBe('offline')

    const result = await jsonPost(main.port, '/api/device/ping/result', { device: 's23-fe', requestId: ping.body.requestId })
    expect(result.body.pending).toBe(true)
    expect(result.body.acknowledged).toBe(false)
    expect(result.body.result).toBeNull()
  })

  it('only allows trusted Android devices to start a pairing session', async () => {
    const dell = await jsonPost(main.port, '/api/device/pair/begin', { device: 'dell-laptop' })
    expect(dell.status).toBe(400)
    expect(dell.body).toMatchObject({ ok: false, error: 'not_a_phone_device' })

    const madeUp = await jsonPost(main.port, '/api/device/pair/begin', { device: 'samsung-unknown' })
    expect(madeUp.status).toBe(400)
    expect(madeUp.body.error).toBe('not_a_phone_device')

    const missing = await jsonPost(main.port, '/api/device/pair/begin', {})
    expect(missing.status).toBe(400)
    expect(missing.body).toMatchObject({ ok: false, error: 'device is required' })
  })

  it('rejects pings to untrusted ids and unauthorized phone calls', async () => {
    const bogus = await jsonPost(main.port, '/api/device/ping', { device: 'someone-else-phone' })
    expect(bogus.status).toBe(400)
    expect(bogus.body).toMatchObject({ ok: false, error: 'invalid_target' })

    const unauthed = await jsonPost(phone.port, '/phone/status', { id: 's26-ultra', token: 'nope' })
    expect(unauthed.status).toBe(401)
  })

  it('keeps pairing and ping surfaces closed from the LAN listener', async () => {
    // The phone listener must never expose core registry-mut surfaces.
    const paths = ['/api/device/list', '/api/device/heartbeat', '/api/wake', '/api/ai/chat/completions', '/api/files', '/api/device/ping']
    for (const path of paths) {
      const res = await jsonPost(phone.port, path, {})
      expect(res.status).toBe(404)
    }
  })
})