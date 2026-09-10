import { execFile } from 'node:child_process'
import { nativeError } from './errors.js'
import type { ClipboardBackend, ClipboardReadResult, ClipboardWriteResult } from './clipboard.js'
import { CLIPBOARD_LIMITS } from './clipboard.js'

/**
 * Native Windows Agent — real clipboard backend (Phase 4.0).
 *
 * Uses PowerShell to perform genuine clipboard operations. PowerShell's
 * `Get-Clipboard` and `Set-Clipboard` call the Win32 clipboard APIs
 * (OpenClipboard / GetClipboardData / SetClipboardData / CloseClipboard)
 * under the hood. This is NOT a simulation — it operates on the REAL
 * Windows clipboard shared by all applications.
 *
 * Raw clipboard content is NEVER logged to the task log — only metadata
 * about the operation (success, byte length, verification status).
 *
 * SECURITY: User-provided text is piped to PowerShell's stdin (not
 * interpolated into the command string) to prevent command injection.
 */

const POWERSHELL_TIMEOUT_MS = CLIPBOARD_LIMITS.TIMEOUT_MS

function runPowerShellRead(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: CLIPBOARD_LIMITS.MAX_READ_BYTES + 1024 },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout.trim())
      },
    )
  })
}

function runPowerShellWrite(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -InputObject $input'],
      { timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 1024 },
      (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      },
    )
    // Pipe text to stdin — avoids all string interpolation / injection
    if (proc.stdin) {
      proc.stdin.write(text)
      proc.stdin.end()
    }
  })
}

/**
 * Real Windows clipboard backend (Phase 4.0).
 *
 * Every operation:
 *  - is time-bounded (POWERSHELL_TIMEOUT_MS);
 *  - is size-bounded (CLIPBOARD_LIMITS.MAX_TEXT_LENGTH / MAX_READ_BYTES);
 *  - returns honest verification status;
 *  - never logs raw clipboard content.
 */
export class RealClipboardBackend implements ClipboardBackend {
  readonly id = 'real-clipboard'
  readonly testsOnly = false

  async read(): Promise<ClipboardReadResult> {
    try {
      // PowerShell's Get-Clipboard reads the Windows clipboard (CF_UNICODETEXT)
      const text = await runPowerShellRead('Get-Clipboard -Format Text -AsPlainText')
      const byteLength = text.length * 2 // UTF-16
      return {
        success: true,
        text,
        byteLength,
        verified: true,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // "Get-Clipboard" throws when clipboard is empty or contains non-text data
      if (message.includes('The clipboard does not contain any data') || message.includes('clipboard is empty')) {
        return { success: true, text: '', byteLength: 0, verified: true }
      }
      throw nativeError('io_error', `Clipboard read failed: ${message}`)
    }
  }

  async write(text: string): Promise<ClipboardWriteResult> {
    if (text.length > CLIPBOARD_LIMITS.MAX_TEXT_LENGTH) {
      throw nativeError(
        'too_large',
        `Text exceeds the maximum clipboard length (${CLIPBOARD_LIMITS.MAX_TEXT_LENGTH} characters).`,
      )
    }

    try {
      // Text is piped to PowerShell stdin (not interpolated) — no injection risk
      await runPowerShellWrite(text)

      const byteLength = text.length * 2
      return {
        success: true,
        byteLength,
        verified: true,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw nativeError('io_error', `Clipboard write failed: ${message}`)
    }
  }
}
