import { describe, expect, it } from 'vitest'
import { DeviceRegistry } from './registry.js'
import { TRUSTED_DEVICES } from './trusted.js'

let nowValue = 1000

function registry(opts: { ttlMs?: number; seedTrusted?: boolean } = {}) {
  return new DeviceRegistry({ ttlMs: opts.ttlMs ?? 1000, now: () => nowValue, seedTrusted: opts.seedTrusted ?? true })
}

describe('DeviceRegistry — trusted four-device ecosystem', () => {
  it('seeds exactly the four trusted devices in the fixed ecosystem order', () => {
    const reg = registry()
    const ids = reg.list().map((d) => d.id)
    expect(ids).toEqual(['victus-5050', 'dell-laptop', 's26-ultra', 's23-fe'])
    expect(reg.count()).toBe(4)
    for (const def of TRUSTED_DEVICES) {
      const record = reg.get(def.id)
      expect(record?.trusted).toBe(true)
      expect(record?.role).toBe(def.role)
      expect(record?.platform).toBe(def.platform)
    }
  })

  it('marks the host PC (victus) online from boot and keeps phones offline until claimed', () => {
    const reg = registry()
    const state = Object.fromEntries(reg.list().map((d) => [d.id, d.online]))
    expect(state['victus-5050']).toBe(true)
    expect(state['dell-laptop']).toBe(false)
    expect(state['s26-ultra']).toBe(false)
    expect(state['s23-fe']).toBe(false)
  })

  it('REFUSES unknown devices — they are never silently added', () => {
    const reg = registry()
    expect(reg.register({ id: 'pixel-9' })).toBeNull()
    expect(reg.count()).toBe(4)
    expect(reg.register({ id: '' })).toBeNull()
    expect(reg.count()).toBe(4)
  })

  it('claiming a trusted device updates online state, capabilities and telemetry', () => {
    const reg = registry()
    const claimed = reg.register({
      id: 's26-ultra',
      name: "Amrut's S26 Ultra",
      connection: 'lan-bridge',
      version: '2.8.0',
      battery: 82,
      charging: true,
      network: 'wifi',
      capabilities: ['notifications', 'files', 'inbound', 'battery', 'network'],
      permissions: ['notify', 'inbound'],
    })
    expect(claimed).not.toBeNull()
    expect(reg.get('s26-ultra')?.online).toBe(true)
    expect(reg.get('s26-ultra')?.battery).toBe(82)
    expect(reg.get('s26-ultra')?.charging).toBe(true)
    expect(reg.get('s26-ultra')?.network).toBe('wifi')
    expect(reg.get('s26-ultra')?.version).toBe('2.8.0')
  })

  it('marks a claimed phone offline when its heartbeat lapses beyond the TTL', () => {
    nowValue = 1000
    const reg = registry()
    reg.register({ id: 's23-fe' })
    expect(reg.onlineDevices().map((d) => d.id)).toContain('s23-fe')

    nowValue = 1000 + 4001
    const phone = reg.get('s23-fe')
    expect(phone?.online).toBe(false)
    expect(phone?.health).toBe('stale')
    expect(reg.onlineDevices().map((d) => d.id)).toEqual(['victus-5050'])
  })

  it('heartbeat refreshes liveness and merges telemetry; unknown ids are rejected', () => {
    const reg = registry()
    expect(reg.heartbeat('s26-ultra', { battery: 41, network: 'wifi' })).toBe(true)
    expect(reg.get('s26-ultra')?.battery).toBe(41)
    expect(reg.heartbeat('unknown-phone')).toBe(false)
    expect(reg.count()).toBe(4)
  })

  it('persists and reloads, keeping only trusted ids and dropping unknown entries', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-registry-'))
    try {
      const file = join(dir, 'devices.json')
      const reg = new DeviceRegistry({ persistFile: file, now: () => nowValue })
      reg.register({ id: 's26-ultra', battery: 77, network: 'wifi' })
      await reg.persist()

      // Ancient file with an UNKNOWN device (from the old discovery era) plus a trusted one.
      await writeFile(
        file,
        JSON.stringify(
          [
            { id: 'dev-legacy-unknown', name: 'Pixel 9', trusted: false },
            { id: 's26-ultra', name: "Amrut's S26 Ultra", trusted: true, battery: 77, network: 'wifi', lastHeartbeatAt: nowValue },
          ],
          null,
          2,
        ),
        'utf8',
      )

      const reloaded = new DeviceRegistry({ persistFile: file, now: () => nowValue })
      await reloaded.load()
      expect(reloaded.count()).toBe(4)
      expect(reloaded.get('dev-legacy-unknown')).toBeUndefined()
      expect(reloaded.get('s26-ultra')?.battery).toBe(77)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('DeviceRegistry — two bridges reporting for one device', () => {
  it('a heartbeat that does NOT report capabilities never erases them', () => {
    nowValue = 1000
    const reg = registry()
    reg.register({ id: 's26-ultra', capabilities: ['call', 'call.speak'] })
    expect(reg.get('s26-ultra')?.capabilities).toContain('call')

    // A report with no capabilities field (e.g. the browser companion page).
    reg.heartbeat('s26-ultra', { battery: 55 })
    expect(reg.get('s26-ultra')?.capabilities).toContain('call')
    expect(reg.get('s26-ultra')?.capabilities).toContain('call.speak')
  })

  it('capabilities from two bridges ACCUMULATE — neither erases the other', () => {
    nowValue = 1000
    const reg = registry()
    reg.register({ id: 's26-ultra', capabilities: ['call', 'call.speak'] })
    // The browser companion reports a different, smaller vocabulary.
    reg.heartbeat('s26-ultra', { capabilities: ['notifications', 'files', 'inbound'] })
    const caps = reg.get('s26-ultra')?.capabilities ?? []
    expect(caps).toContain('call')
    expect(caps).toContain('call.speak')
    expect(caps).toContain('notifications')
  })

  it('permissions REPLACE when reported — a revoked permission really disappears', () => {
    nowValue = 1000
    const reg = registry()
    reg.register({ id: 's26-ultra', permissions: ['CALL_PHONE', 'ANSWER_PHONE_CALLS'] })
    expect(reg.get('s26-ultra')?.permissions).toContain('CALL_PHONE')

    // The device reports its CURRENT grant state: the user revoked the dial
    // permission on the phone.
    reg.heartbeat('s26-ultra', { permissions: [] })
    expect(reg.get('s26-ultra')?.permissions ?? []).not.toContain('CALL_PHONE')
  })

  it('permissions are left untouched when a reporter does not state them', () => {
    nowValue = 1000
    const reg = registry()
    reg.register({ id: 's26-ultra', permissions: ['CALL_PHONE'] })
    reg.heartbeat('s26-ultra', { capabilities: ['notifications'] })
    expect(reg.get('s26-ultra')?.permissions).toContain('CALL_PHONE')
  })
})