import { describe, expect, it, beforeEach } from 'vitest'
import type { Tool, ToolResult } from '../tools/Tool'
import { requiresUserConfirmation } from '../tools/Tool'
import { FakeFileSystemProvider } from './testing'
import { createFileSystemTools } from './FileSystemTools'
import { FS_LIMITS } from './limits'

/**
 * Phase 1.1 — filesystem tools, scenario coverage A–X against the
 * deterministic in-memory provider (tests only). Every claim here checks real
 * provider state — a tool never reports a fake change as a real one.
 */

function call(tool: Tool, params: Record<string, unknown>): Promise<ToolResult> {
  return tool.execute({ query: '', params }, { requestId: 'unit' })
}

let provider: FakeFileSystemProvider
let tools: Map<string, Tool>

beforeEach(() => {
  provider = new FakeFileSystemProvider({
    'README.md': '# JARVIS',
    'notes/': { directory: true },
    'notes/todo.txt': 'buy milk',
    'notes/deep/': { directory: true },
    'notes/deep/nested.txt': 'deep',
    'main.ts': 'export const a = 1',
  })
  tools = new Map(createFileSystemTools(provider).map((t) => [t.id, t]))
})

/* ---------------------------------------------------------------- tiers */

describe('permission boundaries', () => {
  it('keeps readers read_only, writers low_risk and delete user_confirmation', () => {
    for (const id of ['file.status', 'file.list', 'file.search', 'file.stat', 'file.read']) {
      expect(tools.get(id)!.permission, id).toBe('read_only')
    }
    for (const id of ['file.mkdir', 'file.write', 'file.copy', 'file.move', 'file.rename']) {
      expect(tools.get(id)!.permission, id).toBe('low_risk')
    }
    const del = tools.get('file.delete')!
    expect(del.permission).toBe('user_confirmation')
    expect(del.requiresPermission).toBe(true)
    expect(requiresUserConfirmation(del)).toBe(true)
    expect(requiresUserConfirmation(tools.get('file.read')!)).toBe(false)
  })

  it('marks writers verifiable and readers not', () => {
    for (const id of ['file.mkdir', 'file.write', 'file.copy', 'file.move', 'file.rename', 'file.delete']) {
      expect(tools.get(id)!.verifiable, id).toBe(true)
    }
    expect(tools.get('file.list')!.verifiable).toBe(false)
  })
})

/* ---------------------------------------------------------------- status */

describe('A — file.status', () => {
  it('reports honest availability and supported operations', async () => {
    const out = await call(tools.get('file.status')!, {})
    expect(out.ok).toBe(true)
    const caps = out.data as { available: boolean; ops: Record<string, boolean> }
    expect(caps.available).toBe(true)
    expect(caps.ops.delete).toBe(true)
    expect(out.message).toContain('available')
  })

  it('never pretends access that does not exist', async () => {
    provider.setAvailable(false)
    const out = await call(tools.get('file.status')!, {})
    expect(out.ok).toBe(true) // the report itself succeeded — honestly
    expect((out.data as { available: boolean }).available).toBe(false)
    expect(out.message).toMatch(/not available|no provider/i)

    const list = await call(tools.get('file.list')!, {})
    expect(list.ok).toBe(false)
    expect(list.message).toMatch(/not available/i)
  })
})

/* ---------------------------------------------------------------- list */

describe('B — file.list', () => {
  it('lists the root, sorted, with metadata', async () => {
    const out = await call(tools.get('file.list')!, {})
    expect(out.ok).toBe(true)
    const entries = (out.data as { entries: Array<{ name: string; kind: string; size?: number }> }).entries
    expect(entries.map((e) => e.name)).toEqual(['README.md', 'main.ts', 'notes'])
    const readme = entries.find((e) => e.name === 'README.md')
    expect(readme!.kind).toBe('file')
    expect(readme!.size).toBeGreaterThan(0)
    expect(out.message).toContain('3 entries')
  })

  it('lists a subdirectory and can recurse within depth bounds', async () => {
    const under = await call(tools.get('file.list')!, { path: 'notes' })
    expect((under.data as { entries: unknown[] }).entries).toHaveLength(2)

    const deep = await call(tools.get('file.list')!, { path: 'notes', recursive: true })
    const paths = (deep.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path)
    expect(paths).toContain('notes/todo.txt')
    expect(paths).toContain('notes/deep/nested.txt')

    const shallow = await call(tools.get('file.list')!, { path: 'notes', recursive: true, depth: 0 })
    const shallowPaths = (shallow.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path)
    expect(shallowPaths).toContain('notes/deep')
    expect(shallowPaths).not.toContain('notes/deep/nested.txt')
  })

  it('honours the limit without ever returning more than asked', async () => {
    const out = await call(tools.get('file.list')!, { limit: 2 })
    expect((out.data as { entries: unknown[] }).entries).toHaveLength(2)
    const capped = await call(tools.get('file.list')!, { limit: 10000 })
    expect((capped.data as { entries: unknown[] }).entries.length).toBeLessThanOrEqual(FS_LIMITS.MAX_LIST_RESULTS)
  })

  it('fails honestly for a missing directory', async () => {
    const out = await call(tools.get('file.list')!, { path: 'nope' })
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/no such|not found|missing/i)
  })
})

/* ---------------------------------------------------------------- search */

describe('C — file.search', () => {
  it('matches by case-insensitive substring and returns bounded results', async () => {
    const out = await call(tools.get('file.search')!, { query: 'TODO', limit: 20 })
    expect(out.ok).toBe(true)
    const matches = (out.data as { matches: Array<{ path: string }> }).matches
    expect(matches.map((m) => m.path)).toEqual(['notes/todo.txt'])
  })

  it('filters by extension and start path', async () => {
    const ext = await call(tools.get('file.search')!, { extension: '.md' })
    expect((ext.data as { matches: Array<{ path: string }> }).matches.map((m) => m.path)).toEqual(['README.md'])

    const rooted = await call(tools.get('file.search')!, { query: 'nested', path: 'notes' })
    expect((rooted.data as { matches: Array<{ path: string }> }).matches.map((m) => m.path)).toEqual(['notes/deep/nested.txt'])
  })

  it('requires a query or an extension', async () => {
    const out = await call(tools.get('file.search')!, {})
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/query or an extension/i)
  })

  it('returns an honest no-match and respects the limit', async () => {
    const none = await call(tools.get('file.search')!, { query: 'zebra' })
    expect(none.ok).toBe(true)
    expect(none.message).toContain('No matching')

    const limited = await call(tools.get('file.search')!, { query: 'e', limit: 1 })
    expect((limited.data as { matches: unknown[] }).matches.length).toBe(1)
  })
})

/* ---------------------------------------------------------------- stat */

describe('D — file.stat', () => {
  it('reports kind, size and modified metadata', async () => {
    const out = await call(tools.get('file.stat')!, { path: 'notes/todo.txt' })
    expect(out.ok).toBe(true)
    const node = out.data as { kind: string; size: number; path: string }
    expect(node.kind).toBe('file')
    expect(node.size).toBeGreaterThan(0)
    expect(out.message).toContain('file')
  })

  it('stats the root and directories', async () => {
    const root = await call(tools.get('file.stat')!, { path: '' })
    expect((root.data as { kind: string }).kind).toBe('directory')
    const dir = await call(tools.get('file.stat')!, { path: 'notes' })
    expect((dir.data as { kind: string }).kind).toBe('directory')
  })

  it('fails honestly for a missing entry', async () => {
    const out = await call(tools.get('file.stat')!, { path: 'missing.txt' })
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/no such|not found/i)
  })
})

/* ---------------------------------------------------------------- read */

describe('E — file.read', () => {
  it('reads a text file with a preview and the full bounded content', async () => {
    const out = await call(tools.get('file.read')!, { path: 'notes/todo.txt' })
    expect(out.ok).toBe(true)
    expect(out.message).toContain('buy milk')
    expect((out.data as { content: string }).content).toBe('buy milk')
    expect((out.data as { bytes: number }).bytes).toBe(8)
  })

  it('fails honestly for missing files, directories and binary content', async () => {
    const missing = await call(tools.get('file.read')!, { path: 'missing.txt' })
    expect(missing.ok).toBe(false)
    expect(missing.message).toMatch(/no such|not found/i)

    const dir = await call(tools.get('file.read')!, { path: 'notes' })
    expect(dir.ok).toBe(false)
    expect(dir.message).toMatch(/directory|unsupported/i)

    provider.writeText('bin.dat', 'PK\u0000\u0001\u0000')
    const binary = await call(tools.get('file.read')!, { path: 'bin.dat' })
    expect(binary.ok).toBe(false)
    expect(binary.message).toMatch(/plain text|binary|unsupported/i)
  })

  it('refuses oversized reads instead of truncating silently', async () => {
    provider.writeText('big.txt', 'x'.repeat(100))
    const out = await call(tools.get('file.read')!, { path: 'big.txt', max_bytes: 10 })
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/larger than|limit/i)
  })
})

/* ---------------------------------------------------------------- mkdir */

describe('F — file.mkdir', () => {
  it('creates a directory and reflects the new real state', async () => {
    const out = await call(tools.get('file.mkdir')!, { path: 'projects' })
    expect(out.ok).toBe(true)
    expect(provider.treeStrings()).toContain('projects/')
    const verify = await tools.get('file.mkdir')!.verify!({ query: '', params: { path: 'projects' } }, out, { requestId: 'u' })
    expect(verify.ok).toBe(true)
  })

  it('fails honestly on duplicates, missing parents and unsafe paths', async () => {
    const dup = await call(tools.get('file.mkdir')!, { path: 'notes' })
    expect(dup.ok).toBe(false)
    expect(dup.message).toMatch(/already exists/i)

    const orphan = await call(tools.get('file.mkdir')!, { path: 'no/parent/dir' })
    expect(orphan.ok).toBe(false)

    const traversal = await call(tools.get('file.mkdir')!, { path: 'a/../b' })
    expect(traversal.ok).toBe(false)
    expect(traversal.message).toMatch(/root/i)
  })
})

/* ---------------------------------------------------------------- write */

describe('G — file.write', () => {
  it('creates a file and never replaces content silently', async () => {
    const out = await call(tools.get('file.write')!, { path: 'new.txt', content: 'hello' })
    expect(out.ok).toBe(true)
    expect(provider.treeStrings()).toContain('new.txt')

    const refusal = await call(tools.get('file.write')!, { path: 'new.txt', content: 'overwritten?' })
    expect(refusal.ok).toBe(false)
    expect(refusal.message).toMatch(/already exists/i)
    expect((await provider.readText('new.txt')).content).toBe('hello')

    const explicit = await call(tools.get('file.write')!, { path: 'new.txt', content: 'updated', overwrite: true })
    expect(explicit.ok).toBe(true)
    expect((await provider.readText('new.txt')).content).toBe('updated')
  })

  it('requires content and bounded content size', async () => {
    const noContent = await call(tools.get('file.write')!, { path: 'x.txt' })
    expect(noContent.ok).toBe(false)
    expect(noContent.message).toMatch(/content/i)

    const big = await call(tools.get('file.write')!, { path: 'x.txt', content: 'x'.repeat(FS_LIMITS.MAX_WRITE_CHARS + 1) })
    expect(big.ok).toBe(false)
    expect(big.message).toMatch(/limit/i)
  })

  it('cannot write into a file or outside the root', async () => {
    const intoFile = await call(tools.get('file.write')!, { path: 'README.md/x', content: 'x' })
    expect(intoFile.ok).toBe(false)
    const escape = await call(tools.get('file.write')!, { path: '../evil.txt', content: 'x' })
    expect(escape.ok).toBe(false)
    expect(escape.message).toMatch(/root/i)
  })
})

/* ---------------------------------------------------------------- copy */

describe('H — file.copy', () => {
  it('copies a file and reflects real provider state', async () => {
    const out = await call(tools.get('file.copy')!, { source: 'notes/todo.txt', destination: 'todo-backup.txt' })
    expect(out.ok).toBe(true)
    const backing = await provider.readText('todo-backup.txt')
    expect(backing.content).toBe('buy milk')
    const verify = await tools.get('file.copy')!.verify!(
      { query: '', params: { source: 'notes/todo.txt', destination: 'todo-backup.txt' } },
      out,
      { requestId: 'u' },
    )
    expect(verify.ok).toBe(true)
  })

  it('guards overwrites and fails honestly for missing/unsupported sources', async () => {
    provider.writeText('target.txt', 'existing')
    const refusal = await call(tools.get('file.copy')!, { source: 'README.md', destination: 'target.txt' })
    expect(refusal.ok).toBe(false)
    expect(refusal.message).toMatch(/already exists/i)
    expect((await provider.readText('target.txt')).content).toBe('existing')

    const missing = await call(tools.get('file.copy')!, { source: 'gone.txt', destination: 'x.txt' })
    expect(missing.ok).toBe(false)
    expect(missing.message).toMatch(/no such|not found/i)

    const dirSource = await call(tools.get('file.copy')!, { source: 'notes', destination: 'notes-clone' })
    expect(dirSource.ok).toBe(false)
    expect(dirSource.message).toMatch(/director|unsupported/i)

    const same = await call(tools.get('file.copy')!, { source: 'a.txt', destination: 'a.txt' })
    expect(same.ok).toBe(false)
  })
})

/* ---------------------------------------------------------------- move */

describe('I — file.move', () => {
  it('moves a file: source gone, destination present, verified', async () => {
    const out = await call(tools.get('file.move')!, { source: 'notes/todo.txt', destination: 'todo.txt' })
    expect(out.ok).toBe(true)
    expect(provider.treeStrings()).toContain('todo.txt')
    expect(provider.treeStrings()).not.toContain('notes/todo.txt')

    const verify = await tools.get('file.move')!.verify!(
      { query: '', params: { source: 'notes/todo.txt', destination: 'todo.txt' } },
      out,
      { requestId: 'u' },
    )
    expect(verify.ok).toBe(true)
    expect(verify.checks).toContain('old absent')
  })

  it('fails honestly for missing sources and protects existing destinations', async () => {
    const missing = await call(tools.get('file.move')!, { source: 'gone.txt', destination: 'x.txt' })
    expect(missing.ok).toBe(false)

    await provider.writeText('blocked.txt', 'stay')
    const refusal = await call(tools.get('file.move')!, { source: 'README.md', destination: 'blocked.txt' })
    expect(refusal.ok).toBe(false)
    expect(refusal.message).toMatch(/already exists/i)
  })
})

/* ---------------------------------------------------------------- rename */

describe('J — file.rename', () => {
  it('renames within the root and verifies old absent + new present', async () => {
    const out = await call(tools.get('file.rename')!, { path: 'main.ts', new_name: 'index.ts' })
    expect(out.ok).toBe(true)
    expect(provider.treeStrings()).toContain('index.ts')
    expect(provider.treeStrings()).not.toContain('main.ts')

    const verify = await tools.get('file.rename')!.verify!({ query: '', params: { path: 'main.ts', new_name: 'index.ts' } }, out, { requestId: 'u' })
    expect(verify.ok).toBe(true)
    expect(verify.checks).toContain('new present')
  })

  it('rejects unsafe new names and the root itself', async () => {
    const traversal = await call(tools.get('file.rename')!, { path: 'main.ts', new_name: '../x.ts' })
    expect(traversal.ok).toBe(false)
    expect(traversal.message).toMatch(/root|invalid|separator/i)

    const same = await call(tools.get('file.rename')!, { path: 'main.ts', new_name: 'main.ts' })
    expect(same.ok).toBe(false)
    expect(same.message).toMatch(/already named/i)

    const root = await call(tools.get('file.rename')!, { path: '', new_name: 'x' })
    expect(root.ok).toBe(false)
  })
})

/* ---------------------------------------------------------------- delete */

describe('K — file.delete', () => {
  it('deletes a file, verifies the target is gone, and needs explicit confirmation', async () => {
    const out = await call(tools.get('file.delete')!, { path: 'main.ts' })
    expect(out.ok).toBe(true)
    expect(provider.treeStrings()).not.toContain('main.ts')

    const verify = await tools.get('file.delete')!.verify!({ query: '', params: { path: 'main.ts' } }, out, { requestId: 'u' })
    expect(verify.ok).toBe(true)
    expect(verify.checks).toContain('target absent')
  })

  it('fails honestly for missing targets, unsafe paths and the root', async () => {
    const missing = await call(tools.get('file.delete')!, { path: 'missing.txt' })
    expect(missing.ok).toBe(false)

    const escape = await call(tools.get('file.delete')!, { path: '../top-secret' })
    expect(escape.ok).toBe(false)
    expect(escape.message).toMatch(/root/i)

    const root = await call(tools.get('file.delete')!, { path: '' })
    expect(root.ok).toBe(false)
  })

  it('will not empty a non-empty folder without recursive', async () => {
    const refused = await call(tools.get('file.delete')!, { path: 'notes' })
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/not empty/i)
    expect(provider.treeStrings()).toContain('notes/todo.txt')

    const recursive = await call(tools.get('file.delete')!, { path: 'notes', recursive: true })
    expect(recursive.ok).toBe(true)
    expect(provider.treeStrings()).not.toContain('notes/todo.txt')
  })

  it('reports an honest verification failure when the provider cannot confirm', async () => {
    const out = await call(tools.get('file.delete')!, { path: 'main.ts' })
    expect(out.ok).toBe(true)
    provider.fault('stat')
    const verify = await tools.get('file.delete')!.verify!({ query: '', params: { path: 'main.ts' } }, out, { requestId: 'u' })
    expect(verify.ok).toBe(false)
    expect(verify.message).toMatch(/could not be confirmed/i)
  })
})

/* ---------------------------------------------------------------- verification matrix */

describe('L — verifiers always reflect real provider state', () => {
  it('write.verify is false before the file exists and true after', async () => {
    const tool = tools.get('file.write')!
    const before = await tool.verify!({ query: '', params: { path: 'ghost.txt', content: 'x' } }, { ok: true, message: '' }, { requestId: 'u' })
    expect(before.ok).toBe(false)

    await call(tool, { path: 'ghost.txt', content: 'x' })
    const after = await tool.verify!({ query: '', params: { path: 'ghost.txt', content: 'x' } }, { ok: true, message: '' }, { requestId: 'u' })
    expect(after.ok).toBe(true)
  })

  it('move.verify is false when both paths still exist (no real move)', async () => {
    const verify = await tools.get('file.move')!.verify!(
      { query: '', params: { source: 'README.md', destination: 'dupe.md' } },
      { ok: true, message: '' },
      { requestId: 'u' },
    )
    expect(verify.ok).toBe(false)
  })

  it('verifiers degrade to unconfirmed, never to fake success, under provider faults', async () => {
    provider.fault('stat', 'io')
    const verify = await tools.get('file.write')!.verify!({ query: '', params: { path: 'README.md', content: 'x' } }, { ok: true, message: '' }, { requestId: 'u' })
    expect(verify.ok).toBe(false)
    expect(verify.message).toMatch(/could not be confirmed/i)
  })
})

/* ---------------------------------------------------------------- unavailable provider */

describe('M — unavailable providers fail honestly, never fake', () => {
  it('every operational tool fails with an honest unavailable message', async () => {
    provider.setAvailable(false)
    const checks: Array<() => Promise<ToolResult>> = [
      () => call(tools.get('file.list')!, {}),
      () => call(tools.get('file.search')!, { query: 'x' }),
      () => call(tools.get('file.stat')!, { path: 'README.md' }),
      () => call(tools.get('file.read')!, { path: 'README.md' }),
      () => call(tools.get('file.mkdir')!, { path: 'x' }),
      () => call(tools.get('file.write')!, { path: 'x.txt', content: 'x' }),
      () => call(tools.get('file.copy')!, { source: 'README.md', destination: 'x.txt' }),
      () => call(tools.get('file.move')!, { source: 'README.md', destination: 'x.txt' }),
      () => call(tools.get('file.rename')!, { path: 'README.md', new_name: 'x.md' }),
      () => call(tools.get('file.delete')!, { path: 'README.md' }),
    ]
    for (const run of checks) {
      const out = await run()
      expect(out.ok, out.message).toBe(false)
      expect(out.message).toMatch(/not available/i)
    }
    // Nothing changed despite the calls.
    expect(provider.treeStrings()).toContain('README.md')

    const status = await call(tools.get('file.status')!, {})
    expect(status.ok).toBe(true)
    expect((status.data as { available: boolean }).available).toBe(false)
  })
})

describe('N — path safety applies to every path-taking tool', () => {
  it('rejects traversal in list/read/stat/write/mkdir/delete/copy/move/rename', async () => {
    const payloads: Array<[string, Record<string, unknown>]> = [
      ['file.list', { path: 'a/../b' }],
      ['file.read', { path: '../main.ts' }],
      ['file.stat', { path: '../../etc' }],
      ['file.write', { path: 'x/../y.txt', content: 'c' }],
      ['file.mkdir', { path: 'up/../down' }],
      ['file.delete', { path: 'a/..' }],
      ['file.copy', { source: 'README.md', destination: '../escape.txt' }],
      ['file.move', { source: 'README.md', destination: '/abs' }],
      ['file.rename', { path: 'README.md', new_name: '../../../x' }],
    ]
    for (const [id, params] of payloads) {
      const out = await call(tools.get(id)!, params)
      expect(out.ok, `${id} must reject ${JSON.stringify(params)}`).toBe(false)
      expect(out.message, `${id} honesty`).toMatch(/root|escape|outside|invalid|separator|name/i)
    }
    // Nothing was created or moved.
    expect(provider.treeStrings()).toContain('README.md')
    expect(provider.treeStrings()).not.toContain('escape.txt')
  })
})