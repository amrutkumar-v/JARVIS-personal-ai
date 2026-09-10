import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeError } from './errors.js'
import { assertInsideRootRealpath, isWithinRoot, normalizeRelPath, resolveWithinRoot, validateNativeSegment } from './paths.js'

const ROOT = 'C:\\JARVIS\\workspace'

function kindOf(fn: () => unknown): string {
  try {
    fn()
    return 'ok'
  } catch (error) {
    return error instanceof Error && error.name === 'NativeError'
      ? (error as NativeError).code
      : 'threw'
  }
}

describe('native path safety — resolution', () => {
  it('resolves a clean relative path under the root', () => {
    const { abs, rel } = resolveWithinRoot(ROOT, 'notes/todo.txt')
    expect(abs).toBe('C:\\JARVIS\\workspace\\notes\\todo.txt')
    expect(rel).toBe('notes/todo.txt')
  })

  it('resolves the root itself for empty paths', () => {
    const { abs, rel } = resolveWithinRoot(ROOT, '')
    expect(abs).toBe(ROOT)
    expect(rel).toBe('')
  })

  it('normalizes forward/backward slashes and dots', () => {
    const { rel } = resolveWithinRoot(ROOT, 'a\\b\\./c')
    expect(rel).toBe('a/b/c')
    expect(normalizeRelPath('  a // b / ')).toBe('a/b')
    expect(normalizeRelPath('')).toBe('')
  })

  it('rejects traversal', () => {
    expect(kindOf(() => resolveWithinRoot(ROOT, '..'))).toBe('invalid_path')
    expect(kindOf(() => resolveWithinRoot(ROOT, '../secret'))).toBe('invalid_path')
    expect(kindOf(() => resolveWithinRoot(ROOT, 'a/../../out'))).toBe('invalid_path')
    expect(kindOf(() => resolveWithinRoot(ROOT, 'a\\..\\..\\x'))).toBe('invalid_path')
  })

  it('rejects absolute, drive-letter and UNC paths', () => {
    expect(kindOf(() => resolveWithinRoot(ROOT, '/etc/passwd'))).toBe('invalid_path')
    expect(kindOf(() => resolveWithinRoot(ROOT, '\\windows\\x'))).toBe('invalid_path')
    expect(kindOf(() => resolveWithinRoot(ROOT, 'C:\\Users\\a'))).toBe('invalid_path')
    expect(kindOf(() => resolveWithinRoot(ROOT, 'd:\\notes'))).toBe('invalid_path')
    expect(kindOf(() => resolveWithinRoot(ROOT, '\\\\server\\share\\x'))).toBe('invalid_path')
    expect(kindOf(() => resolveWithinRoot(ROOT, '//server/share/x'))).toBe('invalid_path')
  })

  it('rejects control characters, reserved names and illegal segment characters', () => {
    expect(kindOf(() => resolveWithinRoot(ROOT, 'a\u0000b'))).toBe('invalid_path')
    expect(kindOf(() => resolveWithinRoot(ROOT, 'a\nb'))).toBe('invalid_path')
    expect(kindOf(() => resolveWithinRoot(ROOT, 'con'))).toBe('invalid_path')
    expect(kindOf(() => resolveWithinRoot(ROOT, 'notes/COM1'))).toBe('invalid_path')
    expect(kindOf(() => resolveWithinRoot(ROOT, 'a/prn'))).toBe('invalid_path')
    expect(kindOf(() => resolveWithinRoot(ROOT, 'a:b'))).toBe('invalid_path')
    expect(kindOf(() => resolveWithinRoot(ROOT, 'a*b'))).toBe('invalid_path')
    expect(kindOf(() => resolveWithinRoot(ROOT, 'a<b'))).toBe('invalid_path')
  })

  it('rejects non-string paths', () => {
    expect(kindOf(() => resolveWithinRoot(ROOT, undefined as unknown as string))).toBe('invalid_path')
  })

  it('isWithinRoot is case-insensitive and separator-aware', () => {
    expect(isWithinRoot(ROOT, 'C:\\JARVIS\\workspace\\a')).toBe(true)
    expect(isWithinRoot(ROOT, 'c:\\jarvis\\workspace\\a')).toBe(true)
    expect(isWithinRoot(ROOT, 'C:\\JARVIS\\workspace')).toBe(true)
    expect(isWithinRoot(ROOT, 'C:\\JARVIS\\workspaceX\\a')).toBe(false)
    expect(isWithinRoot(ROOT, 'C:\\JARVIS\\elsewhere')).toBe(false)
  })

  it('validateNativeSegment rejects separators, dots, names and control chars', () => {
    expect(kindOf(() => validateNativeSegment('a/b'))).toBe('invalid_path')
    expect(kindOf(() => validateNativeSegment('a\\b'))).toBe('invalid_path')
    expect(kindOf(() => validateNativeSegment('..'))).toBe('invalid_path')
    expect(kindOf(() => validateNativeSegment('.'))).toBe('invalid_path')
    expect(kindOf(() => validateNativeSegment(''))).toBe('invalid_path')
    expect(kindOf(() => validateNativeSegment('NUL'))).toBe('invalid_path')
    expect(kindOf(() => validateNativeSegment('a\u0001b'))).toBe('invalid_path')
    expect(validateNativeSegment('  hello.txt  ')).toBe('hello.txt')
  })
})

describe('native path safety — symlink/junction containment (real fs, isolated temp)', () => {
  let tmp: string
  let outside: string

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jarvis-native-paths-'))
    outside = mkdtempSync(join(tmpdir(), 'jarvis-native-outside-'))
  })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('permits a real file/directory inside the root', async () => {
    const project = join(tmp, 'project')
    mkdirSync(project)
    await expect(assertInsideRootRealpath(tmp, project)).resolves.toBeUndefined()
    await expect(assertInsideRootRealpath(tmp, join(tmp, 'missing.txt'))).resolves.toBeUndefined()
  })

  it('blocks an escaping junction (or symlink) placed inside the root', async () => {
    let link: string
    try {
      link = join(tmp, 'escape-link')
      symlinkSync(outside, link, 'junction')
    } catch {
      // Junctions/symlinks unavailable in this environment (privileges) — skip.
      return
    }
    await expect(assertInsideRootRealpath(tmp, join(link, 'file.txt'))).rejects.toMatchObject({ code: 'outside_allowed_root' })
    await expect(assertInsideRootRealpath(tmp, link)).rejects.toMatchObject({ code: 'outside_allowed_root' })
  })
})