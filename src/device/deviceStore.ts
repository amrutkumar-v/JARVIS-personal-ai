import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { DeviceRecord } from '../backend/types'
import { TRUSTED_DEVICES } from './trusted'
import type { DeviceProvider } from './provider'

export type DeviceTrustState = 'trusted' | 'untrusted' | 'pending' | 'revoked'

export interface DeviceState extends DeviceRecord {
  trustState: DeviceTrustState
  trustUpdatedAt: number
  lastVerifiedAt?: number
  verificationFailures: number
  aliases: string[]
}

/** Bounded liveness window for a cached registry snapshot (Work 11.19).
 * Device state is never polled: the store only ever carries the last honest
 * refresh, marked `stale` once it is older than this window. */
export const DEVICE_STATE_TTL_MS = 40_000
/** Upper bound on one refresh call so the store can never hang the UI. */
export const DEVICE_REFRESH_TIMEOUT_MS = 10_000

export interface DeviceStore {
  devices: Map<string, DeviceState>
  lastRefreshAt: number
  isRefreshing: boolean
  refreshError: string | null

  // Actions
  setDevices: (devices: DeviceRecord[]) => void
  updateDevice: (id: string, partial: Partial<DeviceState>) => void
  setTrustState: (id: string, state: DeviceTrustState) => void
  setRefreshing: (refreshing: boolean) => void
  setRefreshError: (error: string | null) => void
  clearError: () => void
  /** Bounded, on-demand refresh from the real device provider (Work 11.19). */
  refreshFromProvider: () => Promise<void>

  // Trust enforcement
  isTrusted: (id: string) => boolean
  requireTrust: (id: string) => { ok: boolean; reason?: string }
  getTrustedDevices: () => DeviceState[]
  getOnlineTrustedDevices: () => DeviceState[]

  // Device selection helpers
  resolveTarget: (raw: string | undefined) => { deviceId?: string; ambiguous?: boolean; matched?: string[]; error?: string }
  getDeviceById: (id: string) => DeviceState | undefined
  getDeviceByRole: (role: string) => DeviceState | undefined
}

const TRUSTED_ALIASES: Record<string, string[]> = Object.fromEntries(
  TRUSTED_DEVICES.map((d) => [d.id, d.aliases]),
)

function isTrustedDeviceId(id: string): boolean {
  return TRUSTED_ALIASES[id] !== undefined
}

/** Seed the four trusted devices as offline/stale until a real refresh arrives —
 * mirrored from the backend registry, never a fabricated "online". */
function seedState(): Map<string, DeviceState> {
  const map = new Map<string, DeviceState>()
  for (const def of TRUSTED_DEVICES) {
    map.set(def.id, {
      id: def.id,
      name: def.name,
      type: def.type,
      platform: def.platform,
      role: def.role,
      trusted: true,
      connection: 'lan-bridge',
      capabilities: [],
      permissions: [],
      online: false,
      health: 'unknown',
      lastHeartbeatAt: 0,
      registeredAt: 0,
      trustState: 'trusted',
      trustUpdatedAt: 0,
      verificationFailures: 0,
      aliases: def.aliases,
    })
  }
  return map
}

/** Real, non-fabricating device provider carried by the store (Work 11.20). */
let providerRef: DeviceProvider | undefined

export function setDeviceProvider(provider: DeviceProvider | undefined): void {
  providerRef = provider
}

export async function refreshDeviceRegistry(): Promise<void> {
  await useDeviceStore.getState().refreshFromProvider()
}

const createStore = () => {
  return create<DeviceStore>()(
    subscribeWithSelector((set, get) => ({
devices: seedState(),
      lastRefreshAt: 0,
      isRefreshing: false,
      refreshError: null,

      setDevices: (devices: DeviceRecord[]) => {
        const now = Date.now()
        const newMap = new Map<string, DeviceState>()
        for (const d of devices) {
          const existing = get().devices.get(d.id)
          const aliases = TRUSTED_ALIASES[d.id] ?? []
          newMap.set(d.id, {
            ...d,
            trustState: isTrustedDeviceId(d.id) ? 'trusted' : 'untrusted',
            trustUpdatedAt: existing?.trustUpdatedAt ?? now,
            lastVerifiedAt: existing?.lastVerifiedAt,
            verificationFailures: existing?.verificationFailures ?? 0,
            aliases,
          })
        }
        // Preserve known trusted devices that were not in this snapshot: they
        // are still part of the ecosystem, just offline/stale (honest marker).
        for (const [id, existing] of get().devices) {
          if (!newMap.has(id) && existing.trustState === 'trusted') {
            newMap.set(id, { ...existing, online: false, health: 'stale' })
          }
        }
        set({ devices: newMap, lastRefreshAt: now, isRefreshing: false, refreshError: null })
      },

      refreshFromProvider: async () => {
        if (get().isRefreshing) {
          // Never stack refreshes or poll — the UI asks once and holds.
          set({ refreshError: null })
          return
        }
        if (!providerRef) {
          set({ refreshError: 'No device provider is connected.' })
          return
        }
        set({ isRefreshing: true, refreshError: null })
        try {
          const devices = await Promise.race([
            providerRef.refresh(),
            timeoutPromise(DEVICE_REFRESH_TIMEOUT_MS),
          ])
          const now = Date.now()
          const snapshot = devices.map((d) => {
            const fresh = now - d.lastHeartbeatAt <= DEVICE_STATE_TTL_MS
            return { ...d, online: d.online && fresh, health: d.online && fresh ? ('ok' as const) : ('stale' as const) }
          })
          get().setDevices(snapshot)
        } catch {
          set({ isRefreshing: false, refreshError: 'Could not refresh device state.' })
        }
      },

      updateDevice: (id: string, partial: Partial<DeviceState>) => {
        set((state: DeviceStore) => {
          const existing = state.devices.get(id)
          if (!existing) return state
          const newMap = new Map(state.devices)
          newMap.set(id, { ...existing, ...partial })
          return { devices: newMap }
        })
      },

      setTrustState: (id: string, state: DeviceTrustState) => {
        set((s: DeviceStore) => {
          const existing = s.devices.get(id)
          if (!existing) return s
          const newMap = new Map(s.devices)
          newMap.set(id, { ...existing, trustState: state, trustUpdatedAt: Date.now() })
          return { devices: newMap }
        })
      },

      setRefreshing: (refreshing: boolean) => set({ isRefreshing: refreshing }),
      setRefreshError: (error: string | null) => set({ refreshError: error }),
      clearError: () => set({ refreshError: null }),

      isTrusted: (id: string) => {
        const d = get().devices.get(id)
        return d?.trustState === 'trusted' && d.online
      },

      requireTrust: (id: string) => {
        const d = get().devices.get(id)
        if (!d) return { ok: false, reason: `Device "${id}" is not registered.` }
        if (d.trustState !== 'trusted') return { ok: false, reason: `Device "${id}" is not trusted (state: ${d.trustState}).` }
        if (!d.online) return { ok: false, reason: `Device "${id}" is offline.` }
        return { ok: true }
      },

      getTrustedDevices: () => {
        return Array.from(get().devices.values()).filter((d: DeviceState) => d.trustState === 'trusted')
      },

      getOnlineTrustedDevices: () => {
        return Array.from(get().devices.values()).filter((d: DeviceState) => d.trustState === 'trusted' && d.online)
      },

      resolveTarget: (raw: string | undefined) => {
        if (!raw || !raw.trim()) return {}
        const query = raw.trim().toLowerCase()
        const devices = get().getTrustedDevices()
        const matched = devices
          .filter((d: DeviceState) => d.id === query || d.aliases?.some((a: string) => a.toLowerCase() === query))
          .map((d: DeviceState) => d.id)
        if (matched.length === 0) return { error: `No trusted device matches "${raw}".` }
        if (matched.length > 1) return { ambiguous: true, matched }
        return { deviceId: matched[0] }
      },

      getDeviceById: (id: string) => get().devices.get(id),

      getDeviceByRole: (role: string) => {
        return Array.from(get().devices.values()).find((d: DeviceState) => d.role === role)
      },
    }))
  )
}

/** Rejects after a bounded delay so a hung provider cannot block the store. */
function timeoutPromise(ms: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('device refresh timed out')), ms)
    // Node's unref keeps the timer from pinning the runtime in long-lived tests.
    const refable = timer as unknown as { unref?: () => void }
    if (typeof refable.unref === 'function') refable.unref()
  })
}

export const useDeviceStore = createStore()

/** Internal test hook — restores the honest seeded registry for a fresh test. */
export const resetDeviceStoreForTests = (): void => {
  useDeviceStore.setState({
    devices: seedState(),
    lastRefreshAt: 0,
    isRefreshing: false,
    refreshError: null,
  })
}

export const useTrustedDevices = () => useDeviceStore((s) => s.getTrustedDevices())
export const useOnlineTrustedDevices = () => useDeviceStore((s) => s.getOnlineTrustedDevices())
export const useDeviceById = (id: string) => useDeviceStore((s) => s.getDeviceById(id))
export const useOnlineTrustedCount = () => useDeviceStore((s) => s.getOnlineTrustedDevices().length)
export const useDeviceTrustState = (id: string) => useDeviceStore((s) => s.devices.get(id)?.trustState)