import { describe, expect, it } from 'vitest'
import { sanitizeVisionPayload } from './sanitize'

const VISUAL_TYPE = { target: 'ok', window_id: 1, text: 'hunter2', confidence_threshold: 0.7 }
const VISUAL_CLICK = { target: 'ok', window_id: 1, expected_after: 'Saved' }

describe('sanitizeVisionPayload', () => {
  it('redacts typed text on desktop.visualType', () => {
    const done = sanitizeVisionPayload('desktop.visualType', VISUAL_TYPE)
    expect(done.text).toBe('[redacted]')
    expect(Object.values(done)).not.toContain('hunter2')
  })

  it('keeps non-text fields intact on desktop.visualType', () => {
    const done = sanitizeVisionPayload('desktop.visualType', VISUAL_TYPE)
    expect(done.target).toBe('ok')
    expect(done.window_id).toBe(1)
  })

  it('does not touch expected_after on desktop.visualClick', () => {
    expect(sanitizeVisionPayload('desktop.visualClick', VISUAL_CLICK)).toEqual(VISUAL_CLICK)
  })

  it('leaves non-visual payloads untouched', () => {
    const payload = { text: 'hunter2' }
    expect(sanitizeVisionPayload('desktop.type', payload)).toEqual(payload)
    expect(sanitizeVisionPayload('filesystem.write', payload)).toEqual(payload)
    expect(sanitizeVisionPayload('unknown', payload)).toEqual(payload)
  })

  it('is a pure copy and never mutates the input', () => {
    const original = structuredClone(VISUAL_TYPE)
    sanitizeVisionPayload('desktop.visualType', VISUAL_TYPE)
    expect(VISUAL_TYPE).toEqual(original)
  })
})