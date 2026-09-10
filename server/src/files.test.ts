import { describe, expect, it } from 'vitest'
import { FileStore, sanitizeFileName } from './files.js'

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-files-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('FileStore', () => {
  it('sanitizes names so they can never be a path', () => {
    expect(sanitizeFileName('report FINAL v2.pdf')).toBe('report FINAL v2.pdf')
    expect(sanitizeFileName('a\\b/:*?"<>|..')).not.toMatch(/[\\/:*?"<>|]/)
    expect(sanitizeFileName('')).toBe('file.bin')
  })

  it('stores and reads bytes back', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new FileStore({ dir, now: () => 1000, generateId: () => 'f-1' })
      await store.save('hello.txt', new TextEncoder().encode('hi'))
      const result = await store.read('f-1')
      expect(result?.record.name).toBe('hello.txt')
      expect(result?.bytes.toString()).toBe('hi')
      expect(store.count()).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('rejects transfers over the byte bound', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new FileStore({ dir, maxBytes: 4, now: () => 1000 })
      const saved = await store.save('big.bin', new TextEncoder().encode('12345'))
      expect(saved).toEqual({ error: 'too_large' })
      expect(store.count()).toBe(0)
    } finally {
      await cleanup()
    }
  })

  it('returns null for unknown ids', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const store = new FileStore({ dir, now: () => 1000 })
      expect(await store.read('nope')).toBeNull()
    } finally {
      await cleanup()
    }
  })
})