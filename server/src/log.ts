/**
 * Structured logging for the JARVIS Core backend (Phase 2.8).
 *
 * Every line is JSON with `t`, `level`, `scope`, `msg` and optional fields.
 * Values under sensitive key names (token, key, secret, password,
 * authorization, bearer, api key) are redacted to `[redacted]` before the
 * line is written — logs are never the place for credentials.
 */

import { appendFile } from 'node:fs/promises'

const SENSITIVE_KEY = /token|password|passwd|secret|authorization|bearer|api[_-]?key/i

export function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]'
  return value
}

export function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out[key] = redactRecord(value as Record<string, unknown>)
    } else {
      out[key] = redactValue(key, value)
    }
  }
  return out
}

export interface Logger {
  info(scope: string, msg: string, fields?: Record<string, unknown>): void
  warn(scope: string, msg: string, fields?: Record<string, unknown>): void
  error(scope: string, msg: string, fields?: Record<string, unknown>): void
}

export interface LoggerOptions {
  file?: string
  write?: (line: string) => void
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const sink = opts.write ?? ((line: string) => process.stdout.write(line + '\n'))
  let pending = Promise.resolve()

  const record = (level: 'info' | 'warn' | 'error', scope: string, msg: string, fields?: Record<string, unknown>): void => {
    const line = JSON.stringify(
      {
        t: new Date().toISOString(),
        level,
        scope,
        msg,
        ...(fields ? safeFields(fields) : {}),
      },
      (keeda, value) => {
        // Double safety: never serialize a field whose key is sensitive.
        if (typeof keeda === 'string' && SENSITIVE_KEY.test(keeda) && typeof value === 'string') {
          return '[redacted]'
        }
        return value
      },
    )
    sink(line)
    if (opts.file) {
      pending = pending
        .then(() => appendFile(opts.file as string, line + '\n', 'utf8'))
        .catch((error: unknown) => {
          // A full disk, a locked file or a bad path must not silently stop
          // the log: say so once on stderr, then carry on.
          const message = error instanceof Error ? error.message : String(error)
          process.stderr.write(`[jarvis-log] write failed: ${message}\n`)
        })
    }
  }

  const safeFields = (fields: Record<string, unknown>): Record<string, unknown> =>
    (Object.keys(fields).length > 0 ? redactRecord(fields) : {})

  return {
    info: (scope, msg, fields) => record('info', scope, msg, fields),
    warn: (scope, msg, fields) => record('warn', scope, msg, fields),
    error: (scope, msg, fields) => record('error', scope, msg, fields),
  }
}

/** Null logger for tests and quiet environments. */
export function nullLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }
}