import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceProvider } from './provider'
import type { DeviceRecord } from '../backend/types'
import {
  DEVICE_REFRESH_TIMEOUT_MS,
  useDeviceStore,
  setDeviceProvider,
  refreshDeviceRegistry,
  resetDeviceStoreForTests,
} from './deviceStore'
import { TRUSTED_DEVICES } from './trusted'

function record(id: string, online = false, lastHeartbeatAt = 0): DeviceRecord {
  const def = TRUSTED_DEVICES.find((d) => d.id === id)!
  return {
    id,
    name: def.name,
    type: def.type,
    platform: def.platform,
    role: def.role,
    trusted: true,
    connection: 'lan-bridge',
    capabilities: [],
    permissions: [],
    online,
    health: online ? 'ok' : 'unknown',
    lastHeartbeatAt,
    registeredAt: 1,
  }
}

function sameDeviceProvider(devices: DeviceRecord[]): DeviceProvider {
  return {
    capabilities: () => ({ available: true }),
    refresh: async () => devices,
    refreshDevices: async () => devices,
    notify: async () => ({ delivered: false, deliveredTo: [] }),
    sendFile: async () => ({ ok: false, error: 'no' }),
    openUrl: async () => ({ success: false, error: 'no' }),
  }
}

describe('Phase 11 — device store (Work 11.2 trust + 11.19 bounded refresh)', () => {
  beforeEach(() => {
    setDeviceProvider(undefined)
    resetDeviceStoreForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('seeds the four trusted devices as offline/stale (never fabricated online)', () => {
    const store = useDeviceStore.getState()
    expect(store.getTrustedDevices().length).toBe(4)
    expect(store.getOnlineTrustedDevices().length).toBe(0)
    for (const device of store.getTrustedDevices()) {
      expect(device.trustState).toBe('trusted')
      expect(device.online).toBe(false)
      expect(device.health).toBe('unknown')
    }
    expect(store.devices.has('victus-5050')).toBe(true)
    expect(store.devices.has('dell-laptop')).toBe(true)
    expect(store.devices.has('s26-ultra')).toBe(true)
    expect(store.devices.has('s23-fe')).toBe(true)
  })

  it('setDevices honors live online state and honors trust enforcement', () => {
    const store = useDeviceStore.getState()
    const online = [{ ...record('s26-ultra', true, Date.now()) }]
    store.setDevices(online)

    const after = useDeviceStore.getState()
    expect(after.isTrusted('s26-ultra')).toBe(true)
    expect(after.requireTrust('s26-ultra')).toEqual({ ok: true })
    expect(after.getOnlineTrustedDevices().map((d) => d.id)).toEqual(['s26-ultra'])
    // Known trusted devices absent from the snapshot stay as stale offline.
    expect(after.devices.get('s23-fe')?.online).toBe(false)
    expect(after.devices.get('s23-fe')?.health).toBe('stale')
    expect(after.devices.get('s23-fe')?.trustState).toBe('trusted')
  })

  it('resolveTarget resolves aliases to canonical ids and refuses unknown phrases', () => {
    const store = useDeviceStore.getState()
    expect(store.resolveTarget('my phone')).toEqual({ deviceId: 's26-ultra' })
    expect(store.resolveTarget('my other laptop')).toEqual({ deviceId: 'dell-laptop' })
    expect(store.resolveTarget('the microwave')).toMatchObject({ error: expect.stringContaining('No trusted device') })
    expect(store.resolveTarget(undefined)).toEqual({})
  })

  it('refreshFromProvider refreshes real state once, with a stale marker for old heartbeats', async () => {
    const now = Date.now()
    setDeviceProvider(
      sameDeviceProvider([
        record('s26-ultra', true, now),
        record('s23-fe', true, now - 200_000), // heartbeat lapsed → stale, never online
      ]),
    )

    await useDeviceStore.getState().refreshFromProvider()

    const after = useDeviceStore.getState()
    expect(after.isRefreshing).toBe(false)
    expect(after.refreshError).toBeNull()
    expect(after.devices.get('s26-ultra')?.online).toBe(true)
    expect(after.devices.get('s26-ultra')?.health).toBe('ok')
    expect(after.devices.get('s23-fe')?.online).toBe(false)
    expect(after.devices.get('s23-fe')?.health).toBe('stale')
  })

  it('never stacks refreshing calls — a second refresh waits for the first (no polling)', async () => {
    let calls = 0
    const provider: DeviceProvider = {
      capabilities: () => ({ available: true }),
      refresh: async () => {
        calls += 1
        await new Promise((r) => setTimeout(r, 5))
        return [record('s26-ultra', true, Date.now())]
      },
      refreshDevices: async () => [],
      notify: async () => ({ delivered: false, deliveredTo: [] }),
      sendFile: async () => ({ ok: false, error: 'no' }),
      openUrl: async () => ({ success: false, error: 'no' }),
    }
    setDeviceProvider(provider)

    const first = useDeviceStore.getState().refreshFromProvider()
    await useDeviceStore.getState().refreshFromProvider() // mid-flight
    expect(calls).toBe(1)

    await first
    let mid = calls
    await useDeviceStore.getState().refreshFromProvider() // after done
    expect(calls).toBe(mid + 1)
  })

  it('a hung provider cannot block the store (bounded timeout, honest error)', async () => {
    vi.useFakeTimers()
    const provider: DeviceProvider = {
      capabilities: () => ({ available: true }),
      refresh: () => new Promise<DeviceRecord[]>(() => undefined), // never resolves
      refreshDevices: async () => [],
      notify: async () => ({ delivered: false, deliveredTo: [] }),
      sendFile: async () => ({ ok: false, error: 'no' }),
      openUrl: async () => ({ success: false, error: 'no' }),
    }
    setDeviceProvider(provider)

    const pending = useDeviceStore.getState().refreshFromProvider()
    await vi.advanceTimersByTimeAsync(DEVICE_REFRESH_TIMEOUT_MS + 1)
    await pending

    const after = useDeviceStore.getState()
    expect(after.isRefreshing).toBe(false)
    expect(after.refreshError).toContain('refresh')
  })

  it('reports an honest error when no provider is bound', async () => {
    setDeviceProvider(undefined)
    useDeviceStore.setState({ refreshError: null })
    await refreshDeviceRegistry()
    expect(useDeviceStore.getState().refreshError).toContain('No device provider')
  })
})