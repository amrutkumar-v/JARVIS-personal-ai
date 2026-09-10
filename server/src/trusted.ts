/**
 * Trusted four-device model — JARVIS Core is a PERSONAL ecosystem, not a
 * generic device-discovery platform. Exactly these four devices are ever
 * trusted; unknown devices are detected/rejected but never silently added.
 *
 * The registry is the only source of truth; aliases and natural-language
 * resolution live on the assistant side (browser), the backend accepts only
 * canonical device ids (never invented ids, never arbitrary new ones).
 */

export type DevicePlatform = 'windows' | 'android'

export type DeviceRole = 'primary_pc' | 'secondary_pc' | 'primary_phone' | 'secondary_phone'

export type TrustedDeviceType = 'windows_pc' | 'android_phone'

export interface TrustedDeviceDefinition {
  /** Stable, canonical id (the ONLY id ever accepted on the wire). */
  id: string
  /** Friendly display name. */
  name: string
  type: TrustedDeviceType
  platform: DevicePlatform
  role: DeviceRole
  /** Truthful capacity the device can host WHEN its bridge is connected
   * (never claimed from a dead bridge). */
  capabilities: string[]
}

export const TRUSTED_DEVICES: readonly TrustedDeviceDefinition[] = [
  {
    id: 'victus-5050',
    name: "Amrut's Victus",
    type: 'windows_pc',
    platform: 'windows',
    role: 'primary_pc',
    capabilities: ['filesystem', 'applications', 'screen', 'mouse', 'keyboard', 'camera', 'vision', 'automation'],
  },
  {
    id: 'dell-laptop',
    name: "Amrut's Dell",
    type: 'windows_pc',
    platform: 'windows',
    role: 'secondary_pc',
    capabilities: ['filesystem', 'applications', 'screen', 'mouse', 'keyboard', 'camera', 'vision', 'automation'],
  },
  {
    id: 's26-ultra',
    name: "Amrut's S26 Ultra",
    type: 'android_phone',
    platform: 'android',
    role: 'primary_phone',
    capabilities: ['notifications', 'files', 'inbound', 'battery', 'network', 'status'],
  },
  {
    id: 's23-fe',
    name: "Amrut's S23 FE",
    type: 'android_phone',
    platform: 'android',
    role: 'secondary_phone',
    capabilities: ['notifications', 'files', 'inbound', 'battery', 'network', 'status'],
  },
] as const

/** Deterministic dashboard order: primary PC → secondary PC → primary phone → secondary phone. */
export const TRUSTED_DEVICE_ORDER: readonly DeviceRole[] = ['primary_pc', 'secondary_pc', 'primary_phone', 'secondary_phone']

const BY_ID = new Map<string, TrustedDeviceDefinition>(TRUSTED_DEVICES.map((d) => [d.id, d]))
const BY_ROLE = new Map<DeviceRole, TrustedDeviceDefinition>(TRUSTED_DEVICES.map((d) => [d.role, d]))

export function isTrustedDevice(id: string): boolean {
  return BY_ID.has(id)
}

export function trustedDeviceById(id: string): TrustedDeviceDefinition | undefined {
  return BY_ID.get(id)
}

export function trustedDeviceByRole(role: DeviceRole): TrustedDeviceDefinition | undefined {
  return BY_ROLE.get(role)
}

export function trustedDeviceIds(): string[] {
  return TRUSTED_DEVICES.map((d) => d.id)
}

export function isPhoneDevice(id: string): boolean {
  return trustedDeviceById(id)?.platform === 'android'
}