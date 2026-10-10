// Generates build/icon.ico (256x256, PNG-compressed) with no external deps.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZE = 256

function lerp(a, b, t) {
  return a + (b - a) * t
}
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]
}
function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy || 1
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

const top = [0x83, 0x91, 0xff]
const bottom = [0x46, 0x50, 0xc8]

const segments = [
  [0.30, 0.78, 0.50, 0.20],
  [0.70, 0.78, 0.50, 0.20],
  [0.40, 0.57, 0.60, 0.57]
]

const radius = 0.20
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
let o = 0
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0 // filter: none
  for (let x = 0; x < SIZE; x++) {
    const u = x / (SIZE - 1)
    const v = y / (SIZE - 1)
    let color = mix(top, bottom, v)
    // diagonal sheen
    const sheen = smoothstep(0.0, 1.0, 1 - Math.hypot(u - 0.25, v - 0.1))
    color = mix(color, [0xff, 0xff, 0xff], sheen * 0.18)

    // glyph
    let d = Infinity
    for (const s of segments) d = Math.min(d, distToSegment(u, v, s[0], s[1], s[2], s[3]))
    const glyph = 1 - smoothstep(0.045, 0.062, d)
    color = mix(color, [0xff, 0xff, 0xff], glyph)

    // rounded square mask
    const cx = Math.max(radius, Math.min(1 - radius, u))
    const cy = Math.max(radius, Math.min(1 - radius, v))
    const corner = Math.hypot(u - cx, v - cy)
    const alpha = 1 - smoothstep(radius - 0.012, radius, corner)

    raw[o++] = Math.round(color[0])
    raw[o++] = Math.round(color[1])
    raw[o++] = Math.round(color[2])
    raw[o++] = Math.round(alpha * 255)
  }
}

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(1, 4)
const entry = Buffer.alloc(16)
entry[0] = 0 // width 256
entry[1] = 0 // height 256
entry[2] = 0
entry[3] = 0
entry.writeUInt16LE(1, 4)
entry.writeUInt16LE(32, 6)
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(22, 12)
const ico = Buffer.concat([header, entry, png])

const outDir = path.resolve(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico)
// also a png for other uses
fs.writeFileSync(path.join(outDir, 'icon.png'), png)
console.log(`Wrote build/icon.ico (${ico.length} bytes) and build/icon.png (${png.length} bytes)`)
