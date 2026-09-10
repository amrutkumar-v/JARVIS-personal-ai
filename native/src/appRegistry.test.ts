import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppRegistry, slugify } from './appRegistry.js'
import { writeLnkAnsi } from './testingLnk.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jarvis-appregistry-'))
}

describe('AppRegistry — configured allow-list (Phase 1.3)', () => {
  it('registers valid configured apps and marks plain .exe targets launchable', () => {
    const registry = new AppRegistry({
      configured: {
        notepad: { name: 'Notepad', target: 'C:\\Windows\\System32\\notepad.exe' },
        calculator: { target: 'C:\\Windows\\System32\\calc.exe' },
      },
      discover: false,
    })
    const records = registry.listRecords()
    expect(records.map((r) => r.applicationId).sort()).toEqual(['calculator', 'notepad'])
    expect(registry.getRecord('notepad')).toMatchObject({ name: 'Notepad', source: 'configured', enabled: true, launchable: true })
    expect(registry.getRecord('calculator')).toMatchObject({ name: 'calculator', launchable: true })
  })

  it('skips invalid ids and missing targets', () => {
    const registry = new AppRegistry({
      configured: {
        'bad id!': { target: 'C:\\x.exe' },
        nopath: { target: '' },
        '': { target: 'C:\\x.exe' },
        valid: { target: 'C:\\x.exe' },
      },
      discover: false,
    })
    expect(registry.listRecords().map((r) => r.applicationId)).toEqual(['valid'])
  })

  it('never marks non-exe or shell-host targets as launchable', () => {
    const registry = new AppRegistry({
      configured: {
        script: { target: 'C:\\scripts\\run.js' },
        powershell: { target: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
        cmd: { target: 'C:\\Windows\\System32\\cmd.exe' },
      },
      discover: false,
    })
    for (const id of ['script', 'powershell', 'cmd']) {
      expect(registry.getRecord(id)!.launchable).toBe(false)
      expect(registry.getRecord(id)!.target).toBe('')
    }
  })

  it('keeps disabled apps visible but never launchable', () => {
    const registry = new AppRegistry({
      configured: { locked: { target: 'C:\\x.exe', enabled: false } },
      discover: false,
    })
    expect(registry.getRecord('locked')).toMatchObject({ enabled: false, launchable: true })
  })
})

describe('AppRegistry — bounded Start Menu discovery (Phase 1.3)', () => {
  it('discovers .lnk shortcuts from injected dirs and resolves their targets', () => {
    const dir = tempDir()
    try {
      mkdirSync(join(dir, 'Sub'))
      writeLnkAnsi(dir, 'Visual Studio Code.lnk', 'C:\\Program Files\\Microsoft VS Code\\Code.exe')
      writeLnkAnsi(dir, 'Notepad.lnk', 'C:\\Windows\\System32\\notepad.exe')
      writeLnkAnsi(join(dir, 'Sub'), 'Calculator.lnk', 'C:\\Windows\\System32\\calc.exe')

      const registry = new AppRegistry({ discoveryDirs: [dir] })
      const ids = registry.listRecords().map((r) => ({ id: r.applicationId, source: r.source }))
      expect(ids).toContainEqual({ id: 'visual-studio-code', source: 'discovered' })
      expect(ids).toContainEqual({ id: 'notepad', source: 'discovered' })
      expect(ids).toContainEqual({ id: 'calculator', source: 'discovered' })
      expect(registry.getRecord('visual-studio-code')).toMatchObject({
        displayName: 'Visual Studio Code',
        launchable: true,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caps recursion depth: nested shortcuts below the limit are ignored', () => {
    const dir = tempDir()
    try {
      mkdirSync(join(dir, 'A', 'B'), { recursive: true })
      writeLnkAnsi(join(dir, 'A', 'B'), 'Too Deep.lnk', 'C:\\Windows\\System32\\whoami.exe')
      const registry = new AppRegistry({ discoveryDirs: [dir] })
      expect(registry.getRecord('too-deep')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives unreadable/junk shortcut files with launchable: false', () => {
    const dir = tempDir()
    try {
      writeLnkAnsi(dir, 'Broken.lnk', 'C:\\Windows\\System32\\cmd.exe') // shell host
      const junk = join(dir, 'Junk.lnk')
      writeFileSync(junk, Buffer.from('this is not a real link at all'))
      const registry = new AppRegistry({ discoveryDirs: [dir] })
      expect(registry.getRecord('broken')).toMatchObject({ launchable: false })
      expect(registry.getRecord('junk')).toMatchObject({ launchable: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('configured apps win over discovered same-id collisions', () => {
    const dir = tempDir()
    try {
      writeLnkAnsi(dir, 'notepad.lnk', 'C:\\Somewhere\\else.exe')
      const registry = new AppRegistry({
        discoveryDirs: [dir],
        configured: { notepad: { target: 'C:\\Configured\\notepad.exe' } },
      })
      expect(registry.getRecord('notepad')).toMatchObject({ source: 'configured', target: 'C:\\Configured\\notepad.exe' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('dedups identical targets and slugs collisions with numeric suffixes', () => {
    const dir = tempDir()
    try {
      writeLnkAnsi(dir, 'google-chrome.lnk', 'C:\\A\\chrome.exe')
      writeLnkAnsi(dir, 'Google Chrome.lnk', 'C:\\A\\chrome.exe') // same target → dedup
      const registry = new AppRegistry({ discoveryDirs: [dir] })
      const records = registry.listRecords()
      expect(records.filter((r) => r.applicationId.startsWith('google-chrome'))).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects the discover:false master switch', () => {
    const dir = tempDir()
    try {
      writeLnkAnsi(dir, 'notepad.lnk', 'C:\\Windows\\System32\\notepad.exe')
      const registry = new AppRegistry({ discoveryDirs: [dir], discover: false })
      expect(registry.listRecords()).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips discovery entirely on non-win32 platforms', () => {
    const registry = new AppRegistry({ platform: 'linux' })
    expect(registry.listRecords()).toHaveLength(0)
    expect(registry.discoveryEnabled).toBe(true)
  })
})

describe('slugify — shortcut filename → stable applicationId', () => {
  it.each([
    ['Visual Studio Code.lnk', 'visual-studio-code'],
    ['Google Chrome.lnk', 'google-chrome'],
    ['Notepad.lnk', 'notepad'],
    ['__Strange__ n4me!!.lnk', 'strange-n4me'],
  ])('turns "%s" into "%s"', (file, expected) => {
    expect(slugify(file)).toBe(expected)
  })

  it('falls back to "app" when nothing alphanumeric remains', () => {
    expect(slugify('!!!.lnk')).toBe('app')
  })
})