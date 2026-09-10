import { describe, expect, it } from 'vitest'
import { FileSystemError } from './provider'
import {
  normalizeSafePath,
  parentOf,
  baseNameOf,
  validateSegmentName,
  isRootPath,
} from './paths'

function kindOf(fn: () => unknown): string {
  try {
    fn()
    return 'ok'
  } catch (error) {
    if (error instanceof FileSystemError) return error.kind
    throw error
  }
}

describe('normalizeSafePath', () => {
  it('resolves the root to an empty string', () => {
    expect(normalizeSafePath('')).toBe('')
    expect(normalizeSafePath('   ')).toBe('')
    expect(normalizeSafePath('.')).toBe('')
  })

  it('normalizes both separators to posix form', () => {
    expect(normalizeSafePath('a/b/c')).toBe('a/b/c')
    expect(normalizeSafePath('a\\b\\c')).toBe('a/b/c')
    expect(normalizeSafePath('a\\b/c')).toBe('a/b/c')
    expect(normalizeSafePath('a//b///c')).toBe('a/b/c')
  })

  it('strips redundant dots and double separators', () => {
    expect(normalizeSafePath('a/./b')).toBe('a/b')
  })

  it('rejects traversal outside the root', () => {
    expect(kindOf(() => normalizeSafePath('a/../b'))).toBe('invalid_path')
    expect(kindOf(() => normalizeSafePath('..'))).toBe('invalid_path')
    expect(kindOf(() => normalizeSafePath('../secret'))).toBe('invalid_path')
    expect(kindOf(() => normalizeSafePath('a/..'))).toBe('invalid_path')
  })

  it('rejects absolute and drive-letter paths', () => {
    expect(kindOf(() => normalizeSafePath('/etc/passwd'))).toBe('invalid_path')
    expect(kindOf(() => normalizeSafePath('\\windows\\x'))).toBe('invalid_path')
    expect(kindOf(() => normalizeSafePath('C:/Users/a'))).toBe('invalid_path')
    expect(kindOf(() => normalizeSafePath('d:\\notes'))).toBe('invalid_path')
  })

  it('rejects non-string and control-character input', () => {
    expect(kindOf(() => normalizeSafePath(undefined as unknown as string))).toBe('invalid_path')
    expect(kindOf(() => normalizeSafePath('a\u0000b'))).toBe('invalid_path')
    expect(kindOf(() => normalizeSafePath('a\nb'))).toBe('invalid_path')
  })

  it('rejects reserved device names in any segment', () => {
    expect(kindOf(() => normalizeSafePath('con'))).toBe('invalid_path')
    expect(kindOf(() => normalizeSafePath('notes/COM1'))).toBe('invalid_path')
    expect(kindOf(() => normalizeSafePath('a/prn'))).toBe('invalid_path')
  })
})

describe('validateSegmentName', () => {
  it('accepts plain names', () => {
    expect(validateSegmentName('report.md')).toBe('report.md')
    expect(validateSegmentName('  todo.txt  ')).toBe('todo.txt')
  })

  it('rejects separators, traversal and reserved names', () => {
    expect(kindOf(() => validateSegmentName('a/b'))).toBe('invalid_path')
    expect(kindOf(() => validateSegmentName('a\\b'))).toBe('invalid_path')
    expect(kindOf(() => validateSegmentName('..'))).toBe('invalid_path')
    expect(kindOf(() => validateSegmentName('.'))).toBe('invalid_path')
    expect(kindOf(() => validateSegmentName(''))).toBe('invalid_path')
    expect(kindOf(() => validateSegmentName('NUL'))).toBe('invalid_path')
  })
})

describe('path helpers', () => {
  it('splits parent and leaf', () => {
    expect(parentOf('a/b/c.txt')).toBe('a/b')
    expect(parentOf('a.txt')).toBe('')
    expect(parentOf('')).toBe('')
    expect(baseNameOf('a/b/c.txt')).toBe('c.txt')
    expect(baseNameOf('a.txt')).toBe('a.txt')
    expect(baseNameOf('')).toBe('')
  })

  it('identifies the root', () => {
    expect(isRootPath('')).toBe(true)
    expect(isRootPath('a')).toBe(false)
  })
})