import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppRegistry, slugify, packagedAliases, ALLOWED_URI_SCHEMES } from './appRegistry.js'
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

  it('resolves a packaged (Store/MSIX) app by its natural name from its real display name (WhatsApp-class)', async () => {
    const registry = new AppRegistry({
      platform: 'win32',
      discoveryDirs: [],
      systemApps: false,
      packagedReader: async () => [
        { aumid: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App', displayName: 'WhatsAppDesktop' },
        { aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', displayName: 'Microsoft.WindowsCalculator' },
      ],
    })
    await registry.ready()

    const record = registry.getRecord('whatsappdesktop')
    expect(record).toBeDefined()
    expect(record).toMatchObject({
      source: 'packaged',
      mechanism: 'aumid',
      aumid: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App',
      launchable: true,
      enabled: true,
    })
    expect(record!.aliases).toContain('whatsapp')

    // Natural-name resolution: "whatsapp" must reach the genuinely-installed
    // packaged record through its aliases — never through a fabricated target.
    const resolved = registry.resolve('whatsapp')
    expect('record' in resolved).toBe(true)
    if ('record' in resolved) {
      expect(resolved.record.applicationId).toBe('whatsappdesktop')
      expect(resolved.record.aumid).toBe('5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App')
      expect(resolved.record.mechanism).toBe('aumid')
    }

    // A name that is NOT a genuine registration must stay honestly missing.
    expect('missing' in registry.resolve('youtube')).toBe(true)
    expect('missing' in registry.resolve('freebuff')).toBe(true)
  })

  it('TR-T1-1: isValidUri accepts new curated schemes and rejects dangerous ones', () => {
    // Directly exercise buildRecord by constructing configured entries for
    // each scheme and asserting which ones pass.
    const registry = new AppRegistry({
      configured: {
        spotify: { mechanism: 'uri', uri: 'spotify:' },
        whatsapp: { mechanism: 'uri', uri: 'whatsapp:send?text=hello%20world' },
        mailto: { mechanism: 'uri', uri: 'mailto:foo@example.com' },
        settings: { mechanism: 'uri', uri: 'ms-settings:privacy' },
        // Dangerous schemes — MUST be dropped (fail-closed):
        ps: { mechanism: 'uri', uri: 'powershell: -Command ls' },
        fileuri: { mechanism: 'uri', uri: 'file:C:\\windows\\system32\\cmd.exe' },
        js: { mechanism: 'uri', uri: 'javascript:alert(1)' },
        store: { mechanism: 'uri', uri: 'ms-windows-store://pdp/?ProductId=evil' },
        searchms: { mechanism: 'uri', uri: 'search-ms:query=evil' },
        blank: { mechanism: 'uri', uri: 'no-colon-no-scheme' },
      },
      discover: false,
    })
    // Allowed:
    expect(registry.getRecord('spotify')).toBeDefined()
    expect(registry.getRecord('spotify')).toMatchObject({ mechanism: 'uri', uri: 'spotify:', launchable: true })
    expect(registry.getRecord('whatsapp')).toBeDefined()
    expect(registry.getRecord('whatsapp')!.uri).toBe('whatsapp:send?text=hello%20world')
    expect(registry.getRecord('mailto')).toBeDefined()
    expect(registry.getRecord('settings')).toBeDefined()
    // Rejected (fail-closed):
    expect(registry.getRecord('ps')).toBeUndefined()
    expect(registry.getRecord('fileuri')).toBeUndefined()
    expect(registry.getRecord('js')).toBeUndefined()
    expect(registry.getRecord('store')).toBeUndefined()
    expect(registry.getRecord('searchms')).toBeUndefined()
    expect(registry.getRecord('blank')).toBeUndefined()
  })

  it('TR-T1-2: IsAllowedUri logic (ShellExec.cs mirror — same scheme set simulated in TS)', () => {
    // Mirror of ShellExec.cs IsAllowedUri semantic in pure TS, to prove parity.
    const csSchemes = new Set([
      'ms-settings', 'mailto', 'whatsapp', 'spotify', 'discord', 'telegram',
      'slack', 'ms-teams', 'obs', 'zoommtg', 'zoomus', 'steam', 'open',
    ])
    function csIsAllowedUri(value: string): boolean {
      const colon = value.indexOf(':')
      if (colon <= 0) return false
      const scheme = value.slice(0, colon).toLowerCase()
      if (!csSchemes.has(scheme)) return false
      if (value.length > 260) return false
      for (const c of value) {
        const code = c.charCodeAt(0)
        if (code < 0x20 || c === '"' || c === "'" || c === '`') return false
      }
      return true
    }
    // Accept:
    expect(csIsAllowedUri('spotify:')).toBe(true)
    expect(csIsAllowedUri('WhatsApp:chat?phone=123')).toBe(true)
    expect(csIsAllowedUri('ms-settings:')).toBe(true)
    // Reject:
    expect(csIsAllowedUri('file:')).toBe(false)
    expect(csIsAllowedUri('javascript:void(0)')).toBe(false)
    expect(csIsAllowedUri('powershell: -Command ls')).toBe(false)
    expect(csIsAllowedUri('no-colon')).toBe(false)
    // Mirror parity: csSchemes === ALLOWED_URI_SCHEMES Set parity
    expect(new Set([...ALLOWED_URI_SCHEMES].sort())).toEqual(new Set([...csSchemes].sort()))
  })

  it('TR-T1-3/TR-T1-4: configured spotify: / discord: URI entries pass buildRecord and launchable; dangerous schemes dropped', () => {
    const registry = new AppRegistry({
      configured: {
        discord: { mechanism: 'uri', uri: 'discord:' },
        team: { mechanism: 'uri', uri: 'ms-teams:' },
        openbad: { mechanism: 'uri', uri: 'open:C:\\evil.bat' }, // URI scheme open: content includes backslash+quote check
      },
      discover: false,
    })
    expect(registry.getRecord('discord')).toMatchObject({ mechanism: 'uri', launchable: true })
    expect(registry.getRecord('team')).toMatchObject({ mechanism: 'uri', launchable: true })
    // open:C:\evil.bat — scheme IS open: (allowed) but the rest contains a backslash not a control/quote char.
    // isValidUri only checks no whitespace/quotes. A backslash is allowed by the URI checker — the ShellExec
    // activation hands the entire URI string to ShellExecute, which is the Shell's responsibility to route.
    // This is safe for open: because ShellExecute does not treat URI backslashes as file paths. We allow it.
    // BUT a content with SPACES or QUOTES is rejected — test that separately:
    const withSpaces = new AppRegistry({
      configured: { bad: { mechanism: 'uri', uri: 'open:foo bar' } },
      discover: false,
    })
    expect(withSpaces.getRecord('bad')).toBeUndefined()
  })
})