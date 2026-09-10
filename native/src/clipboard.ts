import { nativeError } from './errors.js'

/**
 * Native Windows Agent — clipboard backend seam (Phase 4.0).
 *
 * The agent reads/writes the Windows clipboard exclusively through this narrow
 * interface. A real backend uses Win32 clipboard APIs over koffi FFI; a
 * tests-only memory backend drives protocol tests deterministically.
 *
 * Text operations only (CF_UNICODETEXT): the agent never reads binary
 * clipboard formats. Raw clipboard content is NEVER logged to the task log —
 * only metadata about the operation.
 */
export interface ClipboardBackend {
  /** Stable backend identifier (for diagnostics / testsOnly flags). */
  id: string
  /** Backends that are pure test doubles MUST set this true. */
  testsOnly?: boolean

  /** Read the current clipboard text content (CF_UNICODETEXT). */
  read(): Promise<ClipboardReadResult>

  /** Write text to the clipboard (CF_UNICODETEXT). Returns the verified write. */
  write(text: string): Promise<ClipboardWriteResult>
}

export interface ClipboardReadResult {
  success: boolean
  text: string
  /** Byte length of the UTF-16 text read. */
  byteLength: number
  /** True when the read was verified by re-reading the clipboard. */
  verified: boolean
}

export interface ClipboardWriteResult {
  success: boolean
  /** Byte length of the UTF-16 text written. */
  byteLength: number
  /** True when the write was verified by reading the clipboard back. */
  verified: boolean
}

/**
 * Limits for clipboard operations (defense-in-depth).
 */
export const CLIPBOARD_LIMITS = {
  /** Maximum characters allowed in a single write. */
  MAX_TEXT_LENGTH: 100_000,
  /** Maximum bytes returned by a single read. */
  MAX_READ_BYTES: 512 * 1024,
  /** Timeout for clipboard operations (ms). */
  TIMEOUT_MS: 5000,
} as const
