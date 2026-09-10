/**
 * Outbound file store for the JARVIS Core backend (Phase 2.8).
 *
 * `device.sendFile` uploads bytes here; companion devices download them from
 * `/api/files/:id`. Files live under the data directory, are bounded, and
 * their names are sanitized (never a path).
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OutboundFile } from './types.js'

const MAX_FILE_BYTES = 25 * 1024 * 1024
const NAME_PATTERN = /^[\w., ()[\]-]{1,128}$/

export function sanitizeFileName(name: string): string {
  let cleaned = (name || '').trim()
  // Strip control characters (U+0000..U+001F) and Windows-path-forbidden
  // metacharacters by character test — never a path, never a control char.
  const out: string[] = []
  for (const ch of cleaned) {
    const code = ch.codePointAt(0) ?? 0
    out.push(code < 0x20 || '\\/:*?"<>|'.includes(ch) ? '_' : ch)
  }
  cleaned = out.join('')
  return cleaned.length > 0 ? cleaned.slice(0, 128) : 'file.bin'
}

export interface FileStoreOptions {
  dir: string
  maxBytes?: number
  now?: () => number
  generateId?: () => string
}

export class FileStore {
  private readonly dir: string
  private readonly maxBytes: number
  private readonly now: () => number
  private readonly generateId: () => string
  private readonly records = new Map<string, OutboundFile>()

  constructor(opts: FileStoreOptions) {
    this.dir = opts.dir
    this.maxBytes = opts.maxBytes ?? MAX_FILE_BYTES
    this.now = opts.now ?? (() => Date.now())
    this.generateId = opts.generateId ?? (() => `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  }

  private filePath(id: string): string {
    return join(this.dir, `${id}.bin`)
  }

  async save(name: string, bytes: Uint8Array, opts: { deviceId?: string } = {}): Promise<OutboundFile | { error: 'too_large' } | { error: 'invalid' }> {
    if (bytes.byteLength > this.maxBytes) return { error: 'too_large' }
    const safe = sanitizeFileName(name)
    if (!NAME_PATTERN.test(safe)) return { error: 'invalid' }
    const id = this.generateId()
    const at = this.now()
    const record: OutboundFile = {
      id,
      name: safe,
      size: bytes.byteLength,
      createdAt: at,
      url: `/api/files/${id}`,
      deviceId: opts.deviceId,
    }
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(this.filePath(id), Buffer.from(bytes))
    } catch {
      return { error: 'invalid' }
    }
    this.records.set(id, record)
    return record
  }

  async read(id: string): Promise<{ record: OutboundFile; bytes: Buffer } | null> {
    const record = this.records.get(id)
    if (!record) return null
    try {
      const bytes = await readFile(this.filePath(id))
      return { record, bytes }
    } catch {
      this.records.delete(id)
      return null
    }
  }

  list(): OutboundFile[] {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  count(): number {
    return this.records.size
  }

  /** Rebuild the in-memory index from disk (boot). Non-fatal. */
  async load(): Promise<void> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.bin')) continue
        const id = entry.name.slice(0, -'.bin'.length)
        if (!this.records.has(id)) {
          try {
            const stat = await this.fileStat(id)
            if (stat) {
              this.records.set(id, {
                id,
                name: id,
                size: stat.size,
                createdAt: stat.mtimeMs,
                url: `/api/files/${id}`,
              })
            }
          } catch {
            // skip unreadable entry
          }
        }
      }
    } catch {
      // Empty / missing dir on first boot.
    }
  }

  private async fileStat(id: string): Promise<{ size: number; mtimeMs: number } | null> {
    const { stat } = await import('node:fs/promises')
    try {
      const info = await stat(this.filePath(id))
      return { size: info.size, mtimeMs: info.mtimeMs }
    } catch {
      return null
    }
  }
}