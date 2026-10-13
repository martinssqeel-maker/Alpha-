// Builds the Alpha brand icons from build/alpha-logo.jpg (the real logo asset).
//
//  1. writes a rounded-corner alpha mask (pure Node, no deps)
//  2. shells out to ffmpeg for the JPG->PNG resize and the mask merge
//
// Outputs: build/icon.png (512), build/icon.ico (256, PNG-compressed),
//          website/assets/icon.png (256), src/renderer/src/assets/alpha-logo.png (512)
//
// Requires ffmpeg on PATH. The logo's proportions are never altered: the source
// is square, every output is a straight lanczos downscale with rounded corners.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const SOURCE = path.join(ROOT, 'build', 'alpha-logo.jpg')
const SIZES = { large: 512, small: 256 }
const CORNER_RADIUS = 0.2 // fraction of size — matches the logo's own corner rounding

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

/** 8-bit grayscale PNG, one byte per pixel. */
function writeGrayPng(file, size, pixel) {
  const raw = Buffer.alloc(size * (size + 1))
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0
    for (let x = 0; x < size; x++) raw[o++] = pixel(x, y)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
  fs.writeFileSync(file, png)
}

function roundedMaskPng(size) {
  const r = size * CORNER_RADIUS
  const c = (size - 1) / 2
  const half = size / 2 - r
  return (x, y) => {
    const dx = Math.max(Math.abs(x - c) - half, 0)
    const dy = Math.max(Math.abs(y - c) - half, 0)
    const d = Math.hypot(dx, dy) - r
    return Math.round(Math.min(1, Math.max(0, 0.5 - d)) * 255)
  }
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: cmd === 'ffmpeg' })
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`Missing ${SOURCE} — put the Alpha logo JPG there first.`)
    process.exit(1)
  }

  const tmp = path.join(ROOT, 'build', '.icon-work')
  fs.mkdirSync(tmp, { recursive: true })

  const maskLarge = path.join(tmp, 'mask512.png')
  writeGrayPng(maskLarge, SIZES.large, roundedMaskPng(SIZES.large))

  const flat = path.join(tmp, 'flat512.png')
  run('ffmpeg', ['-y', '-i', SOURCE, '-vf', `scale=${SIZES.large}:${SIZES.large}:flags=lanczos`, '-frames:v', '1', '-update', '1', flat])

  const iconPng = path.join(ROOT, 'build', 'icon.png')
  run('ffmpeg', ['-y', '-i', flat, '-i', maskLarge, '-filter_complex', '[0][1]alphamerge', '-frames:v', '1', '-update', '1', iconPng])

  const ico = path.join(ROOT, 'build', 'icon.ico')
  run('ffmpeg', ['-y', '-i', iconPng, '-vf', `scale=${SIZES.small}:${SIZES.small}:flags=lanczos`, '-c:v', 'png', '-frames:v', '1', ico])

  const webIcon = path.join(ROOT, 'website', 'assets', 'icon.png')
  run('ffmpeg', ['-y', '-i', iconPng, '-vf', `scale=${SIZES.small}:${SIZES.small}:flags=lanczos`, '-frames:v', '1', '-update', '1', webIcon])

  const splash = path.join(ROOT, 'src', 'renderer', 'src', 'assets')
  fs.mkdirSync(splash, { recursive: true })
  fs.copyFileSync(iconPng, path.join(splash, 'alpha-logo.png'))

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('Wrote build/icon.png, build/icon.ico, website/assets/icon.png, src/renderer/src/assets/alpha-logo.png')
}

main()
