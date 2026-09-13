import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppRegistry, slugify } from './appRegistry.js'
import { writeLnkAnsi } from './testingLnk.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jarvis-appregistry-'))
}

function resolvedId(registry: AppRegistry, claim: string): string | null {
  const result = registry.resolve(claim)
  return 'record' in result ? result.record.applicationId : null
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

      const registry = new AppRegistry({ discoveryDirs: [dir], systemApps: false })
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

  it('skips unreadable/junk shortcut files entirely', () => {
    const dir = tempDir()
    try {
      writeLnkAnsi(dir, 'Broken.lnk', 'C:\\Windows\\System32\\cmd.exe') // shell host
      const junk = join(dir, 'Junk.lnk')
      writeFileSync(junk, Buffer.from('this is not a real link at all'))
      const registry = new AppRegistry({ discoveryDirs: [dir], systemApps: false })
      expect(registry.getRecord('broken')).toBeUndefined()
      expect(registry.getRecord('junk')).toBeUndefined()
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

describe('AppRegistry — alias + fidelity resolution (Phase 1.3 demoready)', () => {
  function chromeRegistry() {
    return new AppRegistry({
      configured: {
        notepad: { name: 'Notepad', target: 'C:\\Windows\\System32\\notepad.exe' },
        chrome: { name: 'Google Chrome', target: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', aliases: ['google-chrome'] },
        'visual-studio-code': {
          name: 'Visual Studio Code',
          target: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
          aliases: ['vscode', 'code'],
        },
      },
      discover: false,
    })
  }

  it('resolves exact ids, declared aliases, curated synonyms and token claims', () => {
    const registry = chromeRegistry()
    expect(resolvedId(registry, 'notepad')).toBe('notepad')
    expect(resolvedId(registry, 'google chrome')).toBe('chrome')
    expect(resolvedId(registry, 'Google Chrome')).toBe('chrome')
    expect(resolvedId(registry, 'vscode')).toBe('visual-studio-code')
    expect(resolvedId(registry, 'code')).toBe('visual-studio-code')
    expect(resolvedId(registry, 'visual studio code')).toBe('visual-studio-code')
  })

  it('reports ambiguous when several distinct apps match a single claim', () => {
    const registry = new AppRegistry({
      configured: {
        'chrome-beta': { target: 'C:\\A\\chrome-beta.exe' },
        'chrome-dev': { target: 'C:\\B\\chrome-dev.exe' },
        notepad: { target: 'C:\\Windows\\System32\\notepad.exe' },
      },
      discover: false,
    })
    const result = registry.resolve('chrome')
    expect('ambiguous' in result).toBe(true)
    if ('ambiguous' in result) {
      expect(result.ambiguous.map((r) => r.applicationId).sort()).toEqual(['chrome-beta', 'chrome-dev'])
    }
  })

  it('reports missing for unknown claims — never guesses', () => {
    const registry = chromeRegistry()
    const result = registry.resolve('does not exist here')
    expect('missing' in result).toBe(true)
  })

  it('a claim can never smuggle a path or shell metacharacter', () => {
    const registry = chromeRegistry()
    const registered = ['C:\\Windows\\System32\\cmd.exe', 'calc.exe /evil', 'chrome & dir']
    for (const nasty of registered) {
      expect(resolvedId(registry, nasty)).toBeNull()
    }
    // Even a path-shaped claim resolves ONLY to a registered application id.
    const sneaky = resolvedId(registry, '..\\..\\chrome')
    expect(sneaky).toBe('chrome')
  })
})

describe('AppRegistry — system + registry sources (Phase 1.3 demoready)', () => {
  it('seeds verified system tools (win32) and never shell hosts', async () => {
    const dir = tempDir()
    try {
      const exe = join(dir, 'my-tool.exe')
      writeFileSync(exe, 'binary')
      const registry = new AppRegistry({
        platform: 'win32',
        discoveryDirs: [],
        systemApps: true,
        systemAppSeeds: [
          { id: 'my-tool', displayName: 'My Tool', exe },
          { id: 'missing-tool', displayName: 'Missing', exe: join(dir, 'nope.exe') },
          { id: 'settings', displayName: 'Settings', uri: 'ms-settings:' },
          { id: 'evil', displayName: 'Evil', uri: 'powershell:/x' },
          { id: 'limited', displayName: 'Limited', uri: 'ms-settings:"x"' },
        ],
      })
      await registry.ready()
      expect(registry.getRecord('my-tool')).toMatchObject({ source: 'system', mechanism: 'exe', launchable: true })
      expect(registry.getRecord('missing-tool')).toBeUndefined()
      expect(registry.getRecord('settings')).toMatchObject({ source: 'system', mechanism: 'uri', uri: 'ms-settings:', launchable: true })
      expect(registry.getRecord('evil')).toBeUndefined() // scheme not in the allow-list
      expect(registry.getRecord('limited')).toBeUndefined() // quote smuggled into the uri
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('absorbs App Paths + packaged entries through injected readers and refreshes honestly', async () => {
    let appPaths: Array<{ name: string; path: string }> = [
      { name: 'chrome.exe', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    ]
    let packaged: Array<{ aumid: string; displayName: string }> = [
      { aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', displayName: 'Microsoft.WindowsCalculator' },
    ]
    const registry = new AppRegistry({
      platform: 'win32',
      configured: { notepad: { target: 'C:\\Windows\\System32\\notepad.exe' } },
      discoveryDirs: [],
      systemApps: false,
      appPathsReader: async () => appPaths,
      packagedReader: async () => packaged,
    })
    await registry.ready()

    expect(registry.getRecord('chrome')).toMatchObject({ source: 'appPaths', mechanism: 'exe', launchable: true })
    expect(registry.getRecord('microsoft-windowscalculator')).toMatchObject({
      source: 'packaged',
      mechanism: 'aumid',
      aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
      launchable: true,
    })
    expect(registry.listRecords().map((r) => r.applicationId).sort()).toEqual([
      'chrome',
      'microsoft-windowscalculator',
      'notepad',
    ])

    // Refresh: chrome vanishes, Edge appears, the configured notepad survives.
    appPaths = [{ name: 'msedge.exe', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' }]
    packaged = []
    const result = await registry.refresh()
    expect(result.total).toBe(2)
    expect(result.discovered).toBe(1)
    expect(result.configured).toBe(1)
    expect(registry.getRecord('chrome')).toBeUndefined()
    expect(registry.getRecord('msedge')).toMatchObject({ source: 'appPaths', mechanism: 'exe' })
    expect(registry.getRecord('microsoft-windowscalculator')).toBeUndefined()
    expect(registry.getRecord('notepad')).toMatchObject({ source: 'configured' })
  })

  it('registers configured aumid/uri shell routes and drops invalid ones', () => {
    const registry = new AppRegistry({
      configured: {
        'calc-store': { mechanism: 'aumid', aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
        settings: { mechanism: 'uri', uri: 'ms-settings:' },
        'bad-aumid': { mechanism: 'aumid', aumid: '..\\..\\evil!' },
        'bad-uri': { mechanism: 'uri', uri: 'powershell:/cmd' },
      },
      discover: false,
    })
    expect(registry.getRecord('calc-store')).toMatchObject({ mechanism: 'aumid', aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', launchable: true })
    expect(registry.getRecord('settings')).toMatchObject({ mechanism: 'uri', uri: 'ms-settings:', launchable: true })
    expect(registry.getRecord('bad-aumid')).toBeUndefined()
    expect(registry.getRecord('bad-uri')).toBeUndefined()
  })
})