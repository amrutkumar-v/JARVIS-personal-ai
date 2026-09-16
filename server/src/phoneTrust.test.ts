import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PhoneTrust, PAIRING_CODE_TTL_MS, DEVICE_TOKEN_BYTES } from './phoneTrust.js'

describe('PhoneTrust pairing', () => {
  let dir: string
  let nowValue: number
  let pairing: PhoneTrust

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jarvis-phone-trust-'))
    nowValue = 1_000_000
    pairing = new PhoneTrust({ now: () => nowValue })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('pairs a trusted Android device and issues a per-device credential', () => {
    const begun = pairing.begin('s26-ultra')
    expect(begun).not.toBeNull()
    expect(begun!.code).toMatch(/^\d{6}$/)
    expect(begun!.deviceId).toBe('s26-ultra')
    expect(begun!.expiresInMs).toBe(PAIRING_CODE_TTL_MS)
    expect(pairing.isPaired('s26-ultra')).toBe(false)

    const claimed = pairing.claim('s26-ultra', begun!.code)
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    expect(claimed.claimed.deviceId).toBe('s26-ultra')
    expect(claimed.claimed.token.length).toBe(DEVICE_TOKEN_BYTES * 2)
    expect(pairing.isPaired('s26-ultra')).toBe(true)
    expect(pairing.authorize('s26-ultra', claimed.claimed.token)).toBe(true)
    // code is single-use
    expect(pairing.claim('s26-ultra', begun!.code).ok).toBe(false)
  })

  it('refuses unknown devices at every step', () => {
    expect(pairing.begin('not-a-trusted-device')).toBeNull()
    expect(pairing.claim('not-a-trusted-device', '000000')).toMatchObject({ ok: false, error: 'unknown_device' })
    expect(pairing.authorize('not-a-trusted-device', 'anything')).toBe(false)
    expect(pairing.begin('dell-laptop')).toBeNull() // laptop is not a phone
  })

  it('rejects a wrong code and records failed attempts that exhaust the session', () => {
    const begun = pairing.begin('s23-fe')!
    let result = pairing.claim('s23-fe', '000000')
    expect(result).toMatchObject({ ok: false, error: 'invalid_code' })
    for (let i = 0; i < 4; i += 1) {
      result = pairing.claim('s23-fe', '111111')
      expect(result).toMatchObject({ ok: false, error: 'invalid_code' })
    }
    // sixth failure exhausts the session
    result = pairing.claim('s23-fe', '222222')
    expect(result).toMatchObject({ ok: false, error: 'pairing_exhausted' })
    // no further claims possible, even with the correct code
    expect(pairing.claim('s23-fe', begun.code).ok).toBe(false)
    expect(pairing.isPaired('s23-fe')).toBe(false)
  })

  it('rejects an expired pairing code', () => {
    const begun = pairing.begin('s26-ultra')!
    nowValue += PAIRING_CODE_TTL_MS + 1
    expect(pairing.claim('s26-ultra', begun.code)).toMatchObject({ ok: false, error: 'pairing_expired' })
  })

  it('rejects a claim without an active session', () => {
    expect(pairing.claim('s26-ultra', '123456')).toMatchObject({ ok: false, error: 'pairing_not_found' })
  })

  it('authorizes only the paired device with its own token (constant-time)', () => {
    const begun = pairing.begin('s26-ultra')!
    const claimed = pairing.claim('s26-ultra', begun.code)
    if (!claimed.ok) throw new Error('failed to pair')
    const token = claimed.claimed.token
    expect(pairing.authorize('s26-ultra', token)).toBe(true)
    expect(pairing.authorize('s23-fe', token)).toBe(false) // token tied to device
    // Tamper with the last character in a way that ALWAYS differs. Replacing it
    // with a hardcoded '0' is a no-op whenever the generated token already ends
    // in '0', which made this assertion flaky (roughly 1 run in 8).
    const tampered = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
    expect(tampered).not.toBe(token)
    expect(pairing.authorize('s26-ultra', tampered)).toBe(false)
    expect(pairing.authorize('s26-ultra', '')).toBe(false)
    expect(pairing.authorize('s26-ultra', ` ${token} `)).toBe(true) // trims
  })

  it('stores only the SHA-256 of tokens, never plaintext credentials', async () => {
    const persistFile = join(dir, 'phoneTrust.json')
    const filePairing = new PhoneTrust({ persistFile, now: () => nowValue })
    const begun = filePairing.begin('s26-ultra')!
    const claimed = filePairing.claim('s26-ultra', begun.code)
    if (!claimed.ok) throw new Error('failed to pair')
    await filePairing.persist()
    const stored = await readFile(persistFile, 'utf8')
    expect(stored).not.toContain(claimed.claimed.token)
    expect(stored).toMatch(/"s26-ultra"\s*:\s*"[0-9a-f]{64}"/)
  })

  it('persists credentials across instances (phone reconnects after reboot)', async () => {
    const persistFile = join(dir, 'phoneTrust.json')
    const first = new PhoneTrust({ persistFile, now: () => nowValue })
    const begun = first.begin('s26-ultra')!
    const claimed = first.claim('s26-ultra', begun.code)
    if (!claimed.ok) throw new Error('failed to pair')
    await first.persist()

    const second = new PhoneTrust({ persistFile, now: () => nowValue })
    await second.load()
    expect(second.isPaired('s26-ultra')).toBe(true)
    expect(second.authorize('s26-ultra', claimed.claimed.token)).toBe(true)
    expect(second.authorize('s26-ultra', 'bad')).toBe(false)
  })

  it('ignores persisted entries for non-phone or malformed devices', async () => {
    const persistFile = join(dir, 'phoneTrust.json')
    await writeFile(persistFile, JSON.stringify({ 'dell-laptop': 'a'.repeat(64), 'not-trusted': 'b'.repeat(64), 's26-ultra': 'zzz' }), 'utf8')
    const pairing = new PhoneTrust({ persistFile, now: () => nowValue })
    await pairing.load()
    expect(pairing.pairedDeviceIds()).toEqual([])
    expect(pairing.isPaired('dell-laptop')).toBe(false)
  })

  it('rotates a credential so only the new token authorizes', () => {
    const begun = pairing.begin('s26-ultra')!
    const first = pairing.claim('s26-ultra', begun.code)
    if (!first.ok) throw new Error('failed to pair')
    const rotated = pairing.rotate('s26-ultra')
    if (!rotated.ok) throw new Error('failed to rotate')
    expect(pairing.authorize('s26-ultra', first.claimed.token)).toBe(false)
    expect(pairing.authorize('s26-ultra', rotated.claimed.token)).toBe(true)
  })

  it('lets an injected predicate decide which device ids can pair', () => {
    const custom = new PhoneTrust({ now: () => nowValue }, (id) => id === 'custom-phone')
    expect(custom.begin('custom-phone')).not.toBeNull()
    expect(custom.begin('s26-ultra')).toBeNull()
  })

  it('load() is a no-op without a persist file', async () => {
    await expect(pairing.load()).resolves.toBeUndefined()
    await expect(pairing.persist()).resolves.toBeUndefined()
  })
})