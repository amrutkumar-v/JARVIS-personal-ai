import { describe, expect, it } from 'vitest'
import { clipboardReadCommand, clipboardWriteCommand } from './clipboardInput.js'

/**
 * Phase 4.1: field validation on Windows PowerShell 5.1 exposed that the
 * Phase 4.0 backend used PowerShell 7-only parameters (`-InputObject`,
 * `-AsPlainText`) that do not exist on `powershell.exe` (5.1). These tests
 * pin the commands to the 5.1-compatible surface so the regression cannot
 * sneak back in.
 */
describe('clipboard PowerShell commands (Windows PowerShell 5.1 compatible)', () => {
  it('read command uses -Raw and verbatim console output, never -AsPlainText', () => {
    const cmd = clipboardReadCommand()
    expect(cmd).toContain('Get-Clipboard -Raw')
    expect(cmd).not.toContain('-AsPlainText')
    expect(cmd).not.toContain('-Format')
    expect(cmd).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8')
    expect(cmd).toContain('[Console]::Write($t)')
  })

  it('read command handles an empty clipboard without erroring', () => {
    const cmd = clipboardReadCommand()
    expect(cmd).toContain('if ($null -eq $t) { [Console]::Write(\'\') }')
  })

  it('write command uses -Value from raw stdin, never -InputObject', () => {
    const cmd = clipboardWriteCommand()
    expect(cmd).toContain('Set-Clipboard -Value ([Console]::In.ReadToEnd())')
    expect(cmd).not.toContain('-InputObject')
    expect(cmd).toContain('[Console]::InputEncoding = [System.Text.Encoding]::UTF8')
  })

  it('never interpolates user text into a command string (payload stays out of the command)', () => {
    // The only moving into PowerShell for writes is stdin; a payload string
    // must never be able to reach the command text itself.
    expect(clipboardWriteCommand()).not.toContain('$input')
    expect(clipboardWriteCommand()).not.toContain("'")
  })
})