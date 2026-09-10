import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { promises as fsp } from 'node:fs'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RealFsBackend } from './backend.js'
import { NATIVE_LIMITS } from './limits.js'

describe('native RealFsBackend — real Windows filesystem, isolated temp root', () => {
  let root: string
  let backend: RealFsBackend

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'jarvis-native-backend-'))
    backend = new RealFsBackend()
    await fsp.mkdir(join(root, 'docs'))
    await fsp.mkdir(join(root, 'docs', 'sub'))
    await fsp.writeFile(join(root, 'a.txt'), 'alpha', 'utf8')
    await fsp.writeFile(join(root, 'docs', 'b.md'), 'beta', 'utf8')
    await fsp.writeFile(join(root, 'docs', 'logo.png'), 'png', 'utf8')
    await fsp.writeFile(join(root, 'docs', 'sub', 'inner.txt'), 'inner', 'utf8')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('list returns entries within depth (dirs one level deeper are collapsed)', async () => {
    const top = await backend.list(root, '', { depth: 1, limit: 100 })
    const paths = top.map((n) => n.path).sort()
    expect(paths).toContain('a.txt')
    expect(paths).toContain('docs/b.md')
    expect(paths).toContain('docs/logo.png')
    // 'sub' is a directory at the depth limit: it appears collapsed, its
    // children (docs/sub/inner.txt) do not.
    expect(paths).toContain('docs/sub')
    expect(paths).not.toContain('docs/sub/inner.txt')
    const deep = await backend.list(root, 'docs', { depth: 2, limit: 100 })
    expect(deep.map((n) => n.path).sort()).toEqual(['docs/b.md', 'docs/logo.png', 'docs/sub/inner.txt'])
  })

  it('search matches by query and extension', async () => {
    const results = await backend.search(root, {
      query: 'logo',
      extension: 'PNG',
      startPath: '',
      maxDepth: 4,
      limit: 100,
    })
    expect(results.map((n) => n.path).sort()).toEqual(['docs/logo.png'])
  })

  it('stat reports file and directory nodes', async () => {
    const f = await backend.stat(root, 'a.txt')
    expect(f.kind).toBe('file')
    expect(f.size).toBe(5)
    const d = await backend.stat(root, 'docs')
    expect(d.kind).toBe('directory')
    const r0 = await backend.stat(root, '')
    expect(r0.kind).toBe('directory')
  })

  it('read returns content and bytes; folders and missing paths fail', async () => {
    const { content, bytes } = await backend.read(root, 'a.txt', { maxBytes: 1024 })
    expect(content).toBe('alpha')
    expect(bytes).toBe(5)
    await expect(backend.read(root, 'docs', { maxBytes: 1024 })).rejects.toMatchObject({ code: 'invalid_path' })
    await expect(backend.read(root, 'nope.txt', { maxBytes: 1024 })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses to read files larger than the read cap', async () => {
    const big = join(root, 'big.bin')
    await fsp.writeFile(big, Buffer.alloc(NATIVE_LIMITS.MAX_READ_BYTES + 100, 1))
    await expect(backend.read(root, 'big.bin', { maxBytes: undefined })).rejects.toMatchObject({ code: 'too_large' })
  })

  it('write creates new files; overwrite is explicit', async () => {
    const { bytes } = await backend.write(root, 'fresh.txt', 'hello', { overwrite: false, maxChars: undefined })
    expect(bytes).toBe(5)
    await expect(backend.read(root, 'fresh.txt', { maxBytes: 1024 })).resolves.toMatchObject({ content: 'hello' })
    await expect(backend.write(root, 'fresh.txt', 'two', { overwrite: false, maxChars: undefined }))
      .rejects.toMatchObject({ code: 'already_exists' })
    await backend.write(root, 'fresh.txt', 'two!', { overwrite: true, maxChars: undefined })
    await expect(backend.read(root, 'fresh.txt', { maxBytes: 1024 })).resolves.toMatchObject({ content: 'two!' })
  })

  it('write enforces bounds and rejects root/traversal', async () => {
    await expect(backend.write(root, '', 'x', { overwrite: false, maxChars: undefined })).rejects.toMatchObject({ code: 'invalid_path' })
    await expect(backend.write(root, '../escape.txt', 'x', { overwrite: false, maxChars: undefined }))
      .rejects.toMatchObject({ code: 'invalid_path' })
    const long = 'x'.repeat(NATIVE_LIMITS.MAX_WRITE_CHARS + 1)
    await expect(backend.write(root, 'long.txt', long, { overwrite: false, maxChars: undefined }))
      .rejects.toMatchObject({ code: 'too_large' })
  })

  it('mkdir creates folders idempotently, refuses file targets', async () => {
    const created = await backend.mkdir(root, 'projects')
    expect(created.kind).toBe('directory')
    await expect(backend.mkdir(root, 'projects')).resolves.toMatchObject({ kind: 'directory' })
    await expect(backend.mkdir(root, 'a.txt')).rejects.toMatchObject({ code: 'already_exists' })
  })

  it('copy moves bytes between files and directories', async () => {
    await backend.copy(root, 'a.txt', 'copy.txt', { overwrite: false, maxBytes: undefined })
    await expect(backend.read(root, 'copy.txt', { maxBytes: 1024 })).resolves.toMatchObject({ content: 'alpha' })
    await expect(backend.copy(root, 'a.txt', 'copy.txt', { overwrite: false, maxBytes: undefined }))
      .rejects.toMatchObject({ code: 'already_exists' })
    await backend.copy(root, 'docs', 'docs-copy', { overwrite: false, maxBytes: undefined })
    await expect(backend.read(root, 'docs-copy/b.md', { maxBytes: 1024 })).resolves.toMatchObject({ content: 'beta' })
  })

  it('rejects copies larger than the copy cap', async () => {
    await fsp.writeFile(join(root, 'huge.bin'), Buffer.alloc(NATIVE_LIMITS.MAX_COPY_BYTES + 1000, 1))
    await expect(backend.copy(root, 'huge.bin', 'huge2.bin', { overwrite: false, maxBytes: undefined }))
      .rejects.toMatchObject({ code: 'too_large' })
  })

  it('move relocates and removes the source', async () => {
    await backend.move(root, 'copy.txt', 'moved.txt', { overwrite: false, maxBytes: undefined })
    await expect(backend.stat(root, 'moved.txt')).resolves.toMatchObject({ name: 'moved.txt' })
    await expect(backend.stat(root, 'copy.txt')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rename renames within the parent; rejects same name and existing targets', async () => {
    await backend.rename(root, 'moved.txt', 'renamed.txt')
    await expect(backend.stat(root, 'renamed.txt')).resolves.toBeTruthy()
    await expect(backend.rename(root, 'renamed.txt', 'renamed.txt')).rejects.toMatchObject({ code: 'invalid_path' })
    await expect(backend.rename(root, 'renamed.txt', 'a.txt')).rejects.toMatchObject({ code: 'already_exists' })
    await expect(backend.rename(root, 'renamed.txt', 'bad/name')).rejects.toMatchObject({ code: 'invalid_path' })
  })

  it('delete removes files and recursive folders; the root itself is protected', async () => {
    await backend.delete(root, 'renamed.txt', { recursive: false })
    await expect(backend.stat(root, 'renamed.txt')).rejects.toMatchObject({ code: 'not_found' })
    await expect(backend.delete(root, '', { recursive: true })).rejects.toMatchObject({ code: 'invalid_path' })
    await backend.delete(root, 'docs-copy', { recursive: true })
    await expect(backend.stat(root, 'docs-copy')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects an escaping junction/symlink inside the root', async () => {
    const escape = mkdtempSync(join(tmpdir(), 'jarvis-native-escape-'))
    let link: string
    try {
      link = join(root, 'escape-link')
      symlinkSync(escape, link, 'junction')
    } catch {
      rmSync(escape, { recursive: true, force: true })
      return
    }
    try {
      // The junction target must still exist for the escape to be discovered.
      await expect(backend.write(root, 'escape-link/x.txt', 'x', { overwrite: false, maxChars: undefined }))
        .rejects.toMatchObject({ code: 'outside_allowed_root' })
      await expect(backend.delete(root, 'escape-link', { recursive: true }))
        .rejects.toMatchObject({ code: 'outside_allowed_root' })
    } finally {
      rmSync(escape, { recursive: true, force: true })
      rmSync(link, { recursive: false, force: true })
    }
  })

  it('limits are bounded at the capability ceiling', async () => {
    const entries = await backend.list(root, '', { depth: 99, limit: 1_000_000 })
    expect(entries.length).toBeLessThanOrEqual(NATIVE_LIMITS.MAX_LIST_RESULTS)
  })
})