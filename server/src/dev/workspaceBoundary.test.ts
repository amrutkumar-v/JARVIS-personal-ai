/**
 * CRIT-01 Remediation Regression Test Suite.
 *
 * Verifies strict workspace boundary enforcement in DevEngine and workspaceBoundary:
 *  - Valid authorized project paths (legitimate access)
 *  - Unauthorized absolute paths
 *  - C:\Windows and sensitive system directories
 *  - User SSH directories
 *  - Startup directories
 *  - Relative traversal using ../ and Windows equivalents
 *  - UNC and Win32 device namespace paths
 *  - Alternate drive paths
 *  - Symlink escapes
 *  - Directory junction escapes
 *  - Case-insensitive Windows path handling
 *  - Similar-prefix directory attacks (workspace-evil)
 *  - Nonexistent paths (inside vs outside, ensure true vs false)
 *  - Invalid and malformed paths
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  normalizeProjectPath,
  isUncOrDevicePath,
  isAbsoluteProjectPath,
  isPathInsideRoot,
  isPathWithinAuthorizedRoots,
  isExcessivelyBroadPath,
  getDedicatedTempWorkspace,
  parseExplicitWorkspaceRoots,
  getDefaultAllowedWorkspaceRoots,
  resolveProjectDir,
} from './workspaceBoundary.js'
import { DevEngine } from './DevEngine.js'

const isWindows = process.platform === 'win32'

describe('CRIT-01 Security Remediation: Workspace Boundary Enforcement', () => {
  let authorizedSandbox: string
  let outsideSandbox: string

  beforeEach(() => {
    authorizedSandbox = mkdtempSync(join(tmpdir(), 'jarvis-auth-root-'))
    outsideSandbox = mkdtempSync(join(tmpdir(), 'jarvis-unauth-root-'))
  })

  afterEach(() => {
    try {
      rmSync(authorizedSandbox, { recursive: true, force: true })
    } catch {}
    try {
      rmSync(outsideSandbox, { recursive: true, force: true })
    } catch {}
  })

  describe('0. Low-level path normalization and authorized root utilities', () => {
    it('normalizes paths by stripping quotes, whitespace, and trailing sentence punctuation', () => {
      expect(normalizeProjectPath('"D:\\MyProject."')).toBe('D:\\MyProject')
      expect(normalizeProjectPath(" 'D:/MyProject/sub ' ")).toBe(isWindows ? 'D:\\MyProject\\sub' : 'D:/MyProject/sub')
      expect(normalizeProjectPath('D:\\Project:!?')).toBe('D:\\Project')
    })

    it('returns default authorized workspace roots including cwd and tmpdir', () => {
      const defaultRoots = getDefaultAllowedWorkspaceRoots()
      expect(Array.isArray(defaultRoots)).toBe(true)
      expect(defaultRoots.length).toBeGreaterThan(0)
      expect(defaultRoots).toContain(resolve(process.cwd()))
      expect(defaultRoots).toContain(resolve(tmpdir()))
    })

    it('evaluates isPathWithinAuthorizedRoots correctly', () => {
      const roots = [authorizedSandbox]
      expect(isPathWithinAuthorizedRoots(authorizedSandbox, roots)).toBe(true)
      expect(isPathWithinAuthorizedRoots(join(authorizedSandbox, 'child'), roots)).toBe(true)
      expect(isPathWithinAuthorizedRoots(outsideSandbox, roots)).toBe(false)
      expect(isPathWithinAuthorizedRoots('C:\\Windows', roots)).toBe(false)
    })
  })

  describe('1. Valid authorized project paths (legitimate access)', () => {
    it('allows access to exact authorized root', () => {
      const res = resolveProjectDir(authorizedSandbox, false, [authorizedSandbox])
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.dir).toBe(resolve(authorizedSandbox))
        expect(res.created).toBe(false)
      }
    })

    it('allows access to legitimate subdirectory inside authorized root', () => {
      const subDir = join(authorizedSandbox, 'project_a')
      mkdirSync(subDir, { recursive: true })

      const res = resolveProjectDir(subDir, false, [authorizedSandbox])
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.dir).toBe(resolve(subDir))
      }
    })

    it('allows creating a new project directory inside authorized root with ensure: true', () => {
      const newProj = join(authorizedSandbox, 'new_app')
      expect(existsSync(newProj)).toBe(false)

      const res = resolveProjectDir(newProj, true, [authorizedSandbox])
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.created).toBe(true)
        expect(existsSync(newProj)).toBe(true)
      }
    })

    it('DevEngine.execute functions correctly on authorized workspace', async () => {
      const engine = new DevEngine({ allowedRoots: [authorizedSandbox] })
      const inspectRes = await engine.execute('dev.inspectProject', {
        projectPath: authorizedSandbox,
      })
      expect(inspectRes.ok).toBe(true)
    })
  })

  describe('2. Unauthorized absolute paths', () => {
    it('rejects an absolute path outside authorized roots', () => {
      const res = resolveProjectDir(outsideSandbox, false, [authorizedSandbox])
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.message).toMatch(/outside authorized workspace roots/i)
        expect(res.error).toBe('invalid_project_path')
      }
    })

    it('DevEngine.execute rejects actions on unauthorized workspace', async () => {
      const engine = new DevEngine({ allowedRoots: [authorizedSandbox] })
      const res = await engine.execute('dev.inspectProject', {
        projectPath: outsideSandbox,
      })
      expect(res.ok).toBe(false)
      expect(res.error).toBe('invalid_project_path')
      expect(res.message).toMatch(/outside authorized workspace roots/i)
    })
  })

  describe('3. C:\\Windows and sensitive system directories', () => {
    const sensitivePaths = isWindows
      ? [
          'C:\\Windows',
          'C:\\Windows\\System32',
          'C:\\Windows\\System32\\drivers\\etc\\hosts',
          'C:\\Program Files',
          'C:\\Program Files (x86)',
          'C:\\ProgramData',
        ]
      : ['/etc', '/bin', '/usr/bin', '/var/log']

    for (const sysPath of sensitivePaths) {
      it(`rejects system path: ${sysPath}`, () => {
        const res = resolveProjectDir(sysPath, false, [authorizedSandbox])
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.message).toMatch(/outside authorized workspace roots/i)
          expect(res.error).toBe('invalid_project_path')
        }
      })

      it(`rejects creating folder inside system path with ensure: true: ${sysPath}`, () => {
        const attackPath = join(sysPath, 'jarvis_backdoor')
        const res = resolveProjectDir(attackPath, true, [authorizedSandbox])
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.message).toMatch(/outside authorized workspace roots/i)
          expect(res.error).toBe('invalid_project_path')
        }
      })
    }
  })

  describe('4. User SSH directories', () => {
    it('rejects user .ssh directory', () => {
      const sshPath = join(homedir(), '.ssh')
      const res = resolveProjectDir(sshPath, false, [authorizedSandbox])
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.message).toMatch(/outside authorized workspace roots/i)
      }
    })

    it('DevEngine.patchFile rejects writing to .ssh directory', async () => {
      const sshPath = join(homedir(), '.ssh')
      const engine = new DevEngine({ allowedRoots: [authorizedSandbox] })
      const res = await engine.execute('dev.patchFile', {
        projectPath: sshPath,
        filePath: 'authorized_keys',
        replace: 'attacker_key',
        createIfMissing: true,
      })
      expect(res.ok).toBe(false)
      expect(res.error).toBe('invalid_project_path')
    })
  })

  describe('5. Startup directories', () => {
    it('rejects user and system startup folders', () => {
      const startupPaths = isWindows
        ? [
            join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
            'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
          ]
        : ['/etc/init.d', '/etc/systemd/system']

      for (const p of startupPaths) {
        const res = resolveProjectDir(p, false, [authorizedSandbox])
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.message).toMatch(/outside authorized workspace roots/i)
        }
      }
    })
  })

  describe('6. Relative traversal using ../ and Windows equivalents', () => {
    it('rejects relative traversal escaping authorized root with ../', () => {
      const traversalPath = join(authorizedSandbox, '..', '..', 'Windows')
      const res = resolveProjectDir(traversalPath, false, [authorizedSandbox])
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.message).toMatch(/outside authorized workspace roots/i)
      }
    })

    it('rejects relative traversal jumping to adjacent directory', () => {
      const traversalPath = join(authorizedSandbox, '..', 'some_other_folder')
      const res = resolveProjectDir(traversalPath, false, [authorizedSandbox])
      expect(res.ok).toBe(false)
    })
  })

  describe('7. UNC and Win32 device namespace paths', () => {
    const uncAttacks = [
      '\\\\server\\share\\repo',
      '//server/share/repo',
      '\\\\localhost\\c$\\Windows',
      '\\\\127.0.0.1\\c$\\Windows',
      '\\\\?\\C:\\Windows',
      '\\\\.\\PhysicalDrive0',
    ]

    for (const unc of uncAttacks) {
      it(`rejects UNC/device path: ${unc}`, () => {
        expect(isUncOrDevicePath(unc)).toBe(true)
        const res = resolveProjectDir(unc, false, [authorizedSandbox])
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.message).toMatch(/UNC|network|device namespace|reserved device/i)
          expect(res.error).toBe('invalid_project_path')
        }
      })
    }
  })

  describe('7b. Reserved Win32 DOS device names (CRIT-01 Remediation)', () => {
    const reservedDosNames = [
      'CON',
      'con',
      'CON.txt',
      'PRN',
      'prn.log',
      'AUX',
      'AUX.log',
      'NUL',
      'nul.dat',
      'COM1',
      'com5.txt',
      'COM9',
      'LPT1',
      'lpt3.doc',
      'LPT9',
      'CON.',
      'CON   ',
    ]

    for (const devName of reservedDosNames) {
      it(`rejects reserved DOS device name: ${devName} in projectPath`, () => {
        const fullCandidate = join(authorizedSandbox, devName)
        expect(isUncOrDevicePath(fullCandidate)).toBe(true)
        const res = resolveProjectDir(fullCandidate, false, [authorizedSandbox])
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.message).toMatch(/reserved device|device namespace|UNC/i)
          expect(res.error).toBe('invalid_project_path')
        }
      })

      it(`rejects creation (ensure=true) of reserved DOS device name: ${devName} and causes no filesystem side-effects`, () => {
        const fullCandidate = join(authorizedSandbox, devName)
        const res = resolveProjectDir(fullCandidate, true, [authorizedSandbox])
        expect(res.ok).toBe(false)
        expect(existsSync(fullCandidate)).toBe(false)
      })
    }

    it('rejects reserved DOS device name when used in intermediate path segments', () => {
      const intermediateCon = join(authorizedSandbox, 'CON', 'subfolder')
      const res1 = resolveProjectDir(intermediateCon, false, [authorizedSandbox])
      expect(res1.ok).toBe(false)
      expect(existsSync(intermediateCon)).toBe(false)

      const intermediateCom1 = join(authorizedSandbox, 'COM1', 'project')
      const res2 = resolveProjectDir(intermediateCom1, true, [authorizedSandbox])
      expect(res2.ok).toBe(false)
      expect(existsSync(intermediateCom1)).toBe(false)
    })

    it('does NOT reject legitimate similar filenames and prefixes', () => {
      const legitimateNames = [
        'CONSOLE',
        'console.ts',
        'COM10',
        'LPT10',
        'contact.txt',
        'auxiliary.js',
        'nulled.py',
        'corner.png',
      ]
      for (const legit of legitimateNames) {
        const fullPath = join(authorizedSandbox, legit)
        expect(isUncOrDevicePath(fullPath)).toBe(false)
      }
    })
  })

  describe('8. Alternate drive paths', () => {
    it.skipIf(!isWindows)('rejects paths located on an unauthorized drive letter', () => {
      // If authorizedSandbox is on C: or D:, test the other drive
      const currentDrive = authorizedSandbox[0].toUpperCase()
      const alternateDrive = currentDrive === 'C' ? 'X' : 'C'
      const altPath = `${alternateDrive}:\\some\\safe_looking_project`

      const res = resolveProjectDir(altPath, false, [authorizedSandbox])
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.message).toMatch(/outside authorized workspace roots/i)
      }
    })
  })

  describe('9. Symlink and junction escapes', () => {
    it('rejects a symlink inside authorized root pointing to an unauthorized directory', () => {
      const symlinkPath = join(authorizedSandbox, 'escape_link')
      try {
        symlinkSync(outsideSandbox, symlinkPath, isWindows ? 'junction' : 'dir')
      } catch {
        // Skip if elevated privileges required on test runner
        return
      }

      // Candidate lexically appears inside authorizedSandbox, but canonically points to outsideSandbox
      const res = resolveProjectDir(symlinkPath, false, [authorizedSandbox])
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.message).toMatch(/symlink or junction target is outside authorized workspace roots/i)
        expect(res.error).toBe('invalid_project_path')
      }
    })

    it.skipIf(!isWindows)('rejects a Windows directory junction pointing to C:\\Windows', () => {
      const junctionPath = join(authorizedSandbox, 'junction_to_windows')
      try {
        symlinkSync('C:\\Windows', junctionPath, 'junction')
      } catch {
        return
      }

      const res = resolveProjectDir(junctionPath, false, [authorizedSandbox])
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.message).toMatch(/symlink or junction target is outside authorized workspace roots/i)
      }
    })

    it('rejects creating directory when ancestor is a symlink pointing outside', () => {
      const symlinkParent = join(authorizedSandbox, 'symlink_parent')
      try {
        symlinkSync(outsideSandbox, symlinkParent, isWindows ? 'junction' : 'dir')
      } catch {
        return
      }

      const newTarget = join(symlinkParent, 'new_child')
      const res = resolveProjectDir(newTarget, true, [authorizedSandbox])
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.message).toMatch(/ancestor symlink points outside authorized workspace roots/i)
      }
    })
  })

  describe('10. Case-insensitive Windows path handling', () => {
    it.skipIf(!isWindows)('handles case variation of authorized roots without false rejections', () => {
      const lower = authorizedSandbox.toLowerCase()
      const upper = authorizedSandbox.toUpperCase()

      const resLower = resolveProjectDir(lower, false, [authorizedSandbox])
      expect(resLower.ok).toBe(true)

      const resUpper = resolveProjectDir(upper, false, [authorizedSandbox])
      expect(resUpper.ok).toBe(true)
    })
  })

  describe('11. Similar-prefix directory attacks (workspace-evil)', () => {
    it('strictly rejects path-prefix confusion attacks on authorized root', () => {
      const prefixAttacks = [
        authorizedSandbox + '-evil',
        authorizedSandbox + '_evil',
        authorizedSandbox + '2',
        authorizedSandbox + '.evil',
        authorizedSandbox + 'attack',
      ]

      for (const attack of prefixAttacks) {
        expect(isPathInsideRoot(authorizedSandbox, attack)).toBe(false)
        const res = resolveProjectDir(attack, false, [authorizedSandbox])
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.message).toMatch(/outside authorized workspace roots/i)
        }
      }
    })

    it('strictly prevents prefix confusion on canonical Windows roots', () => {
      expect(isPathInsideRoot('D:\\JARVIS', 'D:\\JARVIS-evil')).toBe(false)
      expect(isPathInsideRoot('D:\\JARVIS', 'D:\\JARVIS_backdoor')).toBe(false)
      expect(isPathInsideRoot('D:\\JARVIS', 'D:\\JARVIS2')).toBe(false)
      expect(isPathInsideRoot('D:\\JARVIS-Test', 'D:\\JARVIS-Test-Evil')).toBe(false)
      expect(isPathInsideRoot('D:\\JARVIS-Test', 'D:\\JARVIS-Test_attack')).toBe(false)
    })
  })

  describe('12. Nonexistent paths (ensure false vs true)', () => {
    it('fails with "does not exist" when nonexistent path is INSIDE authorized root and ensure is false', () => {
      const nonExistent = join(authorizedSandbox, 'does_not_exist_yet')
      const res = resolveProjectDir(nonExistent, false, [authorizedSandbox])
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.message).toMatch(/Project directory does not exist/i)
      }
    })

    it('fails with "outside authorized roots" when nonexistent path is OUTSIDE authorized root (ensure: false)', () => {
      const nonExistentOutside = join(outsideSandbox, 'does_not_exist')
      const res = resolveProjectDir(nonExistentOutside, false, [authorizedSandbox])
      expect(res.ok).toBe(false)
      if (!res.ok) {
        // Crucial security behavior: does not reveal whether the directory exists outside
        expect(res.message).toMatch(/outside authorized workspace roots/i)
      }
    })

    it('strictly refuses to create directories outside authorized root (ensure: true)', () => {
      const unauthTarget = join(outsideSandbox, 'attacker_created_dir')
      const res = resolveProjectDir(unauthTarget, true, [authorizedSandbox])
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.message).toMatch(/outside authorized workspace roots/i)
      }
      expect(existsSync(unauthTarget)).toBe(false)
    })
  })

  describe('13. Invalid and malformed paths', () => {
    it('rejects empty string, whitespace, and non-string inputs', () => {
      const invalidInputs = ['', '   ', null, undefined, 12345, {}]
      for (const input of invalidInputs) {
        const res = resolveProjectDir(input, false, [authorizedSandbox])
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.error).toBe('invalid_project_path')
        }
      }
    })

    it('rejects relative paths that are not absolute', () => {
      const relativePaths = [
        'sub/project',
        './sub/project',
        '../escape',
        'project_dir',
      ]

      for (const rel of relativePaths) {
        expect(isAbsoluteProjectPath(rel)).toBe(false)
        const res = resolveProjectDir(rel, false, [authorizedSandbox])
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.message).toMatch(/must be an absolute path/i)
        }
      }
    })

    it('rejects paths that resolve to regular files instead of directories', () => {
      const filePath = join(authorizedSandbox, 'test_file.txt')
      writeFileSync(filePath, 'hello world', 'utf-8')

      const res = resolveProjectDir(filePath, false, [authorizedSandbox])
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.message).toMatch(/is not a directory/i)
      }
    })
  })

  describe('14. BACKLOG-SEC-01: Strict Workspace Configuration & Environment Root Isolation', () => {
    describe('14.1 isExcessivelyBroadPath', () => {
      it('identifies Windows drive roots and root directory as excessively broad', () => {
        expect(isExcessivelyBroadPath('')).toBe(true)
        expect(isExcessivelyBroadPath('   ')).toBe(true)
        expect(isExcessivelyBroadPath('/')).toBe(true)
        if (isWindows) {
          expect(isExcessivelyBroadPath('C:')).toBe(true)
          expect(isExcessivelyBroadPath('C:\\')).toBe(true)
          expect(isExcessivelyBroadPath('D:')).toBe(true)
          expect(isExcessivelyBroadPath('D:\\')).toBe(true)
          expect(isExcessivelyBroadPath('c:\\')).toBe(true)
        }
      })

      it('identifies user home directory and sensitive OS folders as excessively broad', () => {
        expect(isExcessivelyBroadPath(homedir())).toBe(true)
        if (isWindows) {
          expect(isExcessivelyBroadPath('C:\\Windows')).toBe(true)
          expect(isExcessivelyBroadPath('C:\\Windows\\System32')).toBe(true)
          expect(isExcessivelyBroadPath('C:\\Program Files')).toBe(true)
          expect(isExcessivelyBroadPath('C:\\ProgramData')).toBe(true)
        }
      })

      it('permits legitimate project directories', () => {
        expect(isExcessivelyBroadPath(authorizedSandbox)).toBe(false)
        if (isWindows) {
          expect(isExcessivelyBroadPath('D:\\JARVIS')).toBe(false)
          expect(isExcessivelyBroadPath('D:\\MyProjects\\App1')).toBe(false)
        }
      })
    })

    describe('14.2 getDedicatedTempWorkspace', () => {
      it('returns a dedicated jarvis_workspace directory under OS temp and ensures it exists', () => {
        const dedicatedTemp = getDedicatedTempWorkspace()
        expect(dedicatedTemp).toContain('jarvis_workspace')
        expect(existsSync(dedicatedTemp)).toBe(true)
        expect(isExcessivelyBroadPath(dedicatedTemp)).toBe(false)
      })
    })

    describe('14.3 parseExplicitWorkspaceRoots', () => {
      it('parses, resolves, and deduplicates valid single and multi-path configurations', () => {
        const root1 = isWindows ? 'D:\\Workspace1' : '/tmp/workspace1'
        const root2 = isWindows ? 'D:\\Workspace2' : '/tmp/workspace2'
        const raw = `${root1}; ${root2}, ${root1}`

        const parsed = parseExplicitWorkspaceRoots(raw)
        expect(parsed).toEqual([resolve(root1), resolve(root2)])
      })

      it('filters out UNC paths, device paths, and relative paths', () => {
        const validRoot = isWindows ? 'D:\\ValidRoot' : '/tmp/valid_root'
        const raw = `\\\\attacker\\share; relative/sub; ${validRoot}`

        const parsed = parseExplicitWorkspaceRoots(raw)
        expect(parsed).toEqual([resolve(validRoot)])
      })

      it('filters out excessively broad directories such as drive roots and user home', () => {
        const validRoot = isWindows ? 'D:\\ValidRoot' : '/tmp/valid_root'
        const broadDrive = isWindows ? 'C:\\' : '/'
        const raw = `${broadDrive}; ${homedir()}; ${validRoot}`

        const parsed = parseExplicitWorkspaceRoots(raw)
        expect(parsed).toEqual([resolve(validRoot)])
      })

      it('fails closed (returns empty array) on empty or entirely invalid input', () => {
        expect(parseExplicitWorkspaceRoots('')).toEqual([])
        expect(parseExplicitWorkspaceRoots('   ')).toEqual([])
        expect(parseExplicitWorkspaceRoots(' ; ; , ; ')).toEqual([])
        expect(parseExplicitWorkspaceRoots('relative\\only; another\\rel')).toEqual([])
        expect(parseExplicitWorkspaceRoots('\\\\server\\share1; \\\\server\\share2')).toEqual([])
      })
    })

    describe('14.4 getDefaultAllowedWorkspaceRoots', () => {
      it('replaces defaults completely when JARVIS_WORKSPACE_ROOTS is explicitly configured', () => {
        const explicitRoot = isWindows ? 'D:\\ExplicitRoot' : '/tmp/explicit_root'
        const roots = getDefaultAllowedWorkspaceRoots({
          env: {
            JARVIS_WORKSPACE_ROOTS: explicitRoot,
          } as NodeJS.ProcessEnv,
        })

        expect(roots).toEqual([resolve(explicitRoot)])
        // Must NOT silently contain cwd, tmpdir, or default dev roots
        expect(roots).not.toContain(resolve(process.cwd()))
        expect(roots).not.toContain(resolve(tmpdir()))
        if (isWindows) {
          expect(roots).not.toContain(resolve('D:\\JARVIS-Test'))
        }
      })

      it('replaces defaults with multiple explicitly configured roots', () => {
        const rootA = isWindows ? 'D:\\RootA' : '/tmp/roota'
        const rootB = isWindows ? 'D:\\RootB' : '/tmp/rootb'
        const roots = getDefaultAllowedWorkspaceRoots({
          env: {
            JARVIS_WORKSPACE_ROOTS: `${rootA}; ${rootB}`,
          } as NodeJS.ProcessEnv,
        })

        expect(roots).toEqual([resolve(rootA), resolve(rootB)])
      })

      it('enforces deterministic precedence: JARVIS_WORKSPACE_ROOTS overrides JARVIS_WORKSPACE', () => {
        const primaryRoot = isWindows ? 'D:\\PrimaryRoot' : '/tmp/primary'
        const secondaryRoot = isWindows ? 'D:\\SecondaryRoot' : '/tmp/secondary'

        const roots = getDefaultAllowedWorkspaceRoots({
          env: {
            JARVIS_WORKSPACE_ROOTS: primaryRoot,
            JARVIS_WORKSPACE: secondaryRoot,
          } as NodeJS.ProcessEnv,
        })

        expect(roots).toEqual([resolve(primaryRoot)])
        expect(roots).not.toContain(resolve(secondaryRoot))
      })

      it('falls back to JARVIS_WORKSPACE when JARVIS_WORKSPACE_ROOTS is not set', () => {
        const fallbackRoot = isWindows ? 'D:\\FallbackRoot' : '/tmp/fallback'

        const roots = getDefaultAllowedWorkspaceRoots({
          env: {
            JARVIS_WORKSPACE: fallbackRoot,
          } as NodeJS.ProcessEnv,
        })

        expect(roots).toEqual([resolve(fallbackRoot)])
        expect(roots).not.toContain(resolve(process.cwd()))
      })

      it('fails closed (returns []) when explicit environment configuration is invalid', () => {
        const roots = getDefaultAllowedWorkspaceRoots({
          env: {
            JARVIS_WORKSPACE_ROOTS: '   ; ;  ',
          } as NodeJS.ProcessEnv,
        })

        // Must fail closed with 0 authorized roots rather than falling back to broader defaults
        expect(roots).toEqual([])
      })

      it('filters out drive root cwd from default roots', () => {
        const broadCwd = isWindows ? 'C:\\' : '/'
        const roots = getDefaultAllowedWorkspaceRoots({
          cwd: broadCwd,
          env: {} as NodeJS.ProcessEnv,
        })

        expect(roots).not.toContain(resolve(broadCwd))
      })

      it('filters out user profile cwd from default roots', () => {
        const userHomeCwd = homedir()
        const roots = getDefaultAllowedWorkspaceRoots({
          cwd: userHomeCwd,
          env: {} as NodeJS.ProcessEnv,
        })

        expect(roots).not.toContain(resolve(userHomeCwd))
      })

      it('includes safe cwd in default roots when no explicit env is set', () => {
        const safeDir = isWindows ? 'D:\\SafeDevDir' : '/tmp/safedevdir'
        const roots = getDefaultAllowedWorkspaceRoots({
          cwd: safeDir,
          env: {} as NodeJS.ProcessEnv,
        })

        expect(roots).toContain(resolve(safeDir))
      })

      it('isolates production configuration from development roots', () => {
        const safeDir = isWindows ? 'D:\\ProductionApp' : '/tmp/prodapp'
        const roots = getDefaultAllowedWorkspaceRoots({
          cwd: safeDir,
          production: true,
          env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
        })

        // Contains safe cwd and dedicated temp workspace
        expect(roots).toContain(resolve(safeDir))
        expect(roots).toContain(getDedicatedTempWorkspace())

        // In production, broad OS tmpdir and dev convenience roots must NOT be present
        expect(roots).not.toContain(resolve(tmpdir()))
        if (isWindows) {
          expect(roots).not.toContain(resolve('D:\\JARVIS-Test'))
          expect(roots).not.toContain(resolve('D:\\ProjectHub'))
        }
      })

      it('preserves development roots when in development mode', () => {
        if (!isWindows) return
        const roots = getDefaultAllowedWorkspaceRoots({
          cwd: 'D:\\JARVIS',
          production: false,
          env: { NODE_ENV: 'development' } as NodeJS.ProcessEnv,
        })

        expect(roots).toContain(resolve('D:\\JARVIS'))
        expect(roots).toContain(resolve('D:\\JARVIS-Test'))
        expect(roots).toContain(resolve('D:\\ProjectHub'))
      })
    })

    describe('14.5 resolveProjectDir with explicit root configuration', () => {
      it('fails closed when allowedRoots is empty array', () => {
        // Even if the directory exists and is safe, empty allowedRoots must reject access
        const res = resolveProjectDir(authorizedSandbox, false, [])
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.message).toMatch(/outside authorized workspace roots/i)
        }
      })

      it('strictly enforces explicit roots over default cwd or dev roots', () => {
        const explicitSandbox = mkdtempSync(join(tmpdir(), 'jarvis-explicit-'))
        try {
          const res = resolveProjectDir(authorizedSandbox, false, [explicitSandbox])
          expect(res.ok).toBe(false)
          if (!res.ok) {
            expect(res.message).toMatch(/outside authorized workspace roots/i)
          }

          const validRes = resolveProjectDir(explicitSandbox, false, [explicitSandbox])
          expect(validRes.ok).toBe(true)
        } finally {
          try {
            rmSync(explicitSandbox, { recursive: true, force: true })
          } catch {}
        }
      })
    })

    describe('14.6 DevEngine constructor with explicit configuration', () => {
      it('fails closed when instantiated with allowedRoots: []', async () => {
        const engine = new DevEngine({ allowedRoots: [] })
        expect(engine.getAllowedWorkspaceRoots()).toEqual([])

        const res = await engine.execute('dev.inspectProject', {
          projectPath: authorizedSandbox,
        })
        expect(res.ok).toBe(false)
        expect(res.error).toBe('invalid_project_path')
        expect(res.message).toMatch(/outside authorized workspace roots/i)
      })

      it('restricts execution exclusively to configured allowedRoots', async () => {
        const engine = new DevEngine({ allowedRoots: [authorizedSandbox] })
        expect(engine.getAllowedWorkspaceRoots()).toEqual([authorizedSandbox])

        const okRes = await engine.execute('dev.inspectProject', {
          projectPath: authorizedSandbox,
        })
        expect(okRes.ok).toBe(true)

        const blockedRes = await engine.execute('dev.inspectProject', {
          projectPath: outsideSandbox,
        })
        expect(blockedRes.ok).toBe(false)
        expect(blockedRes.error).toBe('invalid_project_path')
      })
    })
  })
})
