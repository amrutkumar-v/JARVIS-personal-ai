import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Minimal Shell Link (.lnk) binary BUILDER for tests (Phase 1.3).
 *
 * This mirrors the MS-SHLLINK layout that `parseShellLinkTarget` reads, so the
 * discovery tests can fabricate real shortcut files on disk without invoking
 * COM. It intentionally produces the minimal shape: 76-byte header + optional
 * LinkTargetIDList + optional LinkInfo.
 */

export interface ShellLinkOptions {
  /** LinkFlags; JS bitmask. */
  linkFlags?: number
  /** Raw LinkTargetIDList bytes (after the 2-byte size is written for you). */
  linkTargetIDList?: Buffer
  /** Raw LinkInfo bytes. */
  linkInfo?: Buffer
}

const CLSID = Buffer.from([
  0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
])

export const FLAG_HAS_LINK_INFO = 0x0000_0002
export const FLAG_HAS_ID_LIST = 0x0000_0001

function align4(n: number): number {
  return (n + 3) & ~3
}

export function buildShellLink(options: ShellLinkOptions = {}): Buffer {
  const header = Buffer.alloc(76)
  header.writeUInt32LE(0x0000_004c, 0)
  CLSID.copy(header, 4)
  header.writeUInt32LE(options.linkFlags ?? 0, 0x14)

  const parts: Buffer[] = [header]
  if (options.linkTargetIDList) {
    const size = Buffer.alloc(2)
    size.writeUInt16LE(options.linkTargetIDList.length, 0)
    parts.push(size, options.linkTargetIDList)
  }
  if (options.linkInfo) parts.push(options.linkInfo)
  return Buffer.concat(parts)
}

/** LinkInfo with an ANSI-only LocalBasePath (header size 0x1c). */
export function buildLinkInfoAnsi(target: string): Buffer {
  const pathBuf = Buffer.from(target, 'latin1')
  const common = align4(0x1c + pathBuf.length + 1)
  const total = align4(common + 1)
  const buf = Buffer.alloc(total)
  buf.writeUInt32LE(total, 0)
  buf.writeUInt32LE(0x1c, 4)
  buf.writeUInt32LE(0x1, 8)
  buf.writeUInt32LE(0, 0x0c)
  buf.writeUInt32LE(0x1c, 0x10)
  buf.writeUInt32LE(0, 0x14)
  buf.writeUInt32LE(common, 0x18)
  pathBuf.copy(buf, 0x1c)
  return buf
}

/** LinkInfo with BOTH ANSI and Unicode LocalBasePaths (header size 0x24). */
export function buildLinkInfoUnicode(ansiTarget: string, unicodeTarget: string): Buffer {
  const ansiStart = 0x24
  const pathBuf = Buffer.from(ansiTarget, 'latin1')
  const ansiCommon = align4(ansiStart + pathBuf.length + 1)
  const unicodeStart = align4(ansiCommon + 1)
  const unicodeBuf = Buffer.from(unicodeTarget, 'utf16le')
  const unicodeCommon = align4(unicodeStart + unicodeBuf.length + 2)
  const total = align4(unicodeCommon + 2)
  const buf = Buffer.alloc(total)
  buf.writeUInt32LE(total, 0)
  buf.writeUInt32LE(0x24, 4)
  buf.writeUInt32LE(0x1, 8)
  buf.writeUInt32LE(0, 0x0c)
  buf.writeUInt32LE(ansiStart, 0x10)
  buf.writeUInt32LE(0, 0x14)
  buf.writeUInt32LE(ansiCommon, 0x18)
  buf.writeUInt32LE(unicodeStart, 0x1c)
  buf.writeUInt32LE(unicodeCommon, 0x20)
  pathBuf.copy(buf, ansiStart)
  unicodeBuf.copy(buf, unicodeStart)
  return buf
}

/** Convenience: write an ANSI LocalBasePath shortcut to a temp folder. */
export function writeLnkAnsi(dir: string, fileName: string, target: string): string {
  const buf = buildShellLink({
    linkFlags: FLAG_HAS_LINK_INFO,
    linkInfo: buildLinkInfoAnsi(target),
  })
  const path = join(dir, fileName)
  writeFileSync(path, buf)
  return path
}