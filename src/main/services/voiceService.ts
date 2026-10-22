/**
 * Local voice-to-action via whisper.cpp.
 *
 * The app already records from the mic in the renderer and transcribes through a
 * provider. This adds the offline path: a user-supplied `whisper-cli` binary and
 * GGML model, run in the main process, with no audio leaving the machine.
 *
 * Reality of the pipeline, stated rather than hidden: whisper.cpp wants 16 kHz
 * mono WAV, while the browser records WebM/Opus. So a conversion step is
 * required — ffmpeg if it is on PATH, otherwise the user is told exactly what is
 * missing. A missing binary or model is a *reported* condition
 * (`probe()`), never a crash at startup: voice is optional.
 *
 * No `electron` import; `spawn` and `exists` are injected so tests never run a
 * real binary.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface VoiceLocalConfig {
  /** Absolute path to whisper-cli(.exe). */
  binaryPath?: string | null
  /** Absolute path to a ggml model, e.g. ggml-base.en.bin. */
  modelPath?: string | null
  /** Optional ffmpeg path; falls back to `ffmpeg` on PATH. */
  ffmpegPath?: string | null
  language?: string
  threads?: number
}

export interface VoiceAvailability {
  binary: boolean
  model: boolean
  ffmpeg: boolean
  ready: boolean
  /** Human-readable reason when not ready. */
  message: string
}

export type SpawnResult = { code: number; stdout: string; stderr: string }

export type SpawnLike = (
  command: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string }
) => Promise<SpawnResult>

const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const TRANSCRIBE_TIMEOUT_MS = 120_000
const CONVERT_TIMEOUT_MS = 60_000

/** whisper.cpp writes its transcript to stdout; everything else is noise. */
export function parseWhisperOutput(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/g, '').trim())
    .filter((line) => line && !/^(whisper_|system_info|main:|ggml_|error:)/i.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\[BLANK_AUDIO\]|\(silence\)/gi, '')
    .trim()
}

/** Args for whisper.cpp. `-nt` suppresses timestamps we would only strip back out. */
export function buildWhisperArgs(input: {
  modelPath: string
  audioPath: string
  language?: string
  threads?: number
}): string[] {
  const args = ['-m', input.modelPath, '-f', input.audioPath, '-nt', '-otxt', '-np']
  if (input.language && input.language !== 'auto') args.push('-l', input.language)
  const threads = Math.min(Math.max(Math.round(input.threads ?? 0), 0), 16)
  if (threads > 0) args.push('-t', String(threads))
  return args
}

export function buildFfmpegArgs(inputPath: string, outputPath: string): string[] {
  return ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath]
}

/** Mime/extensions the browser produces that ffmpeg can read. */
const AUDIO_EXT: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/wave': '.wav',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3'
}

export function extensionFor(mimeType: string | undefined, fallback = '.webm'): string {
  if (!mimeType) return fallback
  return AUDIO_EXT[mimeType.toLowerCase().split(';')[0].trim()] ?? fallback
}

export function decodeAudioBase64(audioBase64: string): Buffer {
  const clean = audioBase64.replace(/^data:[^;]+;base64,/, '')
  const buffer = Buffer.from(clean, 'base64')
  if (!buffer.length) throw new Error('The recording was empty.')
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw new Error(`Recording is ${(buffer.length / 1e6).toFixed(1)} MB; the limit is 25 MB.`)
  }
  return buffer
}

export interface VoiceServiceDeps {
  config: () => VoiceLocalConfig
  spawn?: SpawnLike
  exists?: (filePath: string) => boolean
  /** Temp directory for audio. Defaults to os.tmpdir(). */
  tempDir?: () => string
}

export class VoiceService {
  private spawn: SpawnLike
  private exists: (p: string) => boolean

  constructor(private deps: VoiceServiceDeps) {
    this.spawn = deps.spawn ?? defaultSpawn
    this.exists = deps.exists ?? ((p) => fs.existsSync(p))
  }

  private temp(): string {
    return this.deps.tempDir?.() ?? os.tmpdir()
  }

  /** Cheap readiness check; safe to call on every settings render. */
  probe(): VoiceAvailability {
    const config = this.deps.config()
    const binary = Boolean(config.binaryPath && this.exists(config.binaryPath))
    const model = Boolean(config.modelPath && this.exists(config.modelPath))
    const ffmpeg = Boolean(config.ffmpegPath ? this.exists(config.ffmpegPath) : whichExists('ffmpeg'))
    const missing: string[] = []
    if (!binary) missing.push('whisper-cli binary (Settings → Voice → Local model)')
    if (!model) missing.push('GGML model file')
    if (!ffmpeg) missing.push('ffmpeg for audio conversion')
    return {
      binary,
      model,
      ffmpeg,
      ready: binary && model && ffmpeg,
      message: missing.length ? `Local transcription unavailable: missing ${missing.join(', ')}.` : 'Local transcription ready.'
    }
  }

  /**
   * Transcribe a recording fully offline. Throws with an actionable message
   * rather than falling back silently to a cloud provider the user did not
   * choose — silence here would be a privacy bug.
   */
  async transcribe(input: { audioBase64: string; mimeType?: string }): Promise<{ text: string }> {
    const availability = this.probe()
    const config = this.deps.config()
    if (!availability.binary || !config.binaryPath) throw new Error(availability.message)
    if (!availability.model || !config.modelPath) throw new Error(availability.message)

    const audio = decodeAudioBase64(input.audioBase64)
    const stamp = randomUUID().slice(0, 8)
    const rawPath = path.join(this.temp(), `alpha-voice-${stamp}${extensionFor(input.mimeType)}`)
    const wavPath = path.join(this.temp(), `alpha-voice-${stamp}.wav`)
    fs.writeFileSync(rawPath, audio)
    try {
      if (availability.ffmpeg) {
        const ffmpeg = config.ffmpegPath ?? 'ffmpeg'
        const converted = await this.spawn(ffmpeg, buildFfmpegArgs(rawPath, wavPath), {
          timeoutMs: CONVERT_TIMEOUT_MS
        })
        if (converted.code !== 0) {
          throw new Error(`Audio conversion failed: ${converted.stderr.trim().slice(0, 300) || 'ffmpeg exited non-zero'}`)
        }
      } else {
        throw new Error(availability.message)
      }
      const result = await this.spawn(
        config.binaryPath,
        buildWhisperArgs({
          modelPath: config.modelPath,
          audioPath: wavPath,
          language: config.language,
          threads: config.threads
        }),
        { timeoutMs: TRANSCRIBE_TIMEOUT_MS }
      )
      // whisper.cpp returns 0 with empty stdout for pure silence.
      if (result.code !== 0) {
        throw new Error(`whisper-cli failed: ${result.stderr.trim().slice(0, 300) || `exit ${result.code}`}`)
      }
      const text = parseWhisperOutput(result.stdout)
      if (!text) throw new Error('No speech detected in the recording.')
      return { text }
    } finally {
      // Audio is user data: never leave it lying in temp.
      for (const file of [rawPath, wavPath]) {
        try {
          fs.rmSync(file, { force: true })
        } catch {
          /* ignore */
        }
      }
    }
  }
}

function whichExists(binary: string): boolean {
  const pathValue = process.env.PATH ?? ''
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, binary + ext))) return true
      } catch {
        /* ignore */
      }
    }
  }
  return false
}

/** Default spawner: bounded, killed on timeout, no shell (no injection surface). */
export const defaultSpawn: SpawnLike = (command, args, options = {}) =>
  new Promise<SpawnResult>((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS,
      cwd: options.cwd
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.length > 1_000_000) stdout = stdout.slice(-500_000)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
