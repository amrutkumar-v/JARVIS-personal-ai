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

const BACKEND_TEST_TOKEN = 'phone-backend-test-token'

async function jsonPost(port: number, path: string, body: unknown, token = BACKEND_TEST_TOKEN): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as any }
}

async function jsonGet(port: number, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${BACKEND_TEST_TOKEN}` } })
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
    main = await startHttpServer({ host: '127.0.0.1', port: 0, context, staticDir: undefined, publicDir: join(dir, 'public'), token: BACKEND_TEST_TOKEN })
    phone = await startPhoneServer({ host: '127.0.0.1', port: 0, registry, pairing, commands, now: () => nowValue, bus })
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
    const paths = ['/api/device/list', '/api/device/heartbeat', '/api/wake', '/api/ai/chat/completions', '/api/files', '/api/device/ping', '/api/device/call']
    for (const path of paths) {
      const res = await jsonPost(phone.port, path, {})
      expect(res.status).toBe(404)
    }
  })

  /* ----------------------------------------------------- Phase 10: calling */

  /** Pair + heartbeat a phone with the exact capabilities/permissions given. */
  async function pairPhone(
    device: string,
    capabilities: string[],
    permissions: string[],
  ): Promise<string> {
    const began = await jsonPost(main.port, '/api/device/pair/begin', { device })
    expect(began.status).toBe(200)
    const pair = await jsonPost(phone.port, '/phone/pair', { device, code: began.body.code })
    const token: string = pair.body.token
    const hb = await jsonPost(phone.port, '/phone/heartbeat', { id: device, meta: { capabilities, permissions, battery: 64 } }, token)
    expect(hb.status).toBe(200)
    return token
  }

  function captureCallEvents(): Array<Record<string, unknown>> {
    const seen: Array<Record<string, unknown>> = []
    bus.subscribe({
      id: 'test-call-subscriber',
      send(event, data) {
        if (event === 'call') seen.push(data as Record<string, unknown>)
      },
    })
    return seen
  }

  it('places a real call end-to-end: queue → phone executes → ack + call-state event → verified result', async () => {
    const callEvents = captureCallEvents()
    const token = await pairPhone('s26-ultra', ['status', 'call'], ['CALL_PHONE', 'ANSWER_PHONE_CALLS'])

    // The laptop queues a dial command for a contact name.
    const queued = await jsonPost(main.port, '/api/device/call', { action: 'dial', contact: 'Dad' })
    expect(queued.status).toBe(200)
    expect(queued.body.ok).toBe(true)
    expect(queued.body.state).toBe('CALL_REQUESTED')
    expect(queued.body.delivered).toBe(true)
    const commandId: string = queued.body.commandId

    // The phone drains it and receives exactly the allow-listed payload.
    const poll = await jsonPost(phone.port, '/phone/poll', { id: 's26-ultra' }, token)
    const dial = (poll.body.commands as any[]).find((c) => c.kind === 'call.dial')
    expect(dial).toBeDefined()
    expect(dial.payload).toEqual({ contactName: 'Dad' })

    // The phone performs the REAL call and reports the OS-observed state.
    const event = await jsonPost(phone.port, '/phone/event', {
      id: 's26-ultra', kind: 'call.state', state: 'CALLING', direction: 'outgoing', commandId, contactName: 'Dad',
    }, token)
    expect(event.status).toBe(200)
    expect(event.body).toMatchObject({ ok: true, accepted: true, callState: 'CALLING' })

    const ack = await jsonPost(phone.port, '/phone/ack', { id: 's26-ultra', commandId, ok: true, detail: 'Android accepted the call request.' }, token)
    expect(ack.body).toMatchObject({ ok: true, acknowledged: true })

    // The laptop reads the phone's concrete result (never assumed).
    const result = await jsonPost(main.port, '/api/device/call/result', { device: 's26-ultra', commandId })
    expect(result.status).toBe(200)
    expect(result.body.acknowledged).toBe(true)
    expect(result.body.result).toBe(true)
    expect(result.body.kind).toBe('call.dial')
    expect(result.body.pending).toBe(false)

    // Both the queue attempt and the OS observation travelled on the bus.
    expect(callEvents.map((e) => e.state)).toEqual(['CALL_REQUESTED', 'CALLING'])
  })

  it('refuses to queue a call for an offline phone (DEVICE_OFFLINE, nothing queued)', async () => {
    const callEvents = captureCallEvents()
    await pairPhone('s26-ultra', ['status', 'call'], ['CALL_PHONE'])
    nowValue += 41_000 // past the heartbeat TTL → the registry honestly reports offline

    const queued = await jsonPost(main.port, '/api/device/call', { action: 'dial', number: '+15550199' })
    expect(queued.status).toBe(200)
    expect(queued.body.ok).toBe(false)
    expect(queued.body.error).toBe('device_offline')
    expect(queued.body.state).toBe('DEVICE_OFFLINE')
    expect(queued.body.commandId).toBeUndefined()

    const poll = await jsonPost(phone.port, '/phone/poll', { id: 's26-ultra' })
    expect(poll.status).toBe(401) // not the point — but nothing was queued either way
    expect(callEvents.map((e) => e.state)).toEqual(['DEVICE_OFFLINE'])
  })

  it('refuses a call when the phone has not granted CALL_PHONE (PERMISSION_REQUIRED)', async () => {
    const callEvents = captureCallEvents()
    await pairPhone('s26-ultra', ['status', 'call'], []) // telephony implemented, permission not granted

    const queued = await jsonPost(main.port, '/api/device/call', { action: 'dial', contact: 'Dad' })
    expect(queued.body.ok).toBe(false)
    expect(queued.body.error).toBe('permission_required')
    expect(queued.body.state).toBe('PERMISSION_REQUIRED')
    expect(queued.body.commandId).toBeUndefined()
    expect(callEvents.map((e) => e.state)).toEqual(['PERMISSION_REQUIRED'])
  })

  it('refuses a call when the phone reports no telephony capability (NOT_SUPPORTED)', async () => {
    const callEvents = captureCallEvents()
    await pairPhone('s26-ultra', ['status', 'battery'], ['CALL_PHONE'])

    const queued = await jsonPost(main.port, '/api/device/call', { action: 'dial', contact: 'Dad' })
    expect(queued.body.ok).toBe(false)
    expect(queued.body.error).toBe('not_supported')
    expect(queued.body.state).toBe('NOT_SUPPORTED')
    expect(queued.body.commandId).toBeUndefined()
    expect(callEvents.map((e) => e.state)).toEqual(['NOT_SUPPORTED'])
  })

  it('speaks on a live call: queue → the phone receives the text → the ack is the only confirmation', async () => {
    const callEvents = captureCallEvents()
    const token = await pairPhone('s26-ultra', ['status', 'call', 'call.speak'], ['CALL_PHONE', 'ANSWER_PHONE_CALLS'])

    const queued = await jsonPost(main.port, '/api/device/call', { action: 'speak', text: 'I am on my way home.' })
    expect(queued.status).toBe(200)
    expect(queued.body.ok).toBe(true)
    expect(queued.body.state).toBe('CALL_REQUESTED')
    const commandId: string = queued.body.commandId

    // The phone drains the command and receives ONLY the allow-listed text.
    const poll = await jsonPost(phone.port, '/phone/poll', { id: 's26-ultra' }, token)
    const speak = (poll.body.commands as any[]).find((c) => c.kind === 'call.speak')
    expect(speak).toBeDefined()
    expect(speak.payload).toEqual({ text: 'I am on my way home.' })

    // The phone reports that it really played the audio.
    const ack = await jsonPost(
      phone.port,
      '/phone/ack',
      { id: 's26-ultra', commandId, ok: true, detail: 'SPOKEN: The phone played the text on its loudspeaker during the call.' },
      token,
    )
    expect(ack.body).toMatchObject({ ok: true, acknowledged: true })

    const result = await jsonPost(main.port, '/api/device/call/result', { device: 's26-ultra', commandId })
    expect(result.body.acknowledged).toBe(true)
    expect(result.body.result).toBe(true)
    expect(result.body.kind).toBe('call.speak')
    expect(result.body.detail).toContain('SPOKEN')

    // Speaking is NOT a call state, so it publishes no synthetic call event.
    expect(callEvents.map((e) => e.state)).toEqual([])
  })

  it('refuses to speak on a phone that does not advertise the call.speak capability', async () => {
    const callEvents = captureCallEvents()
    await pairPhone('s26-ultra', ['status', 'call'], ['CALL_PHONE', 'ANSWER_PHONE_CALLS'])

    const queued = await jsonPost(main.port, '/api/device/call', { action: 'speak', text: 'hello' })
    expect(queued.body.ok).toBe(false)
    expect(queued.body.error).toBe('not_supported')
    expect(queued.body.state).toBe('NOT_SUPPORTED')
    expect(queued.body.commandId).toBeUndefined()
    expect(callEvents.map((e) => e.state)).toEqual(['NOT_SUPPORTED'])
  })

  it('refuses a speak action with no text', async () => {
    await pairPhone('s26-ultra', ['status', 'call', 'call.speak'], ['CALL_PHONE'])
    const queued = await jsonPost(main.port, '/api/device/call', { action: 'speak' })
    expect(queued.status).toBe(400)
    expect(queued.body.error).toBe('invalid_argument')
  })

  it('validates call actions, targets and targets that are not phones', async () => {
    await pairPhone('s26-ultra', ['status', 'call'], ['CALL_PHONE'])

    const action = await jsonPost(main.port, '/api/device/call', { action: 'facetime' })
    expect(action.status).toBe(400)
    expect(action.body.error).toBe('invalid_action')

    const noTarget = await jsonPost(main.port, '/api/device/call', { action: 'dial' })
    expect(noTarget.status).toBe(400)
    expect(noTarget.body.error).toBe('invalid_argument')

    const badNumber = await jsonPost(main.port, '/api/device/call', { action: 'dial', number: 'FLOWERS' })
    expect(badNumber.status).toBe(400)
    expect(badNumber.body.error).toBe('invalid_argument')

    const untrusted = await jsonPost(main.port, '/api/device/call', { action: 'dial', device: 'someone-phone', contact: 'Dad' })
    expect(untrusted.status).toBe(400)
    expect(untrusted.body.error).toBe('invalid_target')

    const notAPhone = await jsonPost(main.port, '/api/device/call', { action: 'dial', device: 'dell-laptop', contact: 'Dad' })
    expect(notAPhone.status).toBe(400)
    expect(notAPhone.body.error).toBe('not_a_phone')
  })

  it('normalizes a dialled number before queueing it and rejects unknown call ids', async () => {
    const token = await pairPhone('s26-ultra', ['status', 'call'], ['CALL_PHONE'])
    const queued = await jsonPost(main.port, '/api/device/call', { action: 'dial', number: '+1 (555) 019-9' })
    expect(queued.body.ok).toBe(true)

    const poll = await jsonPost(phone.port, '/phone/poll', { id: 's26-ultra' }, token)
    const dial = (poll.body.commands as any[]).find((c) => c.kind === 'call.dial')
    expect(dial.payload).toEqual({ number: '+15550199' })

    const missing = await jsonPost(main.port, '/api/device/call/result', { device: 's26-ultra', commandId: 'not-a-command' })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('no_call_found')
  })

  it('accepts only the closed call-state vocabulary on /phone/event and requires the credential', async () => {
    const token = await pairPhone('s26-ultra', ['status', 'call'], ['CALL_PHONE'])

    const badKind = await jsonPost(phone.port, '/phone/event', { id: 's26-ultra', kind: 'steal.files', state: 'RINGING' }, token)
    expect(badKind.status).toBe(400)
    expect(badKind.body.error).toBe('unsupported_event_kind')

    const badState = await jsonPost(phone.port, '/phone/event', { id: 's26-ultra', kind: 'call.state', state: 'HACKED' }, token)
    expect(badState.status).toBe(400)
    expect(badState.body.error).toBe('invalid_call_state')

    const unauthed = await jsonPost(phone.port, '/phone/event', { id: 's26-ultra', kind: 'call.state', state: 'RINGING' })
    expect(unauthed.status).toBe(401)
  })
})
