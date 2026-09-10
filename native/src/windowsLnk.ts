/**
 * Native Windows Agent — minimal Shell Link (.lnk) target parser (Phase 1.3).
 *
 * Pure Node, zero deps, no COM, no shell. It reads the binary Shell Link
 * format defined by MS-SHLLINK just enough to recover the absolute target
 * executable path stored in LinkInfo (`LocalBasePath`). This is how a Start
 * Menu shortcut becomes a launchable target WITHOUT invoking cmd.exe,
 * PowerShell or WScript — those are exactly the shell hosts this agent refuses
 * to adopt. Any unexpected/malformed byte layout returns `null` (never
 * throws), keeping discovery deterministic and safe.
 */

import { APP_LIMITS } from './limits.js'

/** ShellLink header magic (0x0000004C). */
const SHELL_LINK_MAGIC = 0x0000_004c
/** Recommended CLSID for shell links. */
const SHELL_LINK_CLSID = Buffer.from([
  0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
])

/** LinkFlags: HasLinkTargetIDList. */
const FLAG_HAS_ID_LIST = 0x0000_0001
/** LinkFlags: HasLinkInfo. */
const FLAG_HAS_LINK_INFO = 0x0000_0002

/** Minimum LinkInfo header bytes we require (through CommonPathSuffixOffset). */
const MIN_LINK_INFO_HEADER = 0x1c

function u16(buf: Buffer, offset: number): number | undefined {
  return offset >= 0 && offset + 2 <= buf.length ? buf.readUInt16LE(offset) : undefined
}

function u32(buf: Buffer, offset: number): number | undefined {
  return offset >= 0 && offset + 4 <= buf.length ? buf.readUInt32LE(offset) : undefined
}

/** Null-terminated ANSI string read from [start, end); empty when malformed. */
function readCStringAnsi(buf: Buffer, start: number, end: number): string {
  if (start < 0 || end > buf.length || start >= end) return ''
  let i = start
  while (i < end && buf[i] !== 0) i += 1
  return buf.toString('latin1', start, i)
}

/** Null-terminated UTF-16LE string read from [start, end); empty when malformed. */
function readCStringUnicode(buf: Buffer, start: number, end: number): string {
  if (start < 0 || end > buf.length || start >= end) return ''
  let i = start
  while (i + 1 < end && !(buf[i] === 0 && buf[i + 1] === 0)) i += 2
  if (i + 1 > end) return ''
  return buf.toString('utf16le', start, i)
}

/**
 * Extract the target executable path from a `.lnk` byte buffer.
 *
 * Returns `null` for anything that is not a clearly-formed shell link with a
 * sensible LinkInfo path, so callers can treat "cannot parse" as "not
 * launchable" without ever raising.
 */
export function parseShellLinkTarget(data: Buffer): string | null {
  if (!Buffer.isBuffer(data) || data.byteLength < 76) return null
  if (data.readUInt32LE(0) !== SHELL_LINK_MAGIC) return null
  for (let i = 0; i < SHELL_LINK_CLSID.length; i += 1) {
    if (data[4 + i] !== SHELL_LINK_CLSID[i]) return null
  }

  const linkFlags = data.readUInt32LE(0x14)

  // Skip the optional LinkTargetIDList so we land on LinkInfo.
  let offset = 76
  if ((linkFlags & FLAG_HAS_ID_LIST) !== 0) {
    const idListSize = u16(data, offset)
    if (idListSize === undefined) return null
    offset += 2 + idListSize
    if (offset > data.byteLength) return null
  }

  if ((linkFlags & FLAG_HAS_LINK_INFO) === 0) return null

  const linkInfoSize = u32(data, offset)
  if (linkInfoSize === undefined || linkInfoSize < MIN_LINK_INFO_HEADER) return null
  if (offset + linkInfoSize > data.byteLength) return null
  const base = offset
  const headerSize = u32(data, base + 4)
  if (headerSize === undefined || headerSize < MIN_LINK_INFO_HEADER || headerSize > linkInfoSize) return null

  const localBasePathOffset = u32(data, base + 0x10)
  if (localBasePathOffset === undefined) return null
  const commonSuffixOffset = u32(data, base + 0x18) ?? linkInfoSize

  // Unicode path fields exist only when the header declares the extra bytes.
  const localBasePathOffsetUnicode = headerSize >= 0x24 ? (u32(data, base + 0x1c) ?? 0) : 0
  const commonSuffixOffsetUnicode = headerSize >= 0x28 ? (u32(data, base + 0x20) ?? 0) : 0

  const linkEnd = base + linkInfoSize
  const maxChars = APP_LIMITS.MAX_LNK_TARGET_CHARS

  let target = ''
  if (localBasePathOffsetUnicode > 0) {
    const unicodeStart = base + localBasePathOffsetUnicode
    const unicodeEnd = Math.min(
      base + (commonSuffixOffsetUnicode > localBasePathOffsetUnicode ? commonSuffixOffsetUnicode : linkInfoSize),
      linkEnd,
    )
    target = readCStringUnicode(data, unicodeStart, unicodeEnd)
  }
  if (!target) {
    if (localBasePathOffset === 0) return null
    const ansiStart = base + localBasePathOffset
    const ansiEnd = Math.min(
      base + (commonSuffixOffset > localBasePathOffset ? commonSuffixOffset : linkInfoSize),
      linkEnd,
    )
    target = readCStringAnsi(data, ansiStart, ansiEnd)
  }

  target = target.trim()
  if (target.length === 0 || target.length > maxChars) return null
  return target
}