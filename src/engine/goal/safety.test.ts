import { describe, expect, it } from 'vitest'
import type { Tool, ToolContext, ToolInput, ToolResult, ToolVerification } from '../../tools/Tool'
import { validatePlan, type ToolLookup } from './validatePlan'
import {
  isSafeFolder,
  isSafeWorkspacePath,
  isWorkspaceRelativeProperty,
  isFolderPathProperty,
} from './safety'

/**
 * The path-safety boundary has TWO contracts, and this file pins both.
 *
 * 1. CURATED FOLDER TOKENS — `open_folder`-style arguments. These must be a
 *    bounded `{userprofile}` / `{workspace}` / `{temp}` token. A bare relative
 *    path is NOT enough, and an absolute path is never allowed.
 *
 * 2. WORKSPACE-RELATIVE PATHS — the filesystem family, whose schema declares
 *    the path "relative to the workspace root". These are ordinary relative
 *    paths ("notes/todo.txt"); the tool's own `normalizeSafePath` is the
 *    enforcement point, and this plan-level check is the first line of
 *    defence for the same dangerous shapes.
 *
 * The dangerous shapes are rejected in BOTH contracts. Only the legal
 * workspace-relative form was ever allowed through.
 */
class CuratedFolderTool implements Tool {
  readonly id = 'open_folder'
  readonly category = 'system'
  readonly name = 'Open folder'
  readonly description = 'opens a curated folder'
  readonly permission = 'low_risk'
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      folder: { type: 'string', description: 'Folder path to open (a bounded curated token).' },
    },
    required: ['folder'],
  }
  readonly requiresPermission = false
  canRun(): boolean { return true }
  async execute(): Promise<ToolResult> { return { ok: true, message: 'done' } }
  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    return { ok: true, message: '' }
  }
}

class WorkspaceFileTool implements Tool {
  readonly id = 'file.write'
  readonly category = 'system'
  readonly name = 'Write file'
  readonly description = 'writes a file'
  readonly permission = 'low_risk'
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'Text file path relative to the workspace root.' },
      content: { type: 'string', description: 'Text content to write.' },
    },
    required: ['path'],
  }
  readonly requiresPermission = false
  canRun(): boolean { return true }
  async execute(): Promise<ToolResult> { return { ok: true, message: 'done' } }
  async verify(_i: ToolInput, _r: ToolResult, _c: ToolContext): Promise<ToolVerification> {
    return { ok: true, message: '' }
  }
}

const registry: ToolLookup = {
  get: (id) =>
    id === 'open_folder' ? new CuratedFolderTool() : id === 'file.write' ? new WorkspaceFileTool() : undefined,
}

describe('safety — curated folder tokens (unchanged contract)', () => {
  it('still allows the bounded curated tokens', () => {
    expect(isSafeFolder('{userprofile}')).toBe(true)
    expect(isSafeFolder('{userprofile}\\Documents')).toBe(true)
    expect(isSafeFolder('{workspace}')).toBe(true)
    expect(isSafeFolder('{temp}\\jarvis')).toBe(true)
  })

  it('still refuses an absolute path, a traversal and a bare relative path', () => {
    expect(isSafeFolder('C:\\Windows\\System32')).toBe(false)
    expect(isSafeFolder('\\\\server\\share')).toBe(false)
    expect(isSafeFolder('..\\..\\Windows')).toBe(false)
    expect(isSafeFolder('/etc')).toBe(false)
    // A bare relative path is NOT a curated token.
    expect(isSafeFolder('notes/todo.txt')).toBe(false)
    expect(isSafeFolder('notes')).toBe(false)
  })
})

describe('safety — workspace-relative paths', () => {
  it('allows the ordinary relative paths the filesystem tools document', () => {
    expect(isSafeWorkspacePath('')).toBe(true)
    expect(isSafeWorkspacePath('notes')).toBe(true)
    expect(isSafeWorkspacePath('notes/todo.txt')).toBe(true)
    expect(isSafeWorkspacePath('shopping.txt')).toBe(true)
    expect(isSafeWorkspacePath('a/b/c/d.txt')).toBe(true)
    expect(isSafeWorkspacePath('my notes.txt')).toBe(true)
  })

  it('refuses every dangerous shape — the same shapes the tool normalizer refuses', () => {
    // Drive letters and absolute paths.
    expect(isSafeWorkspacePath('C:\\Windows\\System32')).toBe(false)
    expect(isSafeWorkspacePath('C:/Windows/System32')).toBe(false)
    expect(isSafeWorkspacePath('C:')).toBe(false)
    expect(isSafeWorkspacePath('/etc/passwd')).toBe(false)
    expect(isSafeWorkspacePath('/usr/bin')).toBe(false)
    expect(isSafeWorkspacePath('\\\\server\\share')).toBe(false)
    // Traversal.
    expect(isSafeWorkspacePath('..')).toBe(false)
    expect(isSafeWorkspacePath('../secrets.txt')).toBe(false)
    expect(isSafeWorkspacePath('notes/../../secrets.txt')).toBe(false)
    // Shell-style expansion.
    expect(isSafeWorkspacePath('%TEMP%')).toBe(false)
    expect(isSafeWorkspacePath('%USERPROFILE%\\Documents')).toBe(false)
    // Control characters and absurd length.
    expect(isSafeWorkspacePath('notes\u0001.txt')).toBe(false)
    expect(isSafeWorkspacePath('x'.repeat(261))).toBe(false)
  })
})

describe('safety — schema classification', () => {
  it('recognises a workspace-relative argument from the schema', () => {
    expect(isWorkspaceRelativeProperty({ type: 'string', description: 'Text file path relative to the workspace root.' })).toBe(true)
    expect(isWorkspaceRelativeProperty({ type: 'string', description: 'Directory path relative to the workspace root (default "" = root).' })).toBe(true)
    expect(isWorkspaceRelativeProperty({ type: 'string', description: 'Search rooted here instead of the workspace root (optional).' })).toBe(true)
  })

  it('does NOT treat a curated-folder argument as workspace-relative', () => {
    expect(isWorkspaceRelativeProperty({ type: 'string', description: 'Folder path to open (a bounded curated token).' })).toBe(false)
    expect(isWorkspaceRelativeProperty({ type: 'string' })).toBe(false)
    expect(isWorkspaceRelativeProperty({ type: 'number', description: 'relative to the workspace root' })).toBe(false)
  })

  it('still recognises both as path-like arguments', () => {
    expect(isFolderPathProperty({ type: 'string', description: 'Text file path relative to the workspace root.' })).toBe(true)
    expect(isFolderPathProperty({ type: 'string', description: 'Folder path to open (a bounded curated token).' })).toBe(true)
  })
})

describe('safety — end to end through plan validation', () => {
  it('accepts a workspace-relative file path', () => {
    const { verdicts } = validatePlan([{ toolId: 'file.write', payload: { path: 'notes/todo.txt', content: 'x' } }], registry)
    expect(verdicts[0]).toEqual({ ok: true })
  })

  it('still rejects an absolute path passed to a filesystem tool', () => {
    const { verdicts } = validatePlan([{ toolId: 'file.write', payload: { path: 'C:\\Windows\\System32', content: 'x' } }], registry)
    expect(verdicts[0].ok).toBe(false)
    expect(verdicts[0]).toMatchObject({ code: 'unsafe_path' })
  })

  it('still rejects a traversal passed to a filesystem tool', () => {
    const { verdicts } = validatePlan([{ toolId: 'file.write', payload: { path: '../secrets.txt', content: 'x' } }], registry)
    expect(verdicts[0].ok).toBe(false)
    expect(verdicts[0]).toMatchObject({ code: 'unsafe_path' })
  })

  it('still rejects an absolute path passed to a curated-folder tool', () => {
    const { verdicts } = validatePlan([{ toolId: 'open_folder', payload: { folder: 'C:\\Windows\\System32' } }], registry)
    expect(verdicts[0].ok).toBe(false)
    expect(verdicts[0]).toMatchObject({ code: 'unsafe_path' })
  })

  it('still rejects a bare relative path passed to a curated-folder tool', () => {
    const { verdicts } = validatePlan([{ toolId: 'open_folder', payload: { folder: 'notes' } }], registry)
    expect(verdicts[0].ok).toBe(false)
    expect(verdicts[0]).toMatchObject({ code: 'unsafe_path' })
  })
})
