/**
 * Device registry for the JARVIS Core backend (Phase 2.8 — personal ecosystem).
 *
 * JARVIS is NOT a discovery platform: exactly four trusted devices ever exist,
 * seeded from `trusted.ts` in a fixed order (primary PC, secondary PC, primary
 * phone, secondary phone). Unknown devices are refused — never silently added.
 * Persisted state (heartbeat freshness, battery, network, version) is merged
 * back only for KNOWN trusted ids; anything else in the file is dropped.
 *
 * The PC that hosts JARVIS Core is inherently present: `victus-5050` reports
 * online from the moment the backend boots (it IS this machine). Phones and
 * the Dell are online only while their real bridge heartbeats.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { DevicePlatform, DeviceRecord, DeviceRole, DeviceType, ClaimMeta } from './types.js'
import {
  TRUSTED_DEVICES,
  TRUSTED_DEVICE_ORDER,
  trustedDeviceById,
  isTrustedDevice,
} from './trusted.js'

const DEFAULT_TTL_MS = 40_000
const HOST_DEVICE_ID = 'victus-5050'

export interface DeviceRegistryOptions {
  persistFile?: string
  ttlMs?: number
  now?: () => number
  /** Trusted device treated as "the machine JARVIS Core runs on" (online at boot). */
  hostDeviceId?: string
  /** Seed the four trusted devices (default true). */
  seedTrusted?: boolean
  /** Mark the host PC online from boot (default true — Core IS running there). */
  hostOnline?: boolean
}

export interface RegisterInput extends ClaimMeta {
  id: string
}

export class DeviceRegistry {
  private readonly devices = new Map<string, DeviceRecord>()
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly persistFile?: string
  private readonly hostDeviceId: string
  private readonly hostOnline: boolean

  constructor(opts: DeviceRegistryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.now = opts.now ?? (() => Date.now())
    this.persistFile = opts.persistFile
    this.hostDeviceId = opts.hostDeviceId ?? HOST_DEVICE_ID
    this.hostOnline = opts.hostOnline ?? true
    if (opts.seedTrusted ?? true) {
      this.seedTrusted()
    }
  }

  private seedTrusted(): void {
    const at = this.now()
    for (const def of TRUSTED_DEVICES) {
      const isHost = def.id === this.hostDeviceId
      const record: DeviceRecord = {
        id: def.id,
        name: def.name,
        type: def.type,
        platform: def.platform,
        role: def.role,
        trusted: true,
        connection: isHost ? 'local' : 'lan-bridge',
        capabilities: [...def.capabilities],
        permissions: [],
        online: isHost && this.hostOnline,
        health: isHost && this.hostOnline ? 'ok' : 'unknown',
        lastHeartbeatAt: isHost ? at : 0,
        registeredAt: at,
      }
      this.devices.set(def.id, record)
    }
  }

  /** Claim/re-register a TRUSTED device. Unknown ids are refused (null) —
   * arbitrary unknown devices are NEVER silently added to the ecosystem. */
  register(input: RegisterInput): DeviceRecord | null {
    const id = input.id.trim()
    const def = trustedDeviceById(id)
    if (!def) return null
    const at = this.now()
    const existing = this.devices.get(id)
    const record: DeviceRecord = {
      id,
      name: input.name?.trim() || existing?.name || def.name,
      type: def.type,
      platform: def.platform,
      role: def.role,
      trusted: true,
      connection: input.connection?.trim() || existing?.connection || 'lan-bridge',
      capabilities: [...new Set([...(input.capabilities ?? existing?.capabilities ?? def.capabilities)])],
      permissions: [...new Set([...(input.permissions ?? existing?.permissions ?? [])])],
      online: true,
      health: 'ok',
      lastHeartbeatAt: at,
      registeredAt: existing?.registeredAt ?? at,
      version: input.version || existing?.version,
      battery: input.battery ?? existing?.battery,
      charging: input.charging ?? existing?.charging,
      network: input.network || existing?.network,
      activity: input.activity || existing?.activity,
    }
    this.devices.set(id, record)
    void this.persist()
    return { ...record }
  }

  /** Record liveness for a trusted device. Extra telemetry merges in. Unknown
   * ids return false (never created). */
  heartbeat(id: string, extra: ClaimMeta = {}): boolean {
    const existing = this.devices.get(id)
    if (!existing || !isTrustedDevice(id)) return false
    const at = this.now()
    existing.lastHeartbeatAt = at
    existing.online = true
    existing.health = 'ok'
    if (extra.version) existing.version = extra.version
    if (typeof extra.battery === 'number') existing.battery = extra.battery
    if (typeof extra.charging === 'boolean') existing.charging = extra.charging
    if (extra.network) existing.network = extra.network
    if (extra.activity) existing.activity = extra.activity
    if (extra.connection) existing.connection = extra.connection
    if (extra.capabilities) existing.capabilities = [...new Set(extra.capabilities)]
    if (extra.permissions) existing.permissions = [...new Set(extra.permissions)]
    void this.persist()
    return true
  }

  /** Snapshot with `online`/`health` recomputed from real heartbeat freshness,
   * in the fixed ecosystem order. */
  list(): DeviceRecord[] {
    const at = this.now()
    const order = TRUSTED_DEVICE_ORDER
    const sorted = [...this.devices.values()].sort((a, b) => {
      const ra = order.indexOf(a.role ?? 'secondary_phone')
      const rb = order.indexOf(b.role ?? 'secondary_phone')
      return ra - rb
    })
    return sorted.map((record) => {
      if (record.id === this.hostDeviceId && this.hostOnline) {
        return { ...record, online: true, health: 'ok' }
      }
      // lastHeartbeatAt <= 0 means the device has NEVER reported in (seed
      // state) — honest offline, never a surprise boot-time "fresh" read.
      const seen = record.lastHeartbeatAt > 0
      const fresh = seen && at - record.lastHeartbeatAt <= this.ttlMs
      const stale = seen && at - record.lastHeartbeatAt > this.ttlMs * 3
      return {
        ...record,
        online: fresh,
        health: seen ? (fresh ? 'ok' : stale ? 'stale' : 'unknown') : 'unknown',
      }
    })
  }

  onlineDevices(): DeviceRecord[] {
    return this.list().filter((d) => d.online)
  }

  get(id: string): DeviceRecord | undefined {
    return this.list().find((d) => d.id === id)
  }

  count(): number {
    return this.devices.size
  }

  isTrusted(id: string): boolean {
    return isTrustedDevice(id)
  }

  /** Load persisted presence — ONLY for known trusted ids; anything else in the
   * file is dropped (no unknown devices survive a restart). */
  async load(): Promise<void> {
    if (!this.persistFile) return
    try {
      const text = await readFile(this.persistFile, 'utf8')
      const parsed = JSON.parse(text) as DeviceRecord[]
      if (!Array.isArray(parsed)) return
      for (const record of parsed) {
        if (!record || typeof record.id !== 'string') continue
        if (!isTrustedDevice(record.id)) continue
        const existing = this.devices.get(record.id)
        if (!existing) continue
        existing.lastHeartbeatAt = record.lastHeartbeatAt ?? 0
        existing.online = record.online === true
        existing.health = record.health ?? 'unknown'
        existing.connection = record.connection ?? existing.connection
        existing.name = record.name || existing.name
        existing.version = record.version
        existing.battery = record.battery
        existing.charging = record.charging
        existing.network = record.network
        existing.activity = record.activity
        existing.capabilities = Array.isArray(record.capabilities) && record.capabilities.length > 0 ? record.capabilities : existing.capabilities
        existing.permissions = Array.isArray(record.permissions) ? record.permissions : existing.permissions
      }
    } catch {
      // First boot / missing file: the seeded trusted set stands.
    }
  }

  async persist(): Promise<void> {
    if (!this.persistFile) return
    try {
      const dir = this.persistFile.slice(0, Math.max(0, this.persistFile.lastIndexOf('\\'), this.persistFile.lastIndexOf('/')))
      await mkdir(dir, { recursive: true })
      await writeFile(this.persistFile, JSON.stringify([...this.devices.values()], null, 2), 'utf8')
    } catch {
      // Persistence must never take the runtime down.
    }
  }
}

export type { DevicePlatform, DeviceRole, DeviceType }