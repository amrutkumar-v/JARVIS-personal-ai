/**
 * Clipboard capability seam (Phase 4.0).
 *
 * The engine reads/writes the Windows clipboard exclusively through this
 * OPTIONAL provider. When the native Windows agent is unreachable the provider
 * reports `available: false` and no clipboard.* tools are registered — the
 * model can never claim clipboard access it does not have.
 *
 * Raw clipboard content is NEVER logged — only operation metadata.
 */

export type ClipboardOp = 'read' | 'write'

export interface ClipboardCapabilities {
  /** False when the native agent is unreachable / not Windows. */
  available: boolean
  reason?: string
  ops: Record<ClipboardOp, boolean>
}

export interface ClipboardReadResult {
  success: boolean
  text: string
  byteLength: number
  verified: boolean
}

export interface ClipboardWriteResult {
  success: boolean
  byteLength: number
  verified: boolean
}

export interface ClipboardProvider {
  readonly id: string
  capabilities(): ClipboardCapabilities
  read(): Promise<ClipboardReadResult>
  write(text: string): Promise<ClipboardWriteResult>
}
