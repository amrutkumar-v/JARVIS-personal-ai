/**
 * DevEngine shell-safety tests (independent audit).
 *
 * Proves that a hostile TEST FILE NAME can never be turned into command
 * chaining on Windows: runTests hands the file name to `npx` (npx.cmd) under
 * shell:true, where Node concatenates arguments without escaping (DEP0190).
 * The guard must reject before any process is spawned, and the non-shell
 * (python) branch must pass the name through literally.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevEngine } from './DevEngine.js'

const isWindows = process.platform === 'win32'

describe('DevEngine.runTests shell safety', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'jarvis-dev-sec-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it.skipIf(!isWindows)(
    'rejects a test file whose name contains cmd.exe metacharacters before any process is spawned',
    async () => {
      // `&` is a legal Windows filename character. Under shell:true +
      // unescaped .cmd argument concatenation, cmd.exe would re-parse:
      //   npx vitest run a & mkdir INJECTED_DIR & b.test.ts
      // so a successful exploit creates INJECTED_DIR as a side effect.
      const hostileName = 'a&mkdir INJECTED_DIR&b.test.ts'
      writeFileSync(join(projectDir, hostileName), 'export {}\n', 'utf-8')

      const engine = new DevEngine()
      const res = await engine.execute('dev.runTests', {
        projectPath: projectDir,
        testFile: hostileName,
      })

      expect(res.ok).toBe(false)
      expect(res.error).toBe('test_file_unsafe_characters')
      // Rejected BEFORE spawn: the chained command must never have run.
      expect(existsSync(join(projectDir, 'INJECTED_DIR'))).toBe(false)
    },
  )

  it.skipIf(!isWindows)(
    'the python branch runs without a shell, so a hostile name reaches python literally and never chains',
    async () => {
      const hostileName = 'a&mkdir INJECTED_DIR&b.py'
      writeFileSync(join(projectDir, hostileName), 'import unittest\n', 'utf-8')

      const engine = new DevEngine()
      const res = await engine.execute('dev.runTests', {
        projectPath: projectDir,
        testFile: hostileName,
      })

      // python.exe is spawned with shell:false: the name is one literal
      // argument, python fails to import it, and nothing is chained.
      expect(res.ok).toBe(false)
      expect(res.error).not.toBe('test_file_unsafe_characters')
      expect(existsSync(join(projectDir, 'INJECTED_DIR'))).toBe(false)
    },
  )

  it('rejects an allow-listed test command containing shell metacharacters', async () => {
    const engine = new DevEngine()
    const res = await engine.execute('dev.runTests', {
      projectPath: projectDir,
      testCommand: 'npx vitest run & mkdir INJECTED_CMD',
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('test_command_rejected')
    expect(existsSync(join(projectDir, 'INJECTED_CMD'))).toBe(false)
  })

  it('rejects file access escaping project root via symlink or directory junction', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'jarvis-outside-'))
    const secretFile = join(outsideDir, 'secret.txt')
    writeFileSync(secretFile, 'super_secret_token', 'utf-8')

    try {
      const junctionDir = join(projectDir, 'escape_junction')
      try {
        symlinkSync(outsideDir, junctionDir, 'junction')
      } catch {
        // If junction not supported without elevated privileges, test passes cleanly
        return
      }

      const engine = new DevEngine()
      // Test inspectProject fileEvidence: outside file via junction is treated as missing
      const inspectRes = await engine.execute('dev.inspectProject', {
        projectPath: projectDir,
        expectedFiles: ['escape_junction/secret.txt'],
      })
      expect(inspectRes.ok).toBe(false)
      expect(inspectRes.error).toBe('expected_files_unverified')
      const evidence = (inspectRes.data as any)?.expectedFiles?.[0]
      expect(evidence?.exists).toBe(false)
      expect(evidence?.sha256).toBeUndefined()

      // Test patchFile
      const patchRes = await engine.execute('dev.patchFile', {
        projectPath: projectDir,
        filePath: 'escape_junction/secret.txt',
        replace: 'overwritten',
      })
      expect(patchRes.ok).toBe(false)
      expect(patchRes.message).toMatch(/Refusing to modify a path outside the project/)
      expect(readFileSync(secretFile, 'utf-8')).toBe('super_secret_token')
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('rejects patchFile targeting reserved Win32 DOS device names without filesystem side-effects', async () => {
    const engine = new DevEngine()
    for (const devName of ['CON', 'con.txt', 'NUL.log', 'PRN', 'AUX', 'COM1', 'LPT1']) {
      const patchRes = await engine.execute('dev.patchFile', {
        projectPath: projectDir,
        filePath: devName,
        content: 'exploit attempt',
      })
      expect(patchRes.ok).toBe(false)
      expect(patchRes.message).toMatch(/Refusing to access reserved Win32 device path|Refusing to modify a path outside the project/)
      expect(existsSync(join(projectDir, devName))).toBe(false)
    }
  })
})
