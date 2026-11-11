/**
 * Backend Autonomous Development Engine (Phase D).
 *
 * Runs exclusively in the persistent Node.js backend.
 * Executes filesystem, Git, test running, and project inspection operations
 * on behalf of the AssistantEngine without exposing Node.js modules to the browser.
 *
 * Honesty rules enforced here:
 *  - a project path is normalized before use, so sentence punctuation never
 *    becomes part of a directory name;
 *  - an unknown/missing directory is never silently created unless the caller
 *    explicitly asked for it (`ensureDirectory: true`);
 *  - operations return `ok: false` instead of fabricating success;
 *  - test results come from a real child process exit code and parsed counts;
 *  - generated reports only state facts that were observed (file hashes, git
 *    state, supplied test evidence) and never assume a clean run.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const TEST_TIMEOUT_MS = 120_000
const COMMAND_TIMEOUT_MS = 60_000

/* --------------------------------------------------------------- helpers */

/** Strip sentence punctuation and surrounding quotes from a user-supplied path. */
export function normalizeProjectPath(raw: string): string {
  let value = String(raw ?? '').trim()
  value = value.replace(/^["'`]+/, '').replace(/["'`]+$/, '')
  // A trailing sentence period is not part of a Windows directory name. The
  // Win32 API can silently create an addressable-looking but non-normal path
  // (`D:\Project.`) that later child-process spawns cannot use as a cwd.
  value = value.replace(/[.,;:!?]+$/g, '')
  value = value.replace(/[ .]+$/g, '')
  if (process.platform === 'win32') {
    value = value.replace(/\//g, '\\')
    value = value.replace(/\\{2,}/g, '\\')
  }
  return value
}

function isAbsoluteProjectPath(value: string): boolean {
  if (process.platform === 'win32') return /^[a-zA-Z]:\\/.test(value)
  return isAbsolute(value)
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function safeStat(path: string): { exists: boolean; isDirectory: boolean; size: number } {
  try {
    const st = statSync(path)
    return { exists: true, isDirectory: st.isDirectory(), size: st.size }
  } catch {
    return { exists: false, isDirectory: false, size: 0 }
  }
}

/** True when `candidate` is the base directory or lives inside it. */
function isInside(baseDir: string, candidate: string): boolean {
  const rel = relative(baseDir, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

interface ResolvedProjectDir {
  ok: true
  dir: string
  created: boolean
}

interface ResolvedProjectDirError {
  ok: false
  message: string
}

/**
 * Normalize and validate a project directory.
 *
 * A missing directory is only created when `ensure` is true (a plan step that
 * explicitly builds a new project). Inspection of a typo'd path must fail
 * loudly instead of operating on a freshly invented empty folder.
 */
function resolveProjectDir(raw: unknown, ensure = false): ResolvedProjectDir | ResolvedProjectDirError {
  const normalized = normalizeProjectPath(typeof raw === 'string' ? raw : '')
  if (!normalized) {
    return { ok: false, message: 'projectPath is required and must be a concrete absolute path.' }
  }
  if (!isAbsoluteProjectPath(normalized)) {
    return {
      ok: false,
      message: `projectPath must be an absolute path, received "${normalized}".`,
    }
  }

  const dir = resolve(normalized)
  const stat = safeStat(dir)
  if (stat.exists && !stat.isDirectory) {
    return { ok: false, message: `projectPath is not a directory: ${dir}` }
  }
  if (!stat.exists) {
    if (!ensure) {
      return { ok: false, message: `Project directory does not exist: ${dir}` }
    }
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err) {
      return {
        ok: false,
        message: `Could not create project directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    return { ok: true, dir, created: true }
  }
  return { ok: true, dir, created: false }
}

/**
 * Resolve a project-relative file path and reject paths that escape the
 * project root. Whole-drive edits are never a valid autonomous action.
 */
function resolveProjectFile(baseDir: string, filePath: unknown): { ok: true; path: string; relativePath: string } | { ok: false; message: string } {
  const normalized = normalizeProjectPath(typeof filePath === 'string' ? filePath : '')
    .replace(/[\\/]+$/, '')
  if (!normalized) return { ok: false, message: 'filePath is required.' }

  const candidate = isAbsoluteProjectPath(normalized) ? resolve(normalized) : resolve(baseDir, normalized)
  if (!isInside(baseDir, candidate) || candidate === baseDir) {
    return { ok: false, message: `Refusing to modify a path outside the project: ${normalized}` }
  }
  return { ok: true, path: candidate, relativePath: relative(baseDir, candidate) }
}

function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<{ exitCode: number; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (value: { exitCode: number; stdout: string; stderr: string; error?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }

    // A child process must never be spawned against a non-normal/non-existent
    // cwd: Node reports the misleading `spawn git.exe ENOENT`.
    const cwdStat = safeStat(cwd)
    if (!cwdStat.exists || !cwdStat.isDirectory) {
      resolvePromise({
        exitCode: -1,
        stdout: '',
        stderr: `Cannot run "${cmd}" because the working directory is not accessible: ${cwd}`,
        error: 'invalid_cwd',
      })
      return
    }

    let execCmd = cmd
    if (process.platform === 'win32') {
      if (cmd === 'npm') execCmd = 'npm.cmd'
      if (cmd === 'npx') execCmd = 'npx.cmd'
    }

    const useShell =
      process.platform === 'win32' && (execCmd.endsWith('.cmd') || execCmd.endsWith('.bat'))

    let child
    try {
      child = spawn(execCmd, args, {
        cwd,
        shell: useShell,
        windowsHide: true,
        env: { ...process.env, CI: 'true' },
      })
    } catch (err) {
      resolvePromise({
        exitCode: -1,
        stdout,
        stderr: `Failed to start ${cmd}: ${err instanceof Error ? err.message : String(err)}`,
        error: 'spawn_failed',
      })
      return
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({
        exitCode: -1,
        stdout,
        stderr: `${stderr}\nProcess timed out after ${timeoutMs}ms`,
        error: 'timeout',
      })
    }, timeoutMs)

    child.stdout?.on('data', (data: Buffer | string) => {
      stdout += data.toString()
      if (stdout.length > 50_000) stdout = stdout.slice(-50_000)
    })

    child.stderr?.on('data', (data: Buffer | string) => {
      stderr += data.toString()
      if (stderr.length > 50_000) stderr = stderr.slice(-50_000)
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      const detail =
        err.code === 'ENOENT'
          ? `Executable "${execCmd}" was not found on PATH (cwd: ${cwd}).`
          : err.message
      finish({
        exitCode: -1,
        stdout,
        stderr: `${stderr}\nError: ${detail}`,
        error: err.code === 'ENOENT' ? 'executable_missing' : 'spawn_failed',
      })
    })

    child.on('close', (exitCode: number | null) => {
      finish({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      })
    })
  })
}

/* --------------------------------------------------------- file inventory */

interface FileEvidence {
  path: string
  exists: boolean
  bytes: number
  sha256?: string
}

function fileEvidence(baseDir: string, relativeOrAbsolute: string): FileEvidence {
  const resolved = isAbsoluteProjectPath(relativeOrAbsolute)
    ? resolve(relativeOrAbsolute)
    : resolve(baseDir, relativeOrAbsolute)
  const stat = safeStat(resolved)
  const evidence: FileEvidence = {
    path: relative(baseDir, resolved) || resolved,
    exists: stat.exists && !stat.isDirectory,
    bytes: stat.exists && !stat.isDirectory ? stat.size : 0,
  }
  if (evidence.exists) {
    try {
      evidence.sha256 = sha256(readFileSync(resolved, 'utf-8'))
    } catch {
      // Hash evidence is best-effort; existence/byte size already came from stat.
    }
  }
  return evidence
}

function listTopLevel(baseDir: string): Array<{ name: string; directory: boolean; bytes: number }> {
  try {
    return readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules' && entry.name !== '__pycache__')
      .slice(0, 200)
      .map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
        bytes: entry.isFile() ? safeStat(join(baseDir, entry.name)).size : 0,
      }))
  } catch {
    return []
  }
}

/* ------------------------------------------------------------- interfaces */

export interface DevActionResult {
  ok: boolean
  message: string
  data?: unknown
  error?: string
}

export interface InspectProjectOptions {
  ensureDirectory?: boolean
  expectedFiles?: string[]
  minFileBytes?: number
}

export interface GenerateReportOptions {
  reportFile?: string
  requiredFiles?: string[]
  evidence?: Record<string, unknown>
}

/* ---------------------------------------------------------------- engine */

export class DevEngine {
  async inspectProject(projectPath: string, options: InspectProjectOptions = {}): Promise<DevActionResult> {
    const resolvedDir = resolveProjectDir(projectPath, options.ensureDirectory === true)
    if (!resolvedDir.ok) return { ok: false, message: resolvedDir.message, error: 'invalid_project_path' }
    const targetDir = resolvedDir.dir

    const pkgPath = join(targetDir, 'package.json')
    let pkg: Record<string, unknown> = {}
    if (existsSync(pkgPath)) {
      try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>
      } catch (err) {
        return {
          ok: false,
          message: `Malformed package.json: ${err instanceof Error ? err.message : String(err)}`,
          error: 'malformed_manifest',
        }
      }
    }

    const files = listTopLevel(targetDir)
    const fileNames = files.filter((f) => !f.directory).map((f) => f.name)
    const hasGit = existsSync(join(targetDir, '.git'))
    const hasReadme = fileNames.some((name) => /^readme(\.md|\.txt)?$/i.test(name))
    const hasTsConfig = existsSync(join(targetDir, 'tsconfig.json'))
    const scripts = Object.keys((pkg.scripts as Record<string, string>) || {})

    const pythonManifest =
      existsSync(join(targetDir, 'requirements.txt')) ||
      existsSync(join(targetDir, 'pyproject.toml')) ||
      existsSync(join(targetDir, 'setup.py')) ||
      existsSync(join(targetDir, 'Pipfile'))
    const pythonFiles = fileNames.filter((name) => name.endsWith('.py'))
    const isPython = pythonManifest || pythonFiles.length > 0
    const language = isPython
      ? 'python'
      : hasTsConfig
        ? 'typescript'
        : Object.keys(pkg).length > 0
          ? 'javascript'
          : 'unknown'

    let testRunner = 'unknown'
    if (language === 'python') {
      const pytestConfigured =
        existsSync(join(targetDir, 'pytest.ini')) ||
        existsSync(join(targetDir, 'conftest.py')) ||
        (existsSync(join(targetDir, 'pyproject.toml')) &&
          /pytest/i.test(readFileSync(join(targetDir, 'pyproject.toml'), 'utf-8')))
      testRunner = pytestConfigured ? 'pytest' : 'unittest'
    } else if (scripts.includes('test')) {
      const testScript = (pkg.scripts as Record<string, string>)?.test || ''
      if (testScript.includes('vitest')) testRunner = 'vitest'
      else if (testScript.includes('jest')) testRunner = 'jest'
      else if (testScript.includes('mocha')) testRunner = 'mocha'
      else if (testScript.includes('node --test')) testRunner = 'node-test'
      else testRunner = 'custom-npm-test'
    }

    const dependenciesCount = Object.keys((pkg.dependencies as Record<string, string>) || {}).length
    const devDependenciesCount = Object.keys((pkg.devDependencies as Record<string, string>) || {}).length

    const expectedFiles = (options.expectedFiles ?? []).filter((f) => typeof f === 'string' && f.trim())
    const minFileBytes =
      typeof options.minFileBytes === 'number' && Number.isFinite(options.minFileBytes)
        ? Math.max(0, Math.floor(options.minFileBytes))
        : 1
    const fileChecks = expectedFiles.map((file) => fileEvidence(targetDir, file))
    const failedFileChecks = fileChecks.filter((f) => !f.exists || f.bytes < minFileBytes)
    const expectedVerified = failedFileChecks.length === 0

    const baseData = {
      name: typeof pkg.name === 'string' ? pkg.name : basename(targetDir) || 'unnamed-project',
      path: targetDir,
      created: resolvedDir.created,
      language,
      hasGit,
      hasReadme,
      scripts,
      testRunner,
      dependenciesCount,
      devDependenciesCount,
      files,
      expectedFiles: fileChecks,
      verified: expectedVerified,
      minFileBytes,
    }

    if (failedFileChecks.length > 0) {
      const missing = failedFileChecks
        .map((f) => `${f.path}${f.exists ? ` (${f.bytes} bytes)` : ' (missing)'}`)
        .join(', ')
      return {
        ok: false,
        message: `Expected file verification failed: ${missing}.`,
        error: 'expected_files_unverified',
        data: baseData,
      }
    }

    return {
      ok: true,
      message: `Project ${baseData.name} analyzed at ${targetDir}: ${language}, test runner: ${testRunner}, ${scripts.length} scripts${expectedFiles.length > 0 ? `, ${expectedFiles.length} expected file(s) verified` : ''}.`,
      data: baseData,
    }
  }

  async gitStatus(projectPath: string): Promise<DevActionResult> {
    const resolvedDir = resolveProjectDir(projectPath)
    if (!resolvedDir.ok) return { ok: false, message: resolvedDir.message, error: 'invalid_project_path' }
    const targetDir = resolvedDir.dir

    if (!existsSync(join(targetDir, '.git'))) {
      return {
        ok: true,
        message: `No Git repository at ${targetDir}; working tree status is unavailable until a checkpoint initializes one.`,
        data: {
          hasGit: false,
          branch: null,
          clean: true,
          modifiedFiles: [],
          rawHeader: '',
        },
      }
    }

    const statusRes = await runProcess('git', ['status', '--porcelain', '-b'], targetDir, 15_000)
    if (statusRes.exitCode !== 0) {
      return {
        ok: false,
        message: `git status failed in ${targetDir}: ${statusRes.stderr || statusRes.stdout || statusRes.error || 'unknown error'}`,
        error: 'git_status_failed',
      }
    }

    const lines = statusRes.stdout.split(/\r?\n/).filter((line) => line.length > 0)
    const branchHeader = lines[0] || ''
    const fileLines = lines.slice(1)

    const branch = branchHeader.replace(/^##\s+/, '').split('...')[0].trim() || 'unknown'
    const modifiedFiles = fileLines.map((line) => line.slice(3).trim()).filter(Boolean)
    const isClean = fileLines.length === 0

    return {
      ok: true,
      message: `Git repository on branch "${branch}". Status: ${isClean ? 'clean working tree' : `${modifiedFiles.length} modified/untracked file(s)`}.`,
      data: {
        hasGit: true,
        branch,
        clean: isClean,
        modifiedFiles,
        rawHeader: branchHeader,
      },
    }
  }

  async gitCheckpoint(projectPath: string, checkpointName?: string): Promise<DevActionResult> {
    const resolvedDir = resolveProjectDir(projectPath)
    if (!resolvedDir.ok) return { ok: false, message: resolvedDir.message, error: 'invalid_project_path' }
    const targetDir = resolvedDir.dir

    let createdRepo = false
    if (!existsSync(join(targetDir, '.git'))) {
      const initRes = await runProcess('git', ['init'], targetDir, 15_000)
      if (initRes.exitCode !== 0) {
        return {
          ok: false,
          message: `Could not initialize Git repository in ${targetDir}: ${initRes.stderr || initRes.stdout}`,
          error: 'git_init_failed',
        }
      }
      createdRepo = true
    }

    // Ensure there is at least one commit so branching is possible. Only a
    // repository JARVIS just created is committed automatically.
    const revCheck = await runProcess('git', ['rev-parse', '--verify', 'HEAD'], targetDir, 10_000)
    if (revCheck.exitCode !== 0) {
      await runProcess('git', ['config', 'user.name', 'JARVIS'], targetDir, 5000)
      await runProcess('git', ['config', 'user.email', 'jarvis@local'], targetDir, 5000)
      const addRes = await runProcess('git', ['add', '-A'], targetDir, 15_000)
      if (addRes.exitCode !== 0) {
        return {
          ok: false,
          message: `Could not stage initial checkpoint files: ${addRes.stderr || addRes.stdout}`,
          error: 'git_add_failed',
        }
      }
      const commitRes = await runProcess(
        'git',
        ['commit', '--allow-empty', '-m', 'Initial commit before JARVIS checkpoint'],
        targetDir,
        15_000,
      )
      if (commitRes.exitCode !== 0) {
        return {
          ok: false,
          message: `Could not create initial commit: ${commitRes.stderr || commitRes.stdout}`,
          error: 'git_commit_failed',
        }
      }
    }

    // Preserve uncommitted work by pointing the checkpoint branch at a
    // disposable stash commit (git stash create does not touch the worktree).
    const statusRes = await runProcess('git', ['status', '--porcelain'], targetDir, 10_000)
    const dirty = statusRes.exitCode === 0 && statusRes.stdout.trim().length > 0
    let preservedWorkingTree = false
    let checkpointRef = 'HEAD'

    if (dirty) {
      const stashRes = await runProcess(
        'git',
        ['stash', 'create', 'JARVIS checkpoint of uncommitted work'],
        targetDir,
        15_000,
      )
      const stashSha = stashRes.stdout.trim()
      if (stashRes.exitCode === 0 && /^[0-9a-f]{7,40}$/i.test(stashSha)) {
        checkpointRef = stashSha
        preservedWorkingTree = true
      }
    }

    const suffix =
      typeof checkpointName === 'string' && checkpointName.trim()
        ? checkpointName.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)
        : `${Date.now()}`

    let branchName = `jarvis/checkpoint-${suffix}`
    let branchRes = await runProcess('git', ['branch', branchName, checkpointRef], targetDir, 10_000)
    if (branchRes.exitCode !== 0) {
      // A repeated retry must not fail just because the branch name exists.
      branchName = `${branchName}-${Date.now()}`
      branchRes = await runProcess('git', ['branch', branchName, checkpointRef], targetDir, 10_000)
    }
    if (branchRes.exitCode !== 0) {
      return {
        ok: false,
        message: `Failed to create checkpoint branch in ${targetDir}: ${branchRes.stderr || branchRes.stdout}`,
        error: 'git_checkpoint_failed',
      }
    }

    const verifyRes = await runProcess('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], targetDir, 10_000)
    if (verifyRes.exitCode !== 0) {
      return {
        ok: false,
        message: `Checkpoint branch ${branchName} could not be verified: ${verifyRes.stderr || verifyRes.stdout}`,
        error: 'git_checkpoint_unverified',
      }
    }
    const commit = verifyRes.stdout.trim()

    return {
      ok: true,
      message: `Created safety checkpoint branch "${branchName}" at ${commit.slice(0, 12)}${preservedWorkingTree ? ' preserving the dirty working tree' : ''}.`,
      data: {
        checkpointBranch: branchName,
        commit,
        createdRepo,
        dirty,
        preservedWorkingTree,
        verified: true,
        createdAt: Date.now(),
      },
    }
  }

  async patchFile(
    projectPath: string,
    filePath: string,
    target: string,
    replacement: string,
    extraParams?: Record<string, unknown>,
  ): Promise<DevActionResult> {
    const resolvedDir = resolveProjectDir(projectPath)
    if (!resolvedDir.ok) return { ok: false, message: resolvedDir.message, error: 'invalid_project_path' }
    const baseDir = resolvedDir.dir

    const resolvedFile = resolveProjectFile(baseDir, filePath)
    if (!resolvedFile.ok) return { ok: false, message: resolvedFile.message, error: 'invalid_file_path' }
    const fullPath = resolvedFile.path
    const relativePath = resolvedFile.relativePath
    const fileExists = existsSync(fullPath)
    const createIfMissing = extraParams?.createIfMissing === true

    if (typeof replacement !== 'string') {
      return { ok: false, message: 'replacement must be a string.', error: 'invalid_replacement' }
    }

    if (!fileExists) {
      if (!createIfMissing) {
        return {
          ok: false,
          message: `File not found: ${relativePath}. Set createIfMissing: true to create a new file.`,
          error: 'file_not_found',
        }
      }
      if (replacement.length === 0) {
        return { ok: false, message: `Refusing to create an empty file: ${relativePath}`, error: 'empty_file' }
      }
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, replacement, 'utf-8')
      const onDisk = readFileSync(fullPath, 'utf-8')
      const verified = onDisk === replacement
      return {
        ok: verified,
        message: verified
          ? `Created ${relativePath} (${replacement.length} bytes) and re-read it from disk.`
          : `Created ${relativePath}, but the on-disk content did not match the requested content.`,
        error: verified ? undefined : 'write_unverified',
        data: {
          filePath: relativePath,
          created: true,
          bytesBefore: 0,
          bytesAfter: Buffer.byteLength(replacement, 'utf8'),
          sha256: sha256(onDisk),
          verified,
        },
      }
    }

    const originalContent = readFileSync(fullPath, 'utf-8')

    // An existing file may only be changed through an exact target match.
    // A retry that finds the file already identical is an honest no-op.
    if (!target) {
      if (originalContent === replacement) {
        return {
          ok: true,
          message: `${relativePath} already contains the requested content; no write was needed.`,
          data: {
            filePath: relativePath,
            created: false,
            alreadyApplied: true,
            bytesBefore: Buffer.byteLength(originalContent, 'utf8'),
            bytesAfter: Buffer.byteLength(originalContent, 'utf8'),
            sha256: sha256(originalContent),
            verified: true,
          },
        }
      }
      return {
        ok: false,
        message: `Refusing to overwrite existing file ${relativePath} without an exact target segment. Blind overwrites are forbidden.`,
        error: 'blind_overwrite_forbidden',
      }
    }

    const occurrences = originalContent.split(target).length - 1
    if (occurrences === 0) {
      return {
        ok: false,
        message: `Target text segment not found in ${relativePath}. Blind overwrites are forbidden.`,
        error: 'target_not_found',
      }
    }

    const backupPath = `${fullPath}.jarvis.bak`
    writeFileSync(backupPath, originalContent, 'utf-8')

    const updatedContent = originalContent.replace(target, replacement)
    writeFileSync(fullPath, updatedContent, 'utf-8')
    const onDisk = readFileSync(fullPath, 'utf-8')
    const verified = onDisk === updatedContent

    return {
      ok: verified,
      message: verified
        ? `Applied targeted patch to ${relativePath}; backup saved to ${basename(backupPath)}.`
        : `Patched ${relativePath}, but the on-disk content did not match the expected result.`,
      error: verified ? undefined : 'write_unverified',
      data: {
        filePath: relativePath,
        created: false,
        occurrences,
        bytesBefore: Buffer.byteLength(originalContent, 'utf8'),
        bytesAfter: Buffer.byteLength(onDisk, 'utf8'),
        backupPath: relative(baseDir, backupPath),
        sha256Before: sha256(originalContent),
        sha256: sha256(onDisk),
        verified,
      },
    }
  }

  async runTests(projectPath: string, testCommand?: string, testFile?: string): Promise<DevActionResult> {
    const resolvedDir = resolveProjectDir(projectPath)
    if (!resolvedDir.ok) return { ok: false, message: resolvedDir.message, error: 'invalid_project_path' }
    const targetDir = resolvedDir.dir

    const packagePath = join(targetDir, 'package.json')
    let pkgScripts: Record<string, string> = {}
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as Record<string, unknown>
        pkgScripts = (pkg.scripts as Record<string, string>) || {}
      } catch {
        // A malformed manifest is not a reason to skip an explicit test file.
      }
    }

    const startTime = Date.now()
    let cmd: string
    let args: string[]

    if (testFile) {
      const resolvedTestFile = resolveProjectFile(targetDir, testFile)
      if (!resolvedTestFile.ok) {
        return { ok: false, message: resolvedTestFile.message, error: 'invalid_test_file' }
      }
      if (!existsSync(resolvedTestFile.path)) {
        return {
          ok: false,
          message: `Test file not found: ${resolvedTestFile.relativePath}`,
          error: 'test_file_not_found',
        }
      }
      if (resolvedTestFile.relativePath.endsWith('.py')) {
        cmd = process.platform === 'win32' ? 'python' : 'python3'
        args = ['-m', 'unittest', resolvedTestFile.relativePath]
      } else {
        cmd = 'npx'
        args = ['vitest', 'run', resolvedTestFile.relativePath]
      }
    } else if (testCommand) {
      const parsed = parseAllowedTestCommand(testCommand)
      if (!parsed.ok) {
        return { ok: false, message: parsed.message, error: 'test_command_rejected' }
      }
      cmd = parsed.cmd
      args = parsed.args
    } else {
      const fileNames = listTopLevel(targetDir).filter((f) => !f.directory).map((f) => f.name)
      const pythonTests = fileNames.filter((name) => /^(test_.*|.*_test)\.py$/i.test(name))
      if (pythonTests.length > 0) {
        cmd = process.platform === 'win32' ? 'python' : 'python3'
        args = ['-m', 'unittest', 'discover', '-s', '.', '-p', 'test*.py', '-v']
      } else if (pkgScripts.test) {
        cmd = 'npm'
        args = ['test']
      } else {
        return {
          ok: false,
          message: `No supported test runner detected in ${targetDir}. Add a "test" script or a Python test_*.py file.`,
          error: 'no_test_runner',
          data: { passed: false, exitCode: null, durationMs: 0, passedCount: 0, failedCount: 0 },
        }
      }
    }

    const proc = await runProcess(cmd, args, targetDir, TEST_TIMEOUT_MS)
    const durationMs = Date.now() - startTime
    const combinedOutput = `${proc.stdout}\n${proc.stderr}`
    const counts = parseTestCounts(combinedOutput)
    const failedFromCounts = counts.failedCount > 0
    const passed = proc.exitCode === 0 && !failedFromCounts

    const commandLine = [cmd, ...args].join(' ')
    const summary = passed
      ? `Tests passed cleanly in ${durationMs}ms (exit code 0)${counts.known ? `: ${counts.passedCount} passed, ${counts.failedCount} failed.` : '.'}`
      : `Tests failed (exit code ${proc.exitCode})${counts.known ? `: ${counts.passedCount} passed, ${counts.failedCount} failed` : ''}.`

    return {
      ok: passed,
      message: summary,
      error: passed ? undefined : 'tests_failed',
      data: {
        passed,
        verified: passed,
        exitCode: proc.exitCode,
        durationMs,
        command: commandLine,
        passedCount: counts.passedCount,
        failedCount: counts.failedCount,
        countKnown: counts.known,
        spawnError: proc.error,
        outputSnippet: combinedOutput.slice(-4000),
      },
    }
  }

  async auditProject(projectPath: string): Promise<DevActionResult> {
    const resolvedDir = resolveProjectDir(projectPath)
    if (!resolvedDir.ok) return { ok: false, message: resolvedDir.message, error: 'invalid_project_path' }
    const targetDir = resolvedDir.dir

    const packagePath = join(targetDir, 'package.json')
    let pkg: Record<string, unknown> = {}
    if (existsSync(packagePath)) {
      try {
        pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as Record<string, unknown>
      } catch {
        // Detection below treats an unreadable manifest as absent.
      }
    }
    const scripts = (pkg.scripts as Record<string, string>) || {}
    const devDependencies = (pkg.devDependencies as Record<string, string>) || {}
    const hasTsConfig = existsSync(join(targetDir, 'tsconfig.json'))
    const fileNames = listTopLevel(targetDir).filter((f) => !f.directory).map((f) => f.name)
    const hasPython = fileNames.some((name) => name.endsWith('.py'))

    const checks: Array<{ name: string; command: string; exitCode: number; passed: boolean; output: string }> = []

    if (hasTsConfig) {
      const tscRes = await runProcess('npx', ['tsc', '--noEmit'], targetDir, COMMAND_TIMEOUT_MS)
      checks.push({
        name: 'typescript',
        command: 'npx tsc --noEmit',
        exitCode: tscRes.exitCode,
        passed: tscRes.exitCode === 0,
        output: `${tscRes.stdout}\n${tscRes.stderr}`.slice(-2000),
      })
    } else if (typeof scripts.typecheck === 'string') {
      const typeRes = await runProcess('npm', ['run', 'typecheck'], targetDir, COMMAND_TIMEOUT_MS)
      checks.push({
        name: 'typecheck',
        command: 'npm run typecheck',
        exitCode: typeRes.exitCode,
        passed: typeRes.exitCode === 0,
        output: `${typeRes.stdout}\n${typeRes.stderr}`.slice(-2000),
      })
    } else if (devDependencies.typescript && typeof scripts.build === 'string') {
      const buildRes = await runProcess('npm', ['run', 'build'], targetDir, COMMAND_TIMEOUT_MS)
      checks.push({
        name: 'build',
        command: 'npm run build',
        exitCode: buildRes.exitCode,
        passed: buildRes.exitCode === 0,
        output: `${buildRes.stdout}\n${buildRes.stderr}`.slice(-2000),
      })
    }

    if (typeof scripts.lint === 'string') {
      const lintRes = await runProcess('npm', ['run', 'lint'], targetDir, COMMAND_TIMEOUT_MS)
      checks.push({
        name: 'lint',
        command: 'npm run lint',
        exitCode: lintRes.exitCode,
        passed: lintRes.exitCode === 0,
        output: `${lintRes.stdout}\n${lintRes.stderr}`.slice(-2000),
      })
    }

    if (hasPython) {
      const pyCmd = process.platform === 'win32' ? 'python' : 'python3'
      const compileRes = await runProcess(pyCmd, ['-m', 'compileall', '-q', '.'], targetDir, COMMAND_TIMEOUT_MS)
      checks.push({
        name: 'python-compile',
        command: `${pyCmd} -m compileall -q .`,
        exitCode: compileRes.exitCode,
        passed: compileRes.exitCode === 0,
        output: `${compileRes.stdout}\n${compileRes.stderr}`.slice(-2000),
      })
    }

    if (checks.length === 0) {
      return {
        ok: true,
        message: `No compiler, typechecker, or linter is configured in ${targetDir}; audit was skipped honestly.`,
        data: {
          passed: true,
          skipped: true,
          checks: [],
          outputSnippet: '',
        },
      }
    }

    const passed = checks.every((check) => check.passed)
    return {
      ok: passed,
      message: passed
        ? `Project audit passed (${checks.map((c) => c.name).join(', ')}).`
        : `Project audit detected issues: ${checks.filter((c) => !c.passed).map((c) => c.name).join(', ')} failed.`,
      error: passed ? undefined : 'audit_failed',
      data: {
        passed,
        verified: passed,
        skipped: false,
        checks,
        outputSnippet: checks.map((c) => `--- ${c.name} (exit ${c.exitCode}) ---\n${c.output}`).join('\n').slice(-4000),
      },
    }
  }

  async generateReport(
    projectPath: string,
    title?: string,
    subtasksSummary?: string,
    options: GenerateReportOptions = {},
  ): Promise<DevActionResult> {
    const resolvedDir = resolveProjectDir(projectPath)
    if (!resolvedDir.ok) return { ok: false, message: resolvedDir.message, error: 'invalid_project_path' }
    const targetDir = resolvedDir.dir

    const reportFile = typeof options.reportFile === 'string' && options.reportFile.trim()
      ? options.reportFile.trim()
      : 'JARVIS_EXECUTION_REPORT.md'
    const resolvedReport = resolveProjectFile(targetDir, reportFile)
    if (!resolvedReport.ok) return { ok: false, message: resolvedReport.message, error: 'invalid_report_path' }

    const inspection = await this.inspectProject(targetDir)
    const status = await this.gitStatus(targetDir)
    const inspectData = (inspection.data ?? {}) as Record<string, unknown>
    const gitData = (status.data ?? {}) as Record<string, unknown>

    const requiredFiles = (options.requiredFiles ?? []).filter(
      (file): file is string => typeof file === 'string' && file.trim().length > 0,
    )
    const fileChecks = requiredFiles.map((file) => fileEvidence(targetDir, file))
    const requiredFilesVerified = fileChecks.every((file) => file.exists && file.bytes > 0)

    const evidence = (options.evidence ?? {}) as Record<string, unknown>
    const testResults = evidence.testResults as Record<string, unknown> | undefined
    const checkpointEvidence = evidence.checkpoint as Record<string, unknown> | undefined
    const fileChanges = Array.isArray(evidence.fileChanges)
      ? (evidence.fileChanges as Array<Record<string, unknown>>)
      : []
    const testVerified =
      testResults?.passed === true &&
      testResults?.exitCode === 0 &&
      testResults?.failedCount !== undefined &&
      Number(testResults.failedCount) === 0

    const reportTitle = title || `JARVIS Execution Report: ${basename(targetDir) || targetDir}`
    const timestamp = new Date().toISOString()

    const gitSection = gitData.hasGit
      ? [
          `- Branch: \`${String(gitData.branch ?? 'unknown')}\``,
          `- Working tree: ${gitData.clean === true ? 'clean' : `${(gitData.modifiedFiles as unknown[] | undefined)?.length ?? 0} modified/untracked file(s)`}`,
          ...(checkpointEvidence?.checkpointBranch
            ? [`- Safety checkpoint: \`${String(checkpointEvidence.checkpointBranch)}\` (commit ${String(checkpointEvidence.commit ?? 'unknown')})`]
            : []),
        ]
      : ['- No Git repository was present; Git evidence is unavailable.']

    const testSection = testResults
      ? [
          `- Command: \`${String(testResults.command ?? 'unknown')}\``,
          `- Exit code: ${String(testResults.exitCode ?? 'unknown')}`,
          `- Passed / failed: ${String(testResults.passedCount ?? 'unknown')} / ${String(testResults.failedCount ?? 'unknown')}`,
          `- Duration: ${String(testResults.durationMs ?? 'unknown')}ms`,
          '',
          '```text',
          String(testResults.outputSnippet ?? '').slice(-2000),
          '```',
        ]
      : ['- No test execution evidence was supplied to the report step. No pass/fail claim is made.']

    const fileSection =
      fileChecks.length > 0
        ? fileChecks.map(
            (file) =>
              `- \`${file.path}\`: ${file.exists ? `${file.bytes} bytes, sha256 \`${file.sha256 ?? 'unavailable'}\`` : 'MISSING'}`,
          )
        : ['- No required files were declared for this report.']

    const changeSection =
      fileChanges.length > 0
        ? fileChanges.map((change) => {
            const path = String(change.filePath ?? 'unknown')
            const created = change.created === true ? 'created' : 'patched'
            const sha = change.sha256 ? `, sha256 \`${String(change.sha256)}\`` : ''
            return `- \`${path}\`: ${created}, ${String(change.bytesAfter ?? 'unknown')} bytes${sha}`
          })
        : ['- No file changes were reported by the execution pipeline.']

    const verificationLines = [
      `- Required files on disk: ${requiredFilesVerified ? 'PASS' : 'FAIL'}`,
      `- Test execution: ${testVerified ? 'PASS (exit code 0, 0 failures)' : 'NOT VERIFIED'}`,
      `- Report written and re-read: PENDING`,
    ]

    const content = [
      `# ${reportTitle}`,
      '',
      `**Generated At:** ${timestamp}`,
      `**Project Path:** \`${targetDir}\``,
      `**Objective:** ${subtasksSummary || 'Not supplied.'}`,
      '',
      '## 1. Generated / Required Files',
      ...fileSection,
      '',
      '## 2. File Changes',
      ...changeSection,
      '',
      '## 3. Git State',
      ...gitSection,
      '',
      '## 4. Test Execution Evidence',
      ...testSection,
      '',
      '## 5. Verification Checks',
      ...verificationLines,
      '',
      '## 6. Honesty Notes',
      '- This report was generated from observed filesystem, Git, and process evidence.',
      '- No passing test result is claimed unless a real test process exited with code 0 and reported zero failures.',
      '- No file content is claimed unless it was written and re-read from disk.',
      '',
      '## 7. Project Inspection Snapshot',
      '```json',
      JSON.stringify(
        {
          language: inspectData.language,
          testRunner: inspectData.testRunner,
          hasGit: inspectData.hasGit,
          scripts: inspectData.scripts,
          expectedFiles: inspectData.expectedFiles,
        },
        null,
        2,
      ),
      '```',
      '',
    ].join('\n')

    let written = false
    try {
      writeFileSync(resolvedReport.path, content, 'utf-8')
      written = true
    } catch (err) {
      return {
        ok: false,
        message: `Could not write report ${resolvedReport.relativePath}: ${err instanceof Error ? err.message : String(err)}`,
        error: 'report_write_failed',
      }
    }

    // The report can only claim it was re-read after that has actually happened.
    // Rewrite the one verification line, then re-read the final bytes.
    let finalContent = content
    let reportVerified = written && readFileSync(resolvedReport.path, 'utf-8') === content
    if (reportVerified) {
      finalContent = content.replace(
        '- Report written and re-read: PENDING',
        '- Report written and re-read: PASS',
      )
      writeFileSync(resolvedReport.path, finalContent, 'utf-8')
      reportVerified = readFileSync(resolvedReport.path, 'utf-8') === finalContent
    }
    const verified = reportVerified && requiredFilesVerified && testVerified

    return {
      ok: verified,
      message: verified
        ? `Generated ${resolvedReport.relativePath} with verified files and real test evidence.`
        : `Wrote ${resolvedReport.relativePath}, but completion verification failed (required files: ${requiredFilesVerified ? 'ok' : 'missing'}, test evidence: ${testVerified ? 'ok' : 'not verified'}).`,
      error: verified ? undefined : 'report_verification_failed',
      data: {
        reportPath: resolvedReport.path,
        reportFile: resolvedReport.relativePath,
        content: finalContent,
        report: finalContent,
        timestamp,
        requiredFiles: fileChecks,
        testVerified,
        requiredFilesVerified,
        reportVerified,
        verified,
      },
    }
  }

  async execute(action: string, params: Record<string, unknown>): Promise<DevActionResult> {
    const rawPath = typeof params.projectPath === 'string' ? params.projectPath : ''
    const projectPath = normalizeProjectPath(rawPath)

    switch (action) {
      case 'dev.inspectProject':
      case 'inspectProject': {
        const expectedFiles = Array.isArray(params.expectedFiles)
          ? params.expectedFiles.filter((file): file is string => typeof file === 'string')
          : undefined
        return this.inspectProject(projectPath, {
          ensureDirectory: params.ensureDirectory === true,
          expectedFiles,
          minFileBytes: typeof params.minFileBytes === 'number' ? params.minFileBytes : undefined,
        })
      }

      case 'dev.gitStatus':
      case 'gitStatus':
        return this.gitStatus(projectPath)

      case 'dev.gitCheckpoint':
      case 'gitCheckpoint':
        return this.gitCheckpoint(
          projectPath,
          typeof params.checkpointName === 'string'
            ? params.checkpointName
            : typeof params.message === 'string'
              ? params.message
              : undefined,
        )

      case 'dev.patchFile':
      case 'patchFile':
        return this.patchFile(
          projectPath,
          typeof params.filePath === 'string' ? params.filePath : '',
          typeof (params.target ?? params.find) === 'string'
            ? ((params.target ?? params.find) as string)
            : '',
          typeof (params.replacement ?? params.replace) === 'string'
            ? ((params.replacement ?? params.replace) as string)
            : '',
          params,
        )

      case 'dev.runTests':
      case 'runTests':
        return this.runTests(
          projectPath,
          typeof params.testCommand === 'string' ? params.testCommand : undefined,
          typeof params.testFile === 'string' ? params.testFile : undefined,
        )

      case 'dev.auditProject':
      case 'auditProject':
        return this.auditProject(projectPath)

      case 'dev.generateReport':
      case 'generateReport':
        return this.generateReport(
          projectPath,
          typeof params.title === 'string' ? params.title : undefined,
          typeof params.subtasksSummary === 'string'
            ? params.subtasksSummary
            : typeof params.summary === 'string'
              ? params.summary
              : undefined,
          {
            reportFile: typeof params.reportFile === 'string' ? params.reportFile : undefined,
            requiredFiles: Array.isArray(params.requiredFiles)
              ? params.requiredFiles.filter((file): file is string => typeof file === 'string')
              : undefined,
            evidence:
              params.evidence && typeof params.evidence === 'object'
                ? (params.evidence as Record<string, unknown>)
                : undefined,
          },
        )

      default:
        return {
          ok: false,
          message: `Unknown dev action: ${action}`,
          error: 'unknown_action',
        }
    }
  }
}

/* ------------------------------------------------------------ test parsing */

interface ParsedTestCounts {
  passedCount: number
  failedCount: number
  known: boolean
}

function parseTestCounts(output: string): ParsedTestCounts {
  const pyRan = output.match(/Ran\s+(\d+)\s+tests?/i)
  if (pyRan) {
    const total = Number.parseInt(pyRan[1], 10)
    const failures = Number.parseInt(output.match(/failures=(\d+)/i)?.[1] ?? '0', 10)
    const errors = Number.parseInt(output.match(/errors=(\d+)/i)?.[1] ?? '0', 10)
    const failed = failures + errors
    return {
      passedCount: Math.max(0, total - failed),
      failedCount: failed,
      known: true,
    }
  }

  // node:test / TAP
  const tapPass = output.match(/^#\s*pass\s+(\d+)/im)
  const tapFail = output.match(/^#\s*fail\s+(\d+)/im)
  if (tapPass || tapFail) {
    return {
      passedCount: Number.parseInt(tapPass?.[1] ?? '0', 10),
      failedCount: Number.parseInt(tapFail?.[1] ?? '0', 10),
      known: true,
    }
  }

  // vitest / jest
  const passMatch = output.match(/(?:Tests?:\s+)?(\d+)\s+passed/i)
  const failMatch = output.match(/(?:Tests?:\s+)?(\d+)\s+failed/i)
  if (passMatch || failMatch) {
    return {
      passedCount: Number.parseInt(passMatch?.[1] ?? '0', 10),
      failedCount: Number.parseInt(failMatch?.[1] ?? '0', 10),
      known: true,
    }
  }

  return { passedCount: 0, failedCount: 0, known: false }
}

/* ------------------------------------------------------ command allowlist */

const SHELL_METACHARACTERS = /[&|;<>`$]|\r|\n/

function tokenizeCommand(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

function parseAllowedTestCommand(
  command: string,
): { ok: true; cmd: string; args: string[] } | { ok: false; message: string } {
  if (SHELL_METACHARACTERS.test(command)) {
    return {
      ok: false,
      message: `Refusing test command with shell metacharacters: ${command}`,
    }
  }

  const tokens = tokenizeCommand(command)
  if (tokens.length === 0) return { ok: false, message: 'testCommand is empty.' }

  const [cmd, ...args] = tokens
  const executable = cmd.toLowerCase()

  if (executable === 'npm') {
    if (args.length === 1 && args[0] === 'test') return { ok: true, cmd: 'npm', args }
    return { ok: false, message: `Only "npm test" is allowed, received: ${command}` }
  }

  if (executable === 'npx') {
    if (args[0] === 'vitest' || args[0] === 'jest') {
      return { ok: true, cmd: 'npx', args }
    }
    return { ok: false, message: `Only npx vitest/jest are allowed, received: ${command}` }
  }

  if (executable === 'pytest') {
    return { ok: true, cmd: 'pytest', args }
  }

  if (executable === 'python' || executable === 'python3' || executable === 'py') {
    if (args[0] === '-m' && (args[1] === 'unittest' || args[1] === 'pytest')) {
      return { ok: true, cmd: executable === 'py' && process.platform === 'win32' ? 'python' : executable, args }
    }
    return {
      ok: false,
      message: `Only "python -m unittest" or "python -m pytest" are allowed, received: ${command}`,
    }
  }

  if (executable === 'node') {
    if (args[0] === '--test') return { ok: true, cmd: 'node', args }
    return { ok: false, message: `Only "node --test" is allowed, received: ${command}` }
  }

  return { ok: false, message: `Test executable is not allowlisted: ${cmd}` }
}
