// Generates website/config.js from environment variables at build time.
// Runs inside the website root on Vercel (see vercel.json buildCommand).
//
// Required env: API_BASE_URL (or VITE_API_BASE_URL)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outFile = path.join(here, 'config.js')

const apiBaseUrl = (process.env.API_BASE_URL || process.env.VITE_API_BASE_URL || '').trim()

const contents = `// AUTO-GENERATED at build time — do not edit or commit.
window.ALPHA_PLATFORM = ${JSON.stringify({ apiBaseUrl }, null, 2)}
`

fs.writeFileSync(outFile, contents, 'utf8')
if (!apiBaseUrl) {
  console.warn('[gen-config] API_BASE_URL not set — wrote an unconfigured config.js')
} else {
  console.log('[gen-config] wrote website/config.js')
}
