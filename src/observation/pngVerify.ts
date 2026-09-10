/**
 * Transport-level PNG verification (Phase 1.4).
 *
 * Used by `desktop.screenshot`'s verify phase to prove the returned envelope
 * IS a structurally valid PNG with the claimed dimensions — signature, IHDR
 * geometry, chunk CRCs and a deflate stream that inflates to exactly the
 * expected scanline budget. This is deliberately a STRUCTURAL check, not a
 * semantic one: it proves the bytes are a real encoded image, never that the
 * image depicts a specific screen (that is the FFI bridge's honest provenance).
 *
 * Pure browser-safe code: base64 via atob, inflate via DecompressionStream.
 */

import { OBS_LIMITS } from './limits'

function decodeBase64(input: string): Uint8Array {
  const binary = atob(input)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    c ^= bytes[i]!
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

interface PngVerifyOk {
  ok: true
  width: number
  height: number
  bytes: number
}

async function inflateDeflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** True when a PNG envelope matches the claimed geometry and is structurally sound. */
export async function verifyPngEnvelope(
  claimedWidth: number,
  claimedHeight: number,
  base64Bytes: string,
): Promise<PngVerifyOk | { ok: false; reason: string }> {
  if (!Number.isInteger(claimedWidth) || !Number.isInteger(claimedHeight) || claimedWidth < 1 || claimedHeight < 1) {
    return { ok: false, reason: 'The screenshot dimensions are invalid.' }
  }
  if (claimedWidth > OBS_LIMITS.MAX_SCREENSHOT_WIDTH || claimedHeight > OBS_LIMITS.MAX_SCREENSHOT_HEIGHT) {
    return { ok: false, reason: 'The screenshot dimensions exceed the supported bounds.' }
  }
  let png: Uint8Array
  try {
    png = decodeBase64(base64Bytes)
  } catch {
    return { ok: false, reason: 'The screenshot payload is not valid base64.' }
  }
  if (png.length === 0) return { ok: false, reason: 'The screenshot payload is empty.' }
  if (png.length > OBS_LIMITS.MAX_SCREENSHOT_BYTES) return { ok: false, reason: 'The screenshot exceeds the size limit.' }

  if (png.length < 8 || !SIGNATURE.every((byte, i) => png[i] === byte)) {
    return { ok: false, reason: 'The screenshot payload is not a PNG.' }
  }

  // Scan chunks, verifying CRCs and collecting IHDR/IDAT.
  let offset = 8
  let ihdr: Uint8Array | null = null
  const idat: Uint8Array[] = []
  while (offset + 8 <= png.length) {
    const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0)
    const type = String.fromCharCode(png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!)
    if (offset + 12 + length > png.length) return { ok: false, reason: 'The PNG chunk is truncated.' }
    const body = png.subarray(offset + 4, offset + 8 + length)
    const stored = png.subarray(offset + 8 + length, offset + 12 + length)
    const crc = new DataView(stored.buffer, stored.byteOffset, 4).getUint32(0)
    if (crc32(body) !== crc) return { ok: false, reason: 'The PNG chunk CRC is invalid.' }
    if (type === 'IHDR') ihdr = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length))
    if (type === 'IEND') break
    offset += 12 + length
  }

  if (!ihdr || ihdr.length < 8) return { ok: false, reason: 'The PNG has no valid header.' }
  const width = new DataView(ihdr.buffer, ihdr.byteOffset, 4).getUint32(0)
  const height = new DataView(ihdr.buffer, ihdr.byteOffset + 4, 4).getUint32(0)
  if (width !== claimedWidth || height !== claimedHeight) {
    return { ok: false, reason: `The PNG geometry (${width}x${height}) does not match the claimed ${claimedWidth}x${claimedHeight}.` }
  }
  if (ihdr[8] !== 8 || ihdr[9] !== 6) return { ok: false, reason: 'The PNG is not a supported 8-bit RGBA image.' }

  if (idat.length === 0) return { ok: false, reason: 'The PNG contains no pixel data.' }
  let raw: Uint8Array
  try {
    raw = await inflateDeflate(concatUint8(idat))
  } catch {
    return { ok: false, reason: 'The PNG pixel data does not inflate.' }
  }
  const expected = (1 + width * 4) * height
  if (raw.length !== expected) {
    return { ok: false, reason: `The PNG pixel data has ${raw.length} bytes; expected ${expected}.` }
  }
  return { ok: true, width, height, bytes: png.length }
}

function concatUint8(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}