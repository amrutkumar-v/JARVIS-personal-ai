import { describe, expect, it } from 'vitest'
import {
  CANONICAL_WAKE_PHRASE,
  normalizeSpeechText,
  splitWakeAndCommand,
  isWakeWordText,
  classifyUtterance,
} from './normalization'

describe('normalizeSpeechText (Phase 1.6)', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normalizeSpeechText('  WAKE   UP,   JARVIS!! ')).toBe('wake up jarvis')
    expect(normalizeSpeechText('Open The File, Please.')).toBe('open the file please')
    expect(normalizeSpeechText('')).toBe('')
  })

  it('keeps letters, digits and spaces only', () => {
    expect(normalizeSpeechText('call-911 now!')).toBe('call 911 now')
  })
})

describe('splitWakeAndCommand (Phase 1.6)', () => {
  it('matches the canonical phrase regardless of casing/punctuation', () => {
    expect(CANONICAL_WAKE_PHRASE).toBe('wake up jarvis')
    expect(splitWakeAndCommand('Wake up, JARVIS.')).toEqual({ matched: true })
    expect(splitWakeAndCommand('  wake   up  jarvis  ')).toEqual({ matched: true })
  })

  it('captures a trailing command in direct form', () => {
    expect(splitWakeAndCommand('Wake up, JARVIS, open Chrome.')).toEqual({
      matched: true,
      command: 'open Chrome.',
    })
    expect(splitWakeAndCommand('wake up jarvis open chrome')).toEqual({
      matched: true,
      command: 'open chrome',
    })
  })

  it('does NOT match bare names or partial phrases (no LLM involved)', () => {
    expect(splitWakeAndCommand('Jarvis')).toEqual({ matched: false })
    expect(splitWakeAndCommand('wake up')).toEqual({ matched: false })
    expect(splitWakeAndCommand('hello jarvis')).toEqual({ matched: false })
    expect(splitWakeAndCommand('hey there')).toEqual({ matched: false })
    expect(splitWakeAndCommand('')).toEqual({ matched: false })
  })

  it('isWakeWordText mirrors the split result', () => {
    expect(isWakeWordText('WAKE UP, JARVIS, what time is it?')).toBe(true)
    expect(isWakeWordText('jarvis')).toBe(false)
  })
})

describe('classifyUtterance (Phase 1.6)', () => {
  it('routes sleep phrases ("go to sleep", "sleep", "stop listening")', () => {
    expect(classifyUtterance('go to sleep')).toBe('sleep')
    expect(classifyUtterance('Sleep!')).toBe('sleep')
    expect(classifyUtterance(' STOP  LISTENING ')).toBe('sleep')
  })

  it('routes cancel phrases', () => {
    expect(classifyUtterance('stop')).toBe('cancel')
    expect(classifyUtterance('Cancel')).toBe('cancel')
  })

  it('routes everything else as a normal command', () => {
    expect(classifyUtterance('open Chrome')).toBe('command')
    expect(classifyUtterance('what time is it?')).toBe('command')
    expect(classifyUtterance('wake up jarvis')).toBe('command')
  })

  it('routes empty input as none', () => {
    expect(classifyUtterance('')).toBe('none')
    expect(classifyUtterance('   ')).toBe('none')
    expect(classifyUtterance('!!!')).toBe('none')
  })
})