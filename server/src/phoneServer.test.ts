import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceRegistry } from './registry.js'
import { EventBus } from './events.js'
import { PhoneTrust } from './phoneTrust.js'
import { PhoneCommandQueue } from './phoneCommands.js'
import { startPhoneServer, type RunningPhoneServer } from './phoneServer.js'

async function jsonPost(port: number, path: string, body: unknown, token = ''): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  let parsed: unknown
  try {
    parsed = (await res.json()) as unknown
  } catch {
    parsed = null
  }
  return { status: res.status, body: parsed }
}

describe('JARVIS phone LAN listener', () => {
  let dir: string
  let nowValue: number
  let registry: DeviceRegistry
  let pairing: PhoneTrust
  let commands: PhoneCommandQueue
  let bus: EventBus
  let running: RunningPhoneServer

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jarvis-phone-server-'))
    nowValue = 1_000_000
    registry = new DeviceRegistry({ now: () => nowValue })
    pairing = new PhoneTrust({ now: () => nowValue })
    commands = new PhoneCommandQueue({ now: () => nowValue })
    bus = new EventBus()
    running = await startPhoneServer({
      host: '127.0.0.1',
      port: 0,
      registry,
      pairing,
      commands,
      now: () => nowValue,
      bus,
    })
  })

  afterEach(async () => {
    await running.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('only exposes the seven allow-listed endpoints to POST', async () => {
    const get = await fetch(`http://127.0.0.1:${running.port}/phone/status`)
    expect(get.status).toBe(405)
    const unknown = await jsonPost(running.port, '/phone/steal-files', {})
    expect(unknown.status).toBe(404)
    expect(unknown.body).toMatchObject({ ok: false, error: 'not_found' })

    // The event channel is allow-listed, but requires the device credential.
    const event = await jsonPost(running.port, '/phone/event', { id: 's26-ultra', kind: 'call.state', state: 'RINGING' })
    expect(event.status).toBe(401)
  })

  it('refuses malformed and oversized bodies', async () => {
    const res = await fetch(`http://127.0.0.1:${running.port}/phone/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })
    expect(res.status).toBe(400)
    const huge = await fetch(`http://127.0.0.1:${running.port}/phone/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 's26-ultra', meta: { name: 'x'.repeat(200_000) } }),
    })
    expect(huge.status).toBe(413)
  })

  it('requires device + code to pair', async () => {
    expect(await jsonPost(running.port, '/phone/pair', { device: 's26-ultra' })).toEqual({
      status: 400,
      body: { ok: false, error: 'device and code are required' },
    })
  })

  it('rejects an invalid pairing code', async () => {
    pairing.begin('s26-ultra')
    const result = await jsonPost(running.port, '/phone/pair', { device: 's26-ultra', code: '000000' })
    expect(result.status).toBe(401)
    expect(result.body).toMatchObject({ ok: false, error: 'invalid_code' })
  })

  it('refuses to pair an unknown device', async () => {
    const result = await jsonPost(running.port, '/phone/pair', { device: 'samsung-unknown', code: '123456' })
    expect(result.status).toBe(401)
    expect(result.body).toMatchObject({ ok: false, error: 'unknown_device' })
  })

  it('pairs a trusted phone over HTTP and issues a token bound to its id', async () => {
    pairing.begin('s26-ultra')
    const code = pairing['sessions'].get('s26-ultra')!.code
    const result = await jsonPost(running.port, '/phone/pair', { device: 's26-ultra', code })
    expect(result.status).toBe(200)
    const body = result.body as { ok: boolean; token: string; device: { id: string } }
    expect(body.ok).toBe(true)
    expect(body.token.length).toBe(64)
    expect(body.device.id).toBe('s26-ultra')
    expect(pairing.authorize('s26-ultra', body.token)).toBe(true)
  })

  it('pairs then heartbeats a device online with telemetry', async () => {
    pairing.begin('s26-ultra')
    const code = pairing['sessions'].get('s26-ultra')!.code
    const pair = (await jsonPost(running.port, '/phone/pair', { device: 's26-ultra', code })).body as { token: string }
    const token = pair.token
    const heartbeat = await jsonPost(running.port, '/phone/heartbeat', {
      id: 's26-ultra',
      meta: { battery: 82, charging: true, network: 'wifi', capabilities: ['status', 'battery', 'network', 'ping', 'heartbeat', 'connection'] },
    }, token)
    expect(heartbeat.status).toBe(200)
    expect(registry.get('s26-ultra')?.online).toBe(true)
    expect(registry.get('s26-ultra')?.battery).toBe(82)
    expect(registry.get('s26-ultra')?.charging).toBe(true)
    expect(registry.get('s26-ultra')?.network).toBe('wifi')
  })

  it('requires a valid credential for every non-pair endpoint', async () => {
    const missing = await jsonPost(running.port, '/phone/heartbeat', { id: 's26-ultra', meta: {} })
    expect(missing.status).toBe(401)
    const wrong = await jsonPost(running.port, '/phone/heartbeat', { id: 's26-ultra', meta: {} }, 'deadbeef'.repeat(8))
    expect(wrong.status).toBe(401)
    // the LAN listener never opens the registry to unauthenticated callers
    expect(registry.get('s26-ultra')?.online).toBe(false)
  })

  it('binds a credential to its device: another device id is refused', async () => {
    pairing.begin('s26-ultra')
    const code = pairing['sessions'].get('s26-ultra')!.code
    const pair = (await jsonPost(running.port, '/phone/pair', { device: 's26-ultra', code })).body as { token: string }
    const other = await jsonPost(running.port, '/phone/heartbeat', { id: 's23-fe', meta: {} }, pair.token)
    expect(other.status).toBe(401)
  })

  it('status reflects what the backend believes about the device', async () => {
    pairing.begin('s26-ultra')
    const code = pairing['sessions'].get('s26-ultra')!.code
    const pair = (await jsonPost(running.port, '/phone/pair', { device: 's26-ultra', code })).body as { token: string }
    const before = (await jsonPost(running.port, '/phone/status', { id: 's26-ultra' }, pair.token)).body as { device: { online: boolean } }
    expect(before.device.online).toBe(false)
    await jsonPost(running.port, '/phone/heartbeat', { id: 's26-ultra', meta: { battery: 50 } }, pair.token)
    const after = (await jsonPost(running.port, '/phone/status', { id: 's26-ultra' }, pair.token)).body as { device: { online: boolean; battery: number } }
    expect(after.device.online).toBe(true)
    expect(after.device.battery).toBe(50)
  })

  it('answers reachability pings from the phone', async () => {
    pairing.begin('s23-fe')
    const code = pairing['sessions'].get('s23-fe')!.code
    const pair = (await jsonPost(running.port, '/phone/pair', { device: 's23-fe', code })).body as { token: string }
    const ping = (await jsonPost(running.port, '/phone/ping', { id: 's23-fe' }, pair.token)).body as { ok: boolean; pong: boolean }
    expect(ping).toMatchObject({ ok: true, pong: true })
  })

  it('drains queued commands via poll and verifies ack results', async () => {
    pairing.begin('s26-ultra')
    const code = pairing['sessions'].get('s26-ultra')!.code
    const pair = (await jsonPost(running.port, '/phone/pair', { device: 's26-ultra', code })).body as { token: string }
    await jsonPost(running.port, '/phone/heartbeat', { id: 's26-ultra', meta: {} }, pair.token)

    const dispatched = commands.dispatchPing('s26-ultra', true)
    expect(dispatched.delivered).toBe(true)
    expect(dispatched.command).not.toBeNull()

    const poll = (await jsonPost(running.port, '/phone/poll', { id: 's26-ultra' }, pair.token)).body as { commands: Array<{ commandId: string; kind: string }> }
    expect(poll.commands).toHaveLength(1)
    expect(poll.commands[0]!.kind).toBe('ping')
    expect(poll.commands[0]!.commandId).toBe(dispatched.command!.commandId)

    const ack = await jsonPost(running.port, '/phone/ack', { id: 's26-ultra', commandId: poll.commands[0]!.commandId, ok: true, detail: 'pong 12ms' }, pair.token)
    expect(ack.status).toBe(200)
    expect(ack.body).toMatchObject({ ok: true, acknowledged: true })

    const result = commands.pingResult(dispatched.command!.requestId, 's26-ultra')
    expect(result).toMatchObject({ ok: true, detail: 'pong 12ms', pending: false })
  })

  it('rejects acks for unknown or already-acked commands', async () => {
    pairing.begin('s26-ultra')
    const code = pairing['sessions'].get('s26-ultra')!.code
    const pair = (await jsonPost(running.port, '/phone/pair', { device: 's26-ultra', code })).body as { token: string }
    const unknown = await jsonPost(running.port, '/phone/ack', { id: 's26-ultra', commandId: 'nope', ok: true }, pair.token)
    expect(unknown.status).toBe(200)
    expect(unknown.body).toMatchObject({ ok: false, error: 'unknown_command' })

    const dispatched = commands.dispatchPing('s26-ultra', true)
    await jsonPost(running.port, '/phone/ack', { id: 's26-ultra', commandId: dispatched.command!.commandId, ok: true }, pair.token)
    const again = await jsonPost(running.port, '/phone/ack', { id: 's26-ultra', commandId: dispatched.command!.commandId, ok: true }, pair.token)
    expect(again.body).toMatchObject({ ok: false, error: 'unknown_command' })
  })

  it('executes a queued call command and publishes the REAL call state on the bus', async () => {
    pairing.begin('s26-ultra')
    const code = pairing['sessions'].get('s26-ultra')!.code
    const pair = (await jsonPost(running.port, '/phone/pair', { device: 's26-ultra', code })).body as { token: string }
    const token = pair.token

    const published: Array<Record<string, unknown>> = []
    bus.subscribe({
      id: 'sub-call',
      send(event, data) {
        if (event === 'call') published.push(data as Record<string, unknown>)
      },
    })

    const dispatched = commands.enqueue({ deviceId: 's26-ultra', kind: 'call.dial', payload: { contactName: 'Dad' }, online: true })
    expect(dispatched.command).not.toBeNull()

    const poll = (await jsonPost(running.port, '/phone/poll', { id: 's26-ultra' }, token)).body as { commands: Array<{ commandId: string; kind: string; payload?: Record<string, string> }> }
    expect(poll.commands).toHaveLength(1)
    expect(poll.commands[0]!.kind).toBe('call.dial')
    expect(poll.commands[0]!.payload).toEqual({ contactName: 'Dad' })

    // The phone reports the OS-observed state; the core fans it out verbatim.
    const event = await jsonPost(running.port, '/phone/event', {
      id: 's26-ultra', kind: 'call.state', state: 'RINGING', direction: 'outgoing', commandId: poll.commands[0]!.commandId, contactName: 'Dad',
    }, token)
    expect(event.status).toBe(200)
    expect(event.body).toMatchObject({ ok: true, accepted: true, callState: 'RINGING' })
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ deviceId: 's26-ultra', state: 'RINGING', direction: 'outgoing', contactName: 'Dad' })
  })

  it('fails cleanly when the LAN listener is unreachable', async () => {
    const closed = await startPhoneServer({
      host: '127.0.0.1',
      port: 0,
      registry,
      pairing,
      commands,
      now: () => nowValue,
    })
    const port = closed.port
    await closed.close()
    await expect(fetch(`http://127.0.0.1:${port}/phone/heartbeat`, { method: 'POST' })).rejects.toThrow(/ECONNREFUSED|fetch failed/i)
  })
})