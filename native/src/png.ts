import { deflateSync } from 'node:zlib'

/**
 * Pure-JS PNG encoder (Phase 1.4): top-down 32bpp BGRA → a single PNG image.
 *
 * Screenshots are captured as raw BGRA scanlines and encoded here with NO
 * native image library and NO shell: zlib deflate (node builtin) + a hand-rolled
 * CRC-32. This keeps the whole pipeline auditable — the only reader of the
 * screen is GDI via the FFI bridge, and the only encoder is this module.
 *
 * Rows are written top-down (BITMAPV4HEADER with a negative height on the
 * capture side) and each PNG scanline is prefixed with filter type 0.
 */

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
}

const CRC_TABLE = makeCrcTable()

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * Encode BGRA (32bpp, top-down, no alpha relevance) into an RGBA PNG.
 * Throws a RangeError for dimensions/byte mismatches — callers bound first.
 */
export function encodeBgraPng(width: number, height: number, bgra: Buffer): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('PNG dimensions must be positive integers.')
  }
  const expected = width * height * 4
  if (bgra.length !== expected) {
    throw new RangeError(`PNG input must be ${expected} BGRA bytes, got ${bgra.length}.`)
  }

  // One scanline per row, each prefixed with PNG filter byte 0. BGRA is rotated
  // into RGBA on the fly so the encoded image displays the true colors.
  const stride = width * 4
  const raw = Buffer.allocUnsafe((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride
    raw[rowStart] = 0
    for (let x = 0; x < width; x += 1) {
      const s = rowStart + 1 + x * 4
      const b = bgra[rowStart + x * 4]
      const g = bgra[rowStart + x * 4 + 1]
      const r = bgra[rowStart + x * 4 + 2]
      const a = bgra[rowStart + x * 4 + 3]
      raw[s] = r
      raw[s + 1] = g
      raw[s + 2] = b
      raw[s + 3] = a
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(6, 9) // color type: truecolor + alpha
  ihdr.writeUInt8(0, 10) // compression
  ihdr.writeUInt8(0, 11) // filter method
  ihdr.writeUInt8(0, 12) // interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}