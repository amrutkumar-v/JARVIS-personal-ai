/**
 * Autonomous Development Agent Tools (Phase D) — Browser-Safe Frontend Layer.
 *
 * Implements browser-safe Tool wrappers for the development agent capabilities:
 * - dev.inspectProject: stack and layout discovery.
 * - dev.gitStatus: branch and uncommitted modifications inspection.
 * - dev.gitCheckpoint: safety branch creation to preserve working code.
 * - dev.patchFile: targeted string/block replacement with zero blind overwrites.
 * - dev.runTests: honest test execution with real exit code and count verification.
 * - dev.auditProject: linter / compiler / typecheck audit.
 * - dev.generateReport: auditable completion report.
 *
 * All filesystem, Git, child process, and shell operations execute strictly
 * on the backend (server/src/dev/DevEngine.ts) via the authenticated /api/dev/execute endpoint.
 * Zero Node.js modules (fs, path, child_process) are imported here.
 */

import type {
  Tool,
  ToolContext,
  ToolInput,
  ToolPermission,
  ToolResult,
  ToolVerification,
} from '../../tools/Tool'
import type { ToolInputSchema } from '../provider'
import { ensureBackendSession, ensureNodeBackendSession, getNodeSessionCookie } from '../../backend/session'
import { getBackendConfig } from '../../backend/config'

export type DevActionExecutor = (
  action: string,
  params: Record<string, unknown>,
) => Promise<{ ok: boolean; message: string; data?: unknown; error?: string }>

export interface DevToolsOptions {
  executor?: DevActionExecutor
  backendUrl?: string
  fetchImpl?: typeof fetch
}

let globalDevExecutor: DevActionExecutor | null = null

export function setGlobalDevExecutor(executor: DevActionExecutor | null): void {
  globalDevExecutor = executor
}

async function dispatchDevAction(
  action: string,
  params: Record<string, unknown>,
  options?: DevToolsOptions,
): Promise<{ ok: boolean; message: string; data?: unknown; error?: string }> {
  if (options?.executor) {
    return options.executor(action, params)
  }
  if (globalDevExecutor) {
    return globalDevExecutor(action, params)
  }

  const baseUrl =
    options?.backendUrl ||
    (typeof window !== 'undefined'
      ? (window as unknown as Record<string, unknown>).__JARVIS_BACKEND_URL__ as string
      : undefined) ||
    // The page session cookie is host-scoped: the HUD talks to the backend on
    // `localhost`, so dev tools MUST use the same host as BackendClient rather
    // than hard-coding 127.0.0.1 (a different cookie origin).
    getBackendConfig().baseUrl

  const fetchFn =
    options?.fetchImpl ||
    (typeof fetch === 'function' ? fetch.bind(globalThis) : null)

  if (!fetchFn) {
    return { ok: false, message: 'fetch is unavailable to communicate with backend DevEngine.' }
  }

  try {
    if (typeof window === 'undefined') {
      await ensureNodeBackendSession(baseUrl, fetchFn).catch(() => {})
    } else {
      await ensureBackendSession(baseUrl, fetchFn).catch(() => {})
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    const nodeCookie = getNodeSessionCookie()
    if (nodeCookie) {
      headers['Cookie'] = nodeCookie
    }
    const res = await fetchFn(`${baseUrl}/api/dev/execute`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ action, params }),
    })

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>
      return {
        ok: false,
        message: (errBody.error as string) || `Backend returned HTTP ${res.status}`,
      }
    }

    return (await res.json()) as { ok: boolean; message: string; data?: unknown; error?: string }
  } catch (err) {
    return {
      ok: false,
      message: `Failed to connect to backend DevEngine at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Tool 1: Inspect Project Structure and Stack
 */
export class DevInspectProjectTool implements Tool {
  readonly id = 'dev.inspectProject'
  readonly name = 'Inspect Project'
  readonly description = 'Discovers repository structure, stack, dependencies, scripts, and documentation.'
  readonly category = 'system'
  readonly permission: ToolPermission = 'read_only'
  readonly requiresPermission = false
  readonly verifiable = true

  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Absolute or relative path to the project directory',
      },
      ensureDirectory: {
        type: 'boolean',
        description: 'Create the directory only when the plan explicitly builds a new project',
      },
      expectedFiles: {
        type: 'array',
        description: 'Project-relative files that must exist on disk after this step',
      },
      minFileBytes: {
        type: 'number',
        description: 'Minimum byte size for each expected file (default 1)',
      },
    },
    required: ['projectPath'],
  }

  private readonly options?: DevToolsOptions

  constructor(options?: DevToolsOptions) {
    this.options = options
  }

  canRun(query: string): boolean {
    return /inspect\s+(project|repo|stack)|analyze\s+project/i.test(query)
  }

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    return dispatchDevAction(this.id, input.params || {}, this.options)
  }

  async verify(input: ToolInput, result: ToolResult): Promise<ToolVerification> {
    const data = result.data as Record<string, unknown> | undefined
    const expected = Array.isArray(input.params?.expectedFiles)
      ? (input.params.expectedFiles as unknown[]).filter((f): f is string => typeof f === 'string')
      : []
    const pathVerified = typeof data?.path === 'string' && data.path.length > 0
    const filesVerified =
      expected.length === 0 ||
      (Array.isArray(data?.expectedFiles) &&
        (data.expectedFiles as Array<Record<string, unknown>>).every(
          (file) => file.exists === true && Number(file.bytes) >= Number(data?.minFileBytes ?? 1),
        )) &&
        data?.verified === true

    const verified = result.ok === true && pathVerified && filesVerified
    return {
      ok: verified,
      status: verified ? 'verified' : 'failed',
      message: verified
        ? expected.length > 0
          ? `Verified: project inspected and ${expected.length} expected file(s) exist on disk.`
          : `Verified: project inspected at ${String(data?.path)}.`
        : `Verification failed: project inspection did not confirm the expected directory/files.`,
    }
  }
}

/**
 * Tool 2: Git Status and Modifications Check
 */
export class DevGitStatusTool implements Tool {
  readonly id = 'dev.gitStatus'
  readonly name = 'Git Status'
  readonly description = 'Inspects branch, uncommitted modifications, and unstaged files to preserve user work.'
  readonly category = 'system'
  readonly permission: ToolPermission = 'read_only'
  readonly requiresPermission = false

  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Path to git repository root',
      },
    },
    required: ['projectPath'],
  }

  private readonly options?: DevToolsOptions

  constructor(options?: DevToolsOptions) {
    this.options = options
  }

  canRun(query: string): boolean {
    return /git\s+status|check\s+git|branch\s+status/i.test(query)
  }

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    return dispatchDevAction(this.id, input.params || {}, this.options)
  }
}

/**
 * Tool 3: Create Safe Git Checkpoint Branch
 */
export class DevGitCheckpointTool implements Tool {
  readonly id = 'dev.gitCheckpoint'
  readonly name = 'Git Safety Checkpoint'
  readonly description = 'Creates a local checkpoint branch to guarantee uncommitted work can never be lost.'
  readonly category = 'system'
  readonly permission: ToolPermission = 'low_risk'
  readonly requiresPermission = false
  readonly verifiable = true

  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Path to git repository root',
      },
      checkpointName: {
        type: 'string',
        description: 'Optional suffix or identifier for the checkpoint',
      },
    },
    required: ['projectPath'],
  }

  private readonly options?: DevToolsOptions

  constructor(options?: DevToolsOptions) {
    this.options = options
  }

  canRun(query: string): boolean {
    return /checkpoint|save\s+branch|backup\s+work/i.test(query)
  }

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    return dispatchDevAction(this.id, input.params || {}, this.options)
  }

  async verify(_input: ToolInput, result: ToolResult): Promise<ToolVerification> {
    const data = result.data as Record<string, unknown> | undefined
    const verified =
      result.ok === true &&
      typeof data?.checkpointBranch === 'string' &&
      data.checkpointBranch.length > 0 &&
      data?.verified === true
    return {
      ok: verified,
      status: verified ? 'verified' : 'failed',
      message: verified
        ? `Verified: checkpoint branch ${String(data?.checkpointBranch)} exists at ${String(data?.commit ?? 'unknown').slice(0, 12)}.`
        : 'Verification failed: no verified Git checkpoint branch was created.',
    }
  }
}

/**
 * Tool 4: Targeted File Patching (No Blind Overwrites)
 */
export class DevPatchFileTool implements Tool {
  readonly id = 'dev.patchFile'
  readonly name = 'Targeted File Patcher'
  readonly description = 'Applies a targeted string/block replacement to a file. Never blindly replaces whole files.'
  readonly category = 'system'
  readonly permission: ToolPermission = 'low_risk'
  readonly requiresPermission = false
  readonly verifiable = true

  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Absolute or project-relative file path',
      },
      target: {
        type: 'string',
        description: 'Exact text segment to be replaced (empty only when creating a new file)',
      },
      replacement: {
        type: 'string',
        description: 'Exact new text to replace the target with (full file content when creating)',
      },
      projectPath: {
        type: 'string',
        description: 'Base project directory for relative paths',
      },
      createIfMissing: {
        type: 'boolean',
        description: 'Create the file when it does not exist (requires a non-empty replacement)',
      },
    },
    required: ['filePath', 'replacement'],
  }

  private readonly options?: DevToolsOptions

  constructor(options?: DevToolsOptions) {
    this.options = options
  }

  canRun(query: string): boolean {
    return /patch\s+file|modify\s+file|edit\s+file|replace\s+in\s+file/i.test(query)
  }

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    return dispatchDevAction(this.id, input.params || {}, this.options)
  }

  async verify(input: ToolInput, result: ToolResult): Promise<ToolVerification> {
    const data = result.data as Record<string, unknown> | undefined
    const verified = result.ok === true && data?.verified === true
    const filePath = typeof input.params?.filePath === 'string' ? input.params.filePath : 'target file'

    return {
      ok: verified,
      status: verified ? 'verified' : 'failed',
      message: verified
        ? `Verified: ${data?.created === true ? 'created' : 'patched'} ${filePath} and re-read it from disk (sha256 ${String(data?.sha256 ?? 'unavailable').slice(0, 12)}).`
        : `Verification failed: ${filePath} was not confirmed on disk.`,
    }
  }
}

/**
 * Tool 5: Honest Test Execution
 */
export class DevRunTestsTool implements Tool {
  readonly id = 'dev.runTests'
  readonly name = 'Run Tests'
  readonly description = 'Executes project test suite and parses actual pass/fail counts and exit codes.'
  readonly category = 'system'
  readonly permission: ToolPermission = 'read_only'
  readonly requiresPermission = false
  readonly verifiable = true

  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Path to project root',
      },
      testCommand: {
        type: 'string',
        description: 'Optional test command (must be a standard npm/vitest test command)',
      },
      testFile: {
        type: 'string',
        description: 'Optional specific test file to run',
      },
    },
    required: ['projectPath'],
  }

  private readonly options?: DevToolsOptions

  constructor(options?: DevToolsOptions) {
    this.options = options
  }

  canRun(query: string): boolean {
    return /run\s+tests|execute\s+tests|run\s+vitest|run\s+unit\s+tests/i.test(query)
  }

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    return dispatchDevAction(this.id, input.params || {}, this.options)
  }

  async verify(_input: ToolInput, result: ToolResult): Promise<ToolVerification> {
    const data = result.data as Record<string, unknown> | undefined
    const passed = data?.passed === true && data?.exitCode === 0

    return {
      ok: passed,
      status: passed ? 'verified' : 'failed',
      message: passed
        ? `Verified: Test execution exited with code 0 in ${data?.durationMs}ms.`
        : `Verification failed: Tests did not pass (exit code ${data?.exitCode}).`,
    }
  }
}

/**
 * Tool 6: Project Compilation / Lint Audit
 */
export class DevAuditProjectTool implements Tool {
  readonly id = 'dev.auditProject'
  readonly name = 'Audit Project'
  readonly description = 'Runs typechecking and linting to ensure application integrity.'
  readonly category = 'system'
  readonly permission: ToolPermission = 'read_only'
  readonly requiresPermission = false
  readonly verifiable = true

  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Path to project root',
      },
    },
    required: ['projectPath'],
  }

  private readonly options?: DevToolsOptions

  constructor(options?: DevToolsOptions) {
    this.options = options
  }

  canRun(query: string): boolean {
    return /audit\s+project|check\s+types|lint\s+project/i.test(query)
  }

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    return dispatchDevAction(this.id, input.params || {}, this.options)
  }

  async verify(_input: ToolInput, result: ToolResult): Promise<ToolVerification> {
    const data = result.data as Record<string, unknown> | undefined
    const passed = result.ok && data?.passed === true

    return {
      ok: passed,
      status: passed ? 'verified' : 'failed',
      message: passed
        ? 'Verified: Project audit passed with zero type or linter errors.'
        : 'Verification failed: Project audit found compilation or lint issues.',
    }
  }
}

/**
 * Tool 7: Autonomous Report Generator
 */
export class DevGenerateReportTool implements Tool {
  readonly id = 'dev.generateReport'
  readonly name = 'Generate Completion Report'
  readonly description = 'Generates an auditable completion report detailing code modifications, git changes, and test results.'
  readonly category = 'system'
  readonly permission: ToolPermission = 'read_only'
  readonly requiresPermission = false
  readonly verifiable = true

  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Path to project root',
      },
      title: {
        type: 'string',
        description: 'Title of the report',
      },
      subtasksSummary: {
        type: 'string',
        description: 'Summary of subtasks executed',
      },
      reportFile: {
        type: 'string',
        description: 'Project-relative report filename (default JARVIS_EXECUTION_REPORT.md)',
      },
      requiredFiles: {
        type: 'array',
        description: 'Project-relative files that must exist for completion to be verified',
      },
      evidence: {
        type: 'object',
        description:
          'Observed evidence from earlier verified steps (testResults, checkpoint, fileChanges)',
      },
    },
    required: ['projectPath'],
  }

  private readonly options?: DevToolsOptions

  constructor(options?: DevToolsOptions) {
    this.options = options
  }

  canRun(query: string): boolean {
    return /generate\s+report|completion\s+report|task\s+report/i.test(query)
  }

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    return dispatchDevAction(this.id, input.params || {}, this.options)
  }

  async verify(_input: ToolInput, result: ToolResult): Promise<ToolVerification> {
    const data = result.data as Record<string, unknown> | undefined
    const verified =
      result.ok === true &&
      typeof data?.reportPath === 'string' &&
      typeof data?.report === 'string' &&
      data.report.length > 0 &&
      data?.verified === true

    return {
      ok: verified,
      status: verified ? 'verified' : 'failed',
      message: verified
        ? `Verified: completion report generated and re-read at ${String(data?.reportPath)}.`
        : 'Verification failed: completion report did not contain verified evidence.',
    }
  }
}

/**
 * Factory function to create all 7 development agent tools.
 */
export function createDevTools(options?: DevToolsOptions): Tool[] {
  return [
    new DevInspectProjectTool(options),
    new DevGitStatusTool(options),
    new DevGitCheckpointTool(options),
    new DevPatchFileTool(options),
    new DevRunTestsTool(options),
    new DevAuditProjectTool(options),
    new DevGenerateReportTool(options),
  ]
}
