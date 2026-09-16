/**
 * Phone pairing trust store for the JARVIS Core backend (Phase 4.1 — real
 * Android companion).
 *
 * A companion phone becomes a trusted device ONLY through a short-lived
 * pairing code. The code is created on the laptop (loopback `/api/device/pair/
 * begin`), displayed in the backend log, typed into the phone app, and then
 * exchanged once for a per-device credential at `/phone/pair`.
 *
 *  - Pairing codes are 6 digits, bound to a single trusted Android device id,
 *    valid for 10 minutes, and rate-limited (exhaustion invalidates the code).
 *  - Device credentials are random 32-byte tokens. Only the SHA-256 of a token
 *    is ever stored or persisted — the raw token is shown to the phone exactly
 *    once and never kept server-side in plaintext.
 *  - Credentials persist across backend restarts so a phone reconnects after
 *    the laptop reboots without re-pairing.
 *
 * Unknown device ids (anything outside the four trusted ids) are refused at
 * every step — JARVIS never invents a trusted device.
 */

import { createHash, randomBytes, randomInt } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isPhoneDevice } from './trusted.js'

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000
export const PAIRING_MAX_FAILED_ATTEMPTS = 6
export const DEVICE_TOKEN_BYTES = 32

export type PairClaimError =
  | 'unknown_device'
  | 'pairing_not_found'
  | 'pairing_expired'
  | 'pairing_exhausted'
  | 'invalid_code'

export interface PairingSession {
  code: string
  deviceId: string
  expiresAt: number
  failedAttempts: number
}

export interface BegunPairing {
  code: string
  deviceId: string
  expiresAt: number
  expiresInMs: number
}

export interface ClaimedPairing {
  token: string
  deviceId: string
}

export interface PhoneTrustOptions {
  persistFile?: string
  now?: () => number
  codeTtlMs?: number
  maxFailedAttempts?: number
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export class PhoneTrust {
  private readonly now: () => number
  private readonly persistFile?: string
  private readonly codeTtlMs: number
  private readonly maxFailedAttempts: number
  /** Active (unexpired) pairing code sessions, keyed by device id. */
  private readonly sessions = new Map<string, PairingSession>()
  /** Whitelisted trusted-Android-device predicate (injected for testability). */
  private readonly isPhone: (deviceId: string) => boolean
  /** Device id → sha256(token) for every paired device. */
  private readonly credentials = new Map<string, string>()

  constructor(opts: PhoneTrustOptions = {}, isPhone: (deviceId: string) => boolean = (id) => isPhoneDevice(id)) {
    this.now = opts.now ?? (() => Date.now())
    this.persistFile = opts.persistFile
    this.codeTtlMs = opts.codeTtlMs ?? PAIRING_CODE_TTL_MS
    this.maxFailedAttempts = opts.maxFailedAttempts ?? PAIRING_MAX_FAILED_ATTEMPTS
    this.isPhone = isPhone
  }

  /** Start a pairing session for a trusted Android device, returning the code. */
  begin(deviceId: string): BegunPairing | null {
    const id = deviceId.trim().toLowerCase()
    if (!this.isPhone(id)) return null
    const now = this.now()
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
    const expiresAt = now + this.codeTtlMs
    this.sessions.set(id, { code, deviceId: id, expiresAt, failedAttempts: 0 })
    return { code, deviceId: id, expiresAt, expiresInMs: this.codeTtlMs }
  }

  /** Exchange a pairing code for a one-time device credential token. */
  claim(deviceId: string, code: string): { ok: true; claimed: ClaimedPairing } | { ok: false; error: PairClaimError } {
    const id = deviceId.trim().toLowerCase()
    if (!this.isPhone(id)) return { ok: false, error: 'unknown_device' }
    const session = this.sessions.get(id)
    if (!session) return { ok: false, error: 'pairing_not_found' }
    if (session.failedAttempts >= this.maxFailedAttempts) {
      this.sessions.delete(id)
      return { ok: false, error: 'pairing_exhausted' }
    }
    if (this.now() > session.expiresAt) {
      this.sessions.delete(id)
      return { ok: false, error: 'pairing_expired' }
    }
    const given = code.trim()
    if (!constantTimeEqual(session.code, given)) {
      session.failedAttempts += 1
      const exhausted = session.failedAttempts >= this.maxFailedAttempts
      if (exhausted) this.sessions.delete(id)
      return { ok: false, error: exhausted ? 'pairing_exhausted' : 'invalid_code' }
    }
    this.sessions.delete(id)
    const token = randomBytes(DEVICE_TOKEN_BYTES).toString('hex')
    this.credentials.set(id, sha256(token))
    void this.persist()
    return { ok: true, claimed: { token, deviceId: id } }
  }

  /** Verify a presented device credential for a device id (constant-time). */
  authorize(deviceId: string, token: string): boolean {
    const id = deviceId.trim().toLowerCase()
    const stored = this.credentials.get(id)
    if (!stored || !token) return false
    return constantTimeEqual(stored, sha256(token.trim()))
  }

  /** True when a device has a valid credential (used for honest UI state). */
  isPaired(deviceId: string): boolean {
    return this.credentials.has(deviceId.trim().toLowerCase())
  }

  pairedDeviceIds(): string[] {
    return [...this.credentials.keys()]
  }

  /** Rotate/replace a device credential (drives the Android app re-pair). */
  rotate(deviceId: string): { ok: true; claimed: ClaimedPairing } | { ok: false; error: 'unknown_device' } {
    const id = deviceId.trim().toLowerCase()
    if (!this.isPhone(id)) return { ok: false, error: 'unknown_device' }
    const token = randomBytes(DEVICE_TOKEN_BYTES).toString('hex')
    this.credentials.set(id, sha256(token))
    void this.persist()
    return { ok: true, claimed: { token, deviceId: id } }
  }

  /** Load persisted credential hashes (phishing-safe: hashes only). */
  async load(): Promise<void> {
    if (!this.persistFile) return
    try {
      const text = await readFile(this.persistFile, 'utf8')
      const parsed = JSON.parse(text) as Record<string, string>
      if (!parsed || typeof parsed !== 'object') return
      for (const [id, hash] of Object.entries(parsed)) {
        if (!this.isPhone(id) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) continue
        this.credentials.set(id, hash)
      }
    } catch {
      // First boot / missing file — no pairings exist yet.
    }
  }

  async persist(): Promise<void> {
    if (!this.persistFile) return
    try {
      const dir = this.persistFile.slice(0, Math.max(0, this.persistFile.lastIndexOf('\\'), this.persistFile.lastIndexOf('/')))
      await mkdir(dir, { recursive: true })
      await writeFile(this.persistFile, JSON.stringify(Object.fromEntries(this.credentials), null, 2), 'utf8')
    } catch {
      // Persistence must never take the runtime down.
    }
  }
}