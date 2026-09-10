/**
 * Four-device trusted ecosystem identity (Phase 2.8) — browser side.
 *
 * Mirrors `server/src/trusted.ts`. The personal ecosystem always contains
 * exactly four devices. Phrases like "my phone" are resolved HERE, in the
 * browser only; the backend accepts canonical trusted ids alone and refuses
 * everything else. `resolveDeviceTarget` never fabricates a match: an unknown
 * or ambiguous phrase comes back unresolved so the assistant can ask instead
 * of guessing.
 */

import type { DevicePlatform, DeviceRole, DeviceType } from '../backend/types'

export interface TrustedDeviceDef {
  id: string
  name: string
  role: DeviceRole
  platform: DevicePlatform
  type: DeviceType
  /** Natural-language phrases the user may say about this device. */
  aliases: string[]
}

export const TRUSTED_DEVICES: TrustedDeviceDef[] = [
  {
    id: 'victus-5050',
    name: 'HP Victus (main PC)',
    role: 'primary_pc',
    platform: 'windows',
    type: 'windows_pc',
    aliases: ['victus', 'victus 5050', 'hp victus', 'main pc', 'my computer', 'my pc', 'this pc', 'this computer', 'primary pc'],
  },
  {
    id: 'dell-laptop',
    name: 'Dell Laptop',
    role: 'secondary_pc',
    platform: 'windows',
    type: 'windows_pc',
    aliases: ['dell', 'dell laptop', 'my other laptop', 'other laptop', 'secondary pc', 'second pc'],
  },
  {
    id: 's26-ultra',
    name: 'S26 Ultra (phone)',
    role: 'primary_phone',
    platform: 'android',
    type: 'android_phone',
    aliases: ['s26', 's26 ultra', 'galaxy s26', 'my phone', 'the phone', 'primary phone'],
  },
  {
    id: 's23-fe',
    name: 'S23 FE (phone)',
    role: 'secondary_phone',
    platform: 'android',
    type: 'android_phone',
    aliases: ['s23', 's23 fe', 'galaxy s23', 'my other phone', 'other phone', 'second phone'],
  },
]

export const TRUSTED_DEVICE_ORDER: readonly string[] = TRUSTED_DEVICES.map((d) => d.id)

export function trustedDeviceById(id: string): TrustedDeviceDef | undefined {
  return TRUSTED_DEVICES.find((d) => d.id === id)
}

export function isTrustedDevice(id: string): boolean {
  return trustedDeviceById(id) !== undefined
}

export function isPhoneDevice(id: string): boolean {
  const def = trustedDeviceById(id)
  return def?.role === 'primary_phone' || def?.role === 'secondary_phone'
}

export interface ResolvedTarget {
  /** Canonical trusted device id when a unique phrase/canonical id matched. */
  target?: string
  /** True when the phrase matched more than one device (must ask, not guess). */
  ambiguous?: boolean
  /** The canonical ids that matched, in ecosystem order. */
  matched?: string[]
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Phrase match with word boundaries so "my phone" never matches inside "my other phone". */
function includesPhrase(query: string, phrase: string): boolean {
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(phrase)}(?:[^a-z0-9]|$)`)
  return pattern.test(query)
}

/**
 * Resolve a device phrase to exactly one trusted device.
 *  - canonical trusted ids pass through;
 *  - a single unique alias match resolves;
 *  - zero matches or >1 matches returns unresolved/ambiguous: the caller
 *    should ask the user rather than guess at a device.
 */
export function resolveDeviceTarget(raw: string | undefined): ResolvedTarget {
  if (!raw) return {}
  const query = normalize(raw)
  if (!query) return {}

  if (isTrustedDevice(query)) return { target: query, matched: [query] }

  const byTarget = new Map<string, { def: TrustedDeviceDef; alias: string }[]>()
  for (const def of TRUSTED_DEVICES) {
    const hits: { def: TrustedDeviceDef; alias: string }[] = []
    for (const alias of def.aliases) {
      if (includesPhrase(query, alias)) hits.push({ def, alias })
    }
    if (hits.length > 0) byTarget.set(def.id, hits)
  }

  const matched = [...byTarget.keys()]
  if (matched.length === 0) return {}
  if (matched.length !== 1) return { ambiguous: true, matched }
  const target = matched[0]!
  return { target, matched }
}