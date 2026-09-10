import { describe, expect, it } from 'vitest'
import { TRUSTED_DEVICES, isTrustedDevice, isPhoneDevice, resolveDeviceTarget, trustedDeviceById } from './trusted'
import { routeDeviceTarget } from './router'
import type { DeviceRecord } from '../backend/types'

describe('trusted device identity — the four-device ecosystem', () => {
  it('contains exactly the four trusted devices in order', () => {
    expect(TRUSTED_DEVICES.map((d) => d.id)).toEqual(['victus-5050', 'dell-laptop', 's26-ultra', 's23-fe'])
    expect(TRUSTED_DEVICES.map((d) => d.role)).toEqual(['primary_pc', 'secondary_pc', 'primary_phone', 'secondary_phone'])
  })

  it('recognises canonical ids and phones', () => {
    expect(isTrustedDevice('s26-ultra')).toBe(true)
    expect(isTrustedDevice('pixel-9')).toBe(false)
    expect(isPhoneDevice('s23-fe')).toBe(true)
    expect(isPhoneDevice('victus-5050')).toBe(false)
    expect(trustedDeviceById('dell-laptop')?.name).toContain('Dell')
  })

  it('resolves canonical ids directly', () => {
    expect(resolveDeviceTarget('dell-laptop')).toEqual({ target: 'dell-laptop', matched: ['dell-laptop'] })
  })

  it('resolves the requested natural-language defaults', () => {
    expect(resolveDeviceTarget('send it to my phone').target).toBe('s26-ultra')
    expect(resolveDeviceTarget('notify my computer').target).toBe('victus-5050')
    expect(resolveDeviceTarget('ping my pc').target).toBe('victus-5050')
    expect(resolveDeviceTarget('send to my other laptop').target).toBe('dell-laptop')
    expect(resolveDeviceTarget('send to my other phone').target).toBe('s23-fe')
    expect(resolveDeviceTarget('on the dell').target).toBe('dell-laptop')
  })

  it('never matches a substring across words: "my other phone" is not "my phone"', () => {
    expect(resolveDeviceTarget('send to my other phone').target).toBe('s23-fe')
    expect(resolveDeviceTarget('my phone').target).toBe('s26-ultra')
  })

  it('flags ambiguity instead of guessing', () => {
    const res = resolveDeviceTarget('check both galaxy s23 and s26')
    expect(res.ambiguous).toBe(true)
    expect(res.target).toBeUndefined()
    expect(res.matched).toEqual(['s26-ultra', 's23-fe'])
  })

  it('leaves unknown and too-vague phrases unresolved so the assistant can ask', () => {
    expect(resolveDeviceTarget('the microwave').target).toBeUndefined()
    expect(resolveDeviceTarget('phone').target).toBeUndefined()
    expect(resolveDeviceTarget('').target).toBeUndefined()
    expect(resolveDeviceTarget(undefined).target).toBeUndefined()
  })
})

describe('device router — honest routes', () => {
  function seed(onlineIds: string[]): DeviceRecord[] {
    const all: DeviceRecord[] = TRUSTED_DEVICES.map((def, i) => ({
      id: def.id,
      name: def.name,
      type: def.type,
      platform: def.platform,
      connection: 'backend',
      capabilities: [],
      permissions: [],
      online: onlineIds.includes(def.id),
      health: onlineIds.includes(def.id) ? 'ok' : 'unknown',
      lastHeartbeatAt: onlineIds.includes(def.id) ? 500 : 0,
      registeredAt: i,
      trusted: true,
      role: def.role,
    }))
    return all
  }

  function route(target: string | undefined, records: DeviceRecord[]) {
    return routeDeviceTarget(records, target)
  }

  it('routes to a trusted device that is online', () => {
    const r = route('s26-ultra', seed(['s26-ultra', 'victus-5050']))
    expect(r.available).toBe(true)
    expect(r.deviceId).toBe('s26-ultra')
    expect(r.transport).toBe('backend')
  })

  it('reports an honest offline reason for a trusted device without a listener', () => {
    const r = route('s26-ultra', seed([]))
    expect(r.available).toBe(false)
    expect(r.reason).toContain('offline')
  })

  it('refuses targets outside the trusted four', () => {
    const r = route('pixel-9', seed(['victus-5050']))
    expect(r.available).toBe(false)
    expect(r.reason).toContain('not one of your four trusted')
  })

  it('broadcast is unavailable honestly when the backend is unreachable', () => {
    const r = route(undefined, [])
    expect(r.available).toBe(false)
    expect(r.reason).toContain('backend is not connected')
  })

  it('broadcast is unavailable when nothing is online', () => {
    const r = route('all', seed([]))
    expect(r.available).toBe(false)
    expect(r.reason).toContain('no device is online')
  })

  it('broadcast is available when at least one device is online', () => {
    const r = route(undefined, seed(['s23-fe']))
    expect(r.available).toBe(true)
    expect(r.deviceId).toBe('all')
  })
})