import fs from 'node:fs'
import path from 'node:path'
import type { AttachmentRef } from '@shared/types'
import { getLogger } from './logger'

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.xml', '.yml', '.yaml',
  '.toml', '.ini', '.env', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb',
  '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.php', '.swift',
  '.css', '.scss', '.html', '.sh', '.ps1', '.sql', '.vue', '.svelte'
])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi'])

const MAX_TEXT_CHARS = 200_000
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_PDF_BYTES = 25 * 1024 * 1024

export class AttachmentService {
  /** Analyze a file and return a reference with any extractable text. */
  async analyze(filePath: string): Promise<AttachmentRef> {
    const ext = path.extname(filePath).toLowerCase()
    let size = 0
    try {
      size = fs.statSync(filePath).size
    } catch {
      throw new Error('File not found')
    }
    const base: AttachmentRef = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: path.basename(filePath),
      mimeType: mimeFor(ext),
      size,
      kind: 'binary'
    }

    if (TEXT_EXT.has(ext)) {
      const text = fs.readFileSync(filePath, 'utf8')
      base.kind = 'text'
      base.extractedText = text.slice(0, MAX_TEXT_CHARS)
      if (text.length > MAX_TEXT_CHARS) {
        base.note = `Truncated to ${MAX_TEXT_CHARS} characters (file is ${text.length}).`
      }
      return base
    }

    if (ext === '.pdf') {
      base.kind = 'pdf'
      if (size > MAX_PDF_BYTES) {
        base.note = 'PDF is too large to process (limit 25 MB).'
        return base
      }
      try {
        const pdfParse = require('pdf-parse') as (
          buf: Buffer
        ) => Promise<{ text: string; numpages: number }>
        const res = await pdfParse(fs.readFileSync(filePath))
        base.extractedText = (res.text || '').slice(0, MAX_TEXT_CHARS)
        base.note = `${res.numpages} page(s)`
      } catch (e) {
        getLogger().warn('attachments', `pdf parse failed: ${(e as Error).message}`)
        base.note = `PDF text extraction unavailable: ${(e as Error).message}`
      }
      return base
    }

    if (IMAGE_EXT.has(ext)) {
      base.kind = 'image'
      if (size <= MAX_IMAGE_BYTES) {
        const buf = fs.readFileSync(filePath)
        base.previewUrl = `data:${base.mimeType};base64,${buf.toString('base64')}`
        base.note = 'Images are only sent to models that support vision.'
      } else {
        base.note = 'Image too large to attach (limit 8 MB).'
      }
      return base
    }

    if (AUDIO_EXT.has(ext)) {
      base.kind = 'audio'
      base.note = 'Attach audio to a configured transcription provider, or use the microphone feature.'
      return base
    }
    if (VIDEO_EXT.has(ext)) {
      base.kind = 'video'
      base.note = 'Video analysis requires frame/text extraction tools that are not bundled.'
      return base
    }

    base.note = 'Unsupported binary format.'
    return base
  }
}

function mimeFor(ext: string): string {
  const map: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm'
  }
  return map[ext] ?? 'application/octet-stream'
}
