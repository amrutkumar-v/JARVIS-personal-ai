import type { NativeErrorCode } from './protocol.js'

/** Structured agent error: every agent failure carries a wire error code. */
export class NativeError extends Error {
  readonly code: NativeErrorCode
  readonly wirePath?: string

  constructor(code: NativeErrorCode, message: string, wirePath?: string) {
    super(message)
    this.name = 'NativeError'
    this.code = code
    this.wirePath = wirePath
  }
}

export function nativeError(code: NativeErrorCode, message: string, wirePath?: string): NativeError {
  return new NativeError(code, message, wirePath)
}

export function isNativeError(error: unknown): error is NativeError {
  return error instanceof NativeError
}