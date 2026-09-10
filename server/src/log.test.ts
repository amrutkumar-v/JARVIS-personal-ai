import { describe, expect, it } from 'vitest'
import { createLogger, redactRecord, redactValue } from './log.js'

describe('log redaction', () => {
  it('redacts sensitive key values', () => {
    expect(redactValue('token', 'secret')).toBe('[redacted]')
    expect(redactValue('api_key', 'abc')).toBe('[redacted]')
    expect(redactValue('authorization', 'Bearer x')).toBe('[redacted]')
    expect(redactValue('password_confirmed', 'x')).toBe('[redacted]')
    expect(redactValue('version', '0.8.0')).toBe('0.8.0')
  })

  it('redacts sensitive keys nested in objects', () => {
    const out = redactRecord({ ok: true, native: { token: 's', version: '2.8.0' } })
    expect(out).toEqual({ ok: true, native: { token: '[redacted]', version: '2.8.0' } })
  })

  it('never serializes a sensitive value even from non-string data', () => {
    const lines: string[] = []
    const logger = createLogger({ write: (l) => lines.push(l) })
    logger.info('test', 'hello', { apiKey: 'topsecret', fine: 42 })
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('topsecret')
    expect(lines[0]).toContain('[redacted]')
  })
})