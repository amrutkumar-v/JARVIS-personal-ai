/**
 * Lightweight Zero-Dependency ZIP Archive Extractor
 *
 * Designed for Open Packaging Conventions (DOCX, XLSX, PPTX) and ZIP archives.
 * Uses Node.js built-in zlib for decompression with strict safety limits against ZIP bombs.
 * Browser-safe: avoids static bundling of node:zlib into client-side Vite bundles.
 */

export interface ZipSafetyLimits {
  maxEntries?: number
  maxTotalBytes?: number
  maxEntryBytes?: number
}

const DEFAULT_MAX_ENTRIES = 1000
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024 // 50 MB
const DEFAULT_MAX_ENTRY_BYTES = 20 * 1024 * 1024 // 20 MB

function getNodeModule(name: string): any {
  if (typeof window !== 'undefined') return null
  if (typeof process !== 'undefined') {
    if (typeof (process as any).getBuiltinModule === 'function') {
      return (process as any).getBuiltinModule(name)
    }
    try {
      const g = globalThis as any
      if (typeof g.require === 'function') return g.require(name)
    } catch {}
  }
  return null
}

function getNodeZlib(): any {
  return getNodeModule('node:zlib')
}

/**
 * Extracts entries from a ZIP buffer into an in-memory Map of filename -> Buffer.
 * Fails safely with empty Map if the buffer is malformed or invalid.
 */
export function extractZipEntries(
  bufferInput: Uint8Array | Buffer,
  limits: ZipSafetyLimits = {},
): Map<string, Buffer> {
  const entries = new Map<string, Buffer>()
  const buf = Buffer.isBuffer(bufferInput) ? bufferInput : Buffer.from(bufferInput)

  if (buf.length < 22) return entries

  const zlib = getNodeZlib()
  if (!zlib) return entries

  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const maxEntryBytes = limits.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES

  // Find End of Central Directory (EOCD) record by scanning backwards
  let eocdOffset = -1
  const minOffset = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }

  if (eocdOffset === -1) return entries

  const totalEntries = Math.min(buf.readUInt16LE(eocdOffset + 10), maxEntries)
  const cdOffset = buf.readUInt32LE(eocdOffset + 16)

  let curr = cdOffset
  let totalDecompressedBytes = 0

  for (let i = 0; i < totalEntries; i++) {
    if (curr + 46 > buf.length || buf.readUInt32LE(curr) !== 0x02014b50) break

    const method = buf.readUInt16LE(curr + 10)
    const compSize = buf.readUInt32LE(curr + 20)
    const uncompSize = buf.readUInt32LE(curr + 24)
    const nameLen = buf.readUInt16LE(curr + 28)
    const extraLen = buf.readUInt16LE(curr + 30)
    const commentLen = buf.readUInt16LE(curr + 32)
    const localOffset = buf.readUInt32LE(curr + 42)

    if (uncompSize > maxEntryBytes || totalDecompressedBytes + uncompSize > maxTotalBytes) {
      break
    }

    const name = buf.toString('utf8', curr + 46, curr + 46 + nameLen)

    if (localOffset + 30 <= buf.length && buf.readUInt32LE(localOffset) === 0x04034b50) {
      const locNameLen = buf.readUInt16LE(localOffset + 26)
      const locExtraLen = buf.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + locNameLen + locExtraLen

      if (dataStart + compSize <= buf.length) {
        const rawData = buf.subarray(dataStart, dataStart + compSize)
        let decomp: Buffer | undefined

        try {
          if (method === 0) {
            decomp = Buffer.from(rawData)
          } else if (method === 8) {
            decomp = zlib.inflateRawSync(rawData)
          }
        } catch {
          decomp = undefined
        }

        if (decomp) {
          totalDecompressedBytes += decomp.length
          entries.set(name, decomp)
        }
      }
    }

    curr += 46 + nameLen + extraLen + commentLen
  }

  return entries
}
