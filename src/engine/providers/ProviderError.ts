/**
 * Typed provider failures so the engine can map them to user-facing
 * notices without leaking internals. `userMessage` is always safe to show.
 */
export type ProviderIssue =
  | 'config'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'rate_limit'
  | 'malformed'
  | 'server'
  | 'payload'

export class ProviderError extends Error {
  readonly kind: ProviderIssue
  readonly status?: number

  constructor(kind: ProviderIssue, message: string, status?: number) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.status = status
  }
}

/** Safe, human-facing copy of a provider failure. */
export function userFacing(error: unknown): { kind: ProviderIssue; message: string } {
  if (error instanceof ProviderError) {
    return { kind: error.kind, message: error.message }
  }
  const msg = error instanceof Error ? error.message : 'unknown error'
  return { kind: 'network', message: `AI service error: ${msg}` }
}