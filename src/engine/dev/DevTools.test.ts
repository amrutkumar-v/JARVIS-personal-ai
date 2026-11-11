import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  DevInspectProjectTool,
  DevGitStatusTool,
  DevPatchFileTool,
  DevGenerateReportTool,
  createDevTools,
  setGlobalDevExecutor,
} from './DevTools'
import { DevEngine } from '../../../server/src/dev/DevEngine.js'
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

describe('DevTools (Phase D Autonomous Development Agent)', () => {
  const scratchDir = join(process.cwd(), '.freebuff', 'test-devtools-scratch')

  beforeEach(() => {
    setGlobalDevExecutor((action, params) => new DevEngine().execute(action, params))
  })

  afterEach(() => {
    setGlobalDevExecutor(null)
    try {
      if (existsSync(scratchDir)) {
        rmSync(scratchDir, { recursive: true, force: true })
      }
    } catch {
      // Ignore
    }
  })

  it('registers all 7 development tools', () => {
    const tools = createDevTools()
    expect(tools).toHaveLength(7)
    const ids = tools.map((t) => t.id)
    expect(ids).toContain('dev.inspectProject')
    expect(ids).toContain('dev.gitStatus')
    expect(ids).toContain('dev.gitCheckpoint')
    expect(ids).toContain('dev.patchFile')
    expect(ids).toContain('dev.runTests')
    expect(ids).toContain('dev.auditProject')
    expect(ids).toContain('dev.generateReport')
  })

  it('inspects project structure, dependencies, and test runner', async () => {
    const tool = new DevInspectProjectTool()
    const res = await tool.execute(
      { query: 'inspect', params: { projectPath: process.cwd() } },
      { requestId: 'req-1' },
    )
    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.language).toBe('typescript')
    expect(data.testRunner).toBe('vitest')
    expect(data.hasGit).toBe(true)
  })

  it('inspects git status and uncommitted files', async () => {
    const tool = new DevGitStatusTool()
    const res = await tool.execute(
      { query: 'git status', params: { projectPath: process.cwd() } },
      { requestId: 'req-2' },
    )
    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(typeof data.branch).toBe('string')
    expect(Array.isArray(data.modifiedFiles)).toBe(true)
  })

  it('applies targeted patch and refuses blind overwrites when target is not found', async () => {
    const patchTool = new DevPatchFileTool()
    const testFile = join(process.cwd(), '.freebuff', 'sample-patch-test.ts')

    // Create a sample file
    writeFileSync(
      testFile,
      'export function greet() { return "hello world"; }\n',
      'utf-8',
    )

    // 1. Refuse patch if target text does NOT exist
    const failRes = await patchTool.execute(
      {
        query: 'patch',
        params: {
          projectPath: process.cwd(),
          filePath: testFile,
          target: 'non_existent_code_block()',
          replacement: 'something_else()',
        },
      },
      { requestId: 'req-3' },
    )
    expect(failRes.ok).toBe(false)
    expect(failRes.message).toContain('Blind overwrites are forbidden')

    // 2. Apply valid targeted replacement
    const okRes = await patchTool.execute(
      {
        query: 'patch',
        params: {
          projectPath: process.cwd(),
          filePath: testFile,
          target: 'return "hello world";',
          replacement: 'return "hello autonomous JARVIS";',
        },
      },
      { requestId: 'req-4' },
    )
    expect(okRes.ok).toBe(true)

    // Verify file content on disk
    const content = readFileSync(testFile, 'utf-8')
    expect(content).toContain('hello autonomous JARVIS')

    // Verify backup was created
    const bakFile = `${testFile}.jarvis.bak`
    expect(existsSync(bakFile)).toBe(true)

    // Verify tool verification
    const v = await patchTool.verify(
      {
        query: 'patch',
        params: {
          filePath: testFile,
          replacement: 'hello autonomous JARVIS',
        },
      },
      okRes,
    )
    expect(v.ok).toBe(true)
    expect(v.message).toContain('Verified: patched')

    // Clean up
    try {
      rmSync(testFile, { force: true })
      rmSync(bakFile, { force: true })
    } catch {}
  })

  it('generates an auditable completion report from real files and test evidence', async () => {
    const tool = new DevGenerateReportTool()
    mkdirSync(scratchDir, { recursive: true })
    writeFileSync(join(scratchDir, 'impl.ts'), 'export const value = 1\n', 'utf-8')

    const res = await tool.execute(
      {
        query: 'report',
        params: {
          projectPath: scratchDir,
          title: 'Autonomous Development Report: Scratch',
          summary: 'Created impl.ts and executed its unit test.',
          requiredFiles: ['impl.ts'],
          evidence: {
            testResults: {
              passed: true,
              exitCode: 0,
              passedCount: 1,
              failedCount: 0,
              durationMs: 12,
              command: 'npx vitest run',
              outputSnippet: '1 passed',
            },
            fileChanges: [
              { filePath: 'impl.ts', created: true, bytesAfter: 23, sha256: 'abc123' },
            ],
          },
        },
      },
      { requestId: 'req-6' },
    )

    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.verified).toBe(true)
    expect(data.testVerified).toBe(true)
    expect(data.requiredFilesVerified).toBe(true)
    expect(typeof data.report).toBe('string')
    expect(data.report).toContain('Autonomous Development Report: Scratch')
    expect(data.report).toContain('impl.ts')
    expect(data.report).toContain('npx vitest run')
    expect(data.report).toContain('Required files on disk: PASS')
    expect(data.report).toContain('Test execution: PASS')
    expect(existsSync(String(data.reportPath))).toBe(true)
  })

  it('fails report verification when required files are missing or tests have no evidence', async () => {
    const tool = new DevGenerateReportTool()
    mkdirSync(scratchDir, { recursive: true })
    const res = await tool.execute(
      {
        query: 'report',
        params: {
          projectPath: scratchDir,
          requiredFiles: ['missing.py'],
        },
      },
      { requestId: 'req-7' },
    )

    expect(res.ok).toBe(false)
    const data = res.data as Record<string, unknown>
    expect(data.verified).toBe(false)
    expect(data.requiredFilesVerified).toBe(false)
    expect(data.testVerified).toBe(false)
    expect(res.message).toContain('completion verification failed')
  })
})
