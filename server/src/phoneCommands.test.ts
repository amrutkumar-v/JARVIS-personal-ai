import { describe, expect, it } from 'vitest'
import {
  COMMAND_PAYLOAD_FIELDS,
  MAX_PAYLOAD_FIELD_CHARS,
  MAX_PENDING_PER_DEVICE,
  OUTBOUND_COMMAND_KINDS,
  PhoneCommandQueue,
  sanitizeCommandPayload,
} from './phoneCommands.js'

/**
 * The command queue is the ONLY path by which the core can ask a phone to do
 * something, so its contract is pinned here:
 *  - a CLOSED allow-list of kinds (no generic "run this");
 *  - a per-kind payload allow-list — anything else is dropped, never forwarded;
 *  - delivery is claimed only for an online device;
 *  - results come only from a real ack, and acked commands are never reused.
 */

function queueAt(now: () => number): PhoneCommandQueue {
  return new PhoneCommandQueue({ now })
}

describe('phone command queue', () => {
  it('exposes exactly the telephony + ping command vocabulary', () => {
    expect(OUTBOUND_COMMAND_KINDS).toEqual(['ping', 'call.dial', 'call.hangup', 'call.answer', 'call.reject'])
    expect(COMMAND_PAYLOAD_FIELDS.ping).toEqual([])
    expect(COMMAND_PAYLOAD_FIELDS['call.dial']).toEqual(['target', 'number', 'contactName'])
    expect(COMMAND_PAYLOAD_FIELDS['call.hangup']).toEqual([])
  })

  it('keeps ONLY the fields the kind declares', () => {
    const payload = sanitizeCommandPayload('call.dial', {
      contactName: 'Dad',
      number: '+15550199',
      sneaky: 'rm -rf /',
      permission: 'elevate',
    })
    expect(payload).toEqual({ contactName: 'Dad', number: '+15550199' })
    expect(sanitizeCommandPayload('call.dial', { sneaky: 'x' })).toBeUndefined()
    // A payload-free kind never carries anything at all.
    expect(sanitizeCommandPayload('call.hangup', { contactName: 'Dad' })).toBeUndefined()
  })

  it('bounds every string field it does forward', () => {
    const long = 'x'.repeat(500)
    const payload = sanitizeCommandPayload('call.dial', { contactName: long })
    expect(payload?.contactName).toHaveLength(MAX_PAYLOAD_FIELD_CHARS)
  })

  it('refuses an unknown command kind instead of queueing it', () => {
    const queue = queueAt(() => 0)
    const result = queue.enqueue({ deviceId: 's26-ultra', kind: 'shell.exec' as never, online: true })
    expect(result.command).toBeNull()
    expect(result.reason).toContain('not an allowed command kind')
  })

  it('reports delivery only for an online device, and queues either way', () => {
    const queue = queueAt(() => 0)
    const online = queue.enqueue({ deviceId: 's26-ultra', kind: 'call.dial', payload: { contactName: 'Dad' }, online: true })
    expect(online.delivered).toBe(true)
    expect(online.reason).toBeUndefined()

    const offline = queue.enqueue({ deviceId: 's23-fe', kind: 'call.dial', payload: { contactName: 'Dad' }, online: false })
    expect(offline.delivered).toBe(false)
    expect(offline.reason).toContain('offline')
  })

  it('caps unacknowledged commands per device', () => {
    const queue = queueAt(() => 0)
    for (let i = 0; i < MAX_PENDING_PER_DEVICE; i += 1) {
      expect(queue.enqueue({ deviceId: 's26-ultra', kind: 'call.answer', online: true }).command).not.toBeNull()
    }
    const overflow = queue.enqueue({ deviceId: 's26-ultra', kind: 'call.answer', online: true })
    expect(overflow.command).toBeNull()
    expect(overflow.reason).toContain('too many unacknowledged commands')
  })

  it('ignores commands owned by another device', () => {
    const queue = queueAt(() => 0)
    queue.enqueue({ deviceId: 's26-ultra', kind: 'call.hangup', online: true })
    expect(queue.nextFor('s23-fe')).toEqual([])
    expect(queue.ack('whatever', 's23-fe', { ok: true })).toBe(false)
  })

  it('exposes a result only after the phone acks it, and never twice', () => {
    const now = 5_000
    const queue = queueAt(() => now)
    const dispatched = queue.enqueue({ deviceId: 's26-ultra', kind: 'call.dial', payload: { number: '+15550199' }, online: true })
    const command = dispatched.command!

    const before = queue.result({ commandId: command.commandId }, 's26-ultra')
    expect(before).toMatchObject({ pending: true, ok: undefined })
    expect(before?.ackedAt).toBeUndefined()

    expect(queue.ack(command.commandId, 's26-ultra', { ok: true, detail: 'CALLING' })).toBe(true)
    const after = queue.result({ commandId: command.commandId }, 's26-ultra')
    expect(after).toMatchObject({ pending: false, ok: true, detail: 'CALLING', kind: 'call.dial' })

    // A second ack for the same command is refused.
    expect(queue.ack(command.commandId, 's26-ultra', { ok: false })).toBe(false)
  })

  it('finds the latest command of a kind when no id is given and expires stale ones', () => {
    let now = 1_000
    const queue = queueAt(() => now)
    queue.enqueue({ deviceId: 's26-ultra', kind: 'call.answer', online: true })
    now += 10
    const latest = queue.enqueue({ deviceId: 's26-ultra', kind: 'call.answer', online: true }).command!

    const found = queue.result({ kind: 'call.answer' }, 's26-ultra')
    expect(found?.commandId).toBe(latest.commandId)

    // Past the command TTL the pending command is gone from the poll surface.
    now += 60_001
    expect(queue.nextFor('s26-ultra')).toEqual([])
  })
})
