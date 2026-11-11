/**
 * Autonomous Development Agent — Type Definitions (Phase D).
 *
 * Enforces strict safety rails:
 * - Targeted line/chunk modifications (no blind full-file overwrites).
 * - Honest test execution with actual exit code verification.
 * - Git safety checkpoints to preserve working changes.
 * - Explicit permission gates for commits or remote pushes.
 */

export interface ProjectStackInfo {
  name: string
  rootPath: string
  language: 'typescript' | 'javascript' | 'python' | 'rust' | 'other'
  framework?: string
  hasGit: boolean
  gitBranch?: string
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  hasTests: boolean
  testRunner?: 'vitest' | 'jest' | 'pytest' | 'cargo' | 'npm'
}

export interface GitStatusResult {
  branch: string
  clean: boolean
  modifiedFiles: string[]
  untrackedFiles: string[]
  stagedFiles: string[]
  ahead: number
  behind: number
}

export interface TestExecutionResult {
  passed: boolean
  exitCode: number
  summary: string
  durationMs: number
  passedCount?: number
  failedCount?: number
  rawOutputSnippet: string
}

export interface FilePatchResult {
  success: boolean
  filePath: string
  replacements: number
  backupCreated?: boolean
  error?: string
}

export interface DevReport {
  projectName: string
  projectPath: string
  timestamp: number
  summary: string
  filesInspected: string[]
  filesModified: string[]
  gitCheckpointBranch?: string
  testResults?: TestExecutionResult
  verified: boolean
  remainingItems: string[]
}

