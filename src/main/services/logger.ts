import fs from 'node:fs'
import path from 'node:path'

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /sk-proj-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /(Bearer\s+)[A-Za-z0-9._-]{10,}/gi,
  /(["']?(?:api[_-]?key|apikey|authorization|password|secret|token|access_token)["']?\s*[:=]\s*)["']?([^"',\s}]{6,})["']?/gi
]

export function redact(input: unknown): string {
  let text: string
  if (typeof input === 'string') text = input
  else if (input instanceof Error) text = input.stack || input.message
  else {
    try {
      text = JSON.stringify(input)
    } catch {
      text = String(input)
    }
  }
  let out = text
  out = out.replace(SECRET_PATTERNS[0], '[REDACTED]')
  out = out.replace(SECRET_PATTERNS[1], '[REDACTED]')
  out = out.replace(SECRET_PATTERNS[2], '[REDACTED]')
  out = out.replace(SECRET_PATTERNS[3], '[REDACTED]')
  out = out.replace(SECRET_PATTERNS[4], '[REDACTED]')
  out = out.replace(SECRET_PATTERNS[5], (_m, p1) => `${p1}[REDACTED]`)
  return out
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }
const MAX_LOG_BYTES = 2 * 1024 * 1024

export class Logger {
  private dir: string
  private file: string
  private level: LogLevel = 'info'
  private stream: fs.WriteStream | null = null

  constructor(dir: string) {
    this.dir = dir
    this.file = path.join(dir, 'alpha.log')
    try {
      fs.mkdirSync(dir, { recursive: true })
      this.rotateIfNeeded()
      this.stream = fs.createWriteStream(this.file, { flags: 'a' })
    } catch {
      this.stream = null
    }
  }

  get logPath(): string {
    return this.file
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  private rotateIfNeeded(): void {
    try {
      const stat = fs.statSync(this.file)
      if (stat.size > MAX_LOG_BYTES) {
        fs.renameSync(this.file, this.file + '.1')
      }
    } catch {
      /* no file yet */
    }
  }

  private write(level: LogLevel, scope: string, message: unknown): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.level]) return
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${redact(message)}\n`
    if (level === 'error') console.error(line.trim())
    else if (level === 'warn') console.warn(line.trim())
    else console.log(line.trim())
    try {
      this.stream?.write(line)
    } catch {
      /* ignore */
    }
  }

  error(scope: string, message: unknown): void {
    this.write('error', scope, message)
  }
  warn(scope: string, message: unknown): void {
    this.write('warn', scope, message)
  }
  info(scope: string, message: unknown): void {
    this.write('info', scope, message)
  }
  debug(scope: string, message: unknown): void {
    this.write('debug', scope, message)
  }
}

let instance: Logger | null = null

export function initLogger(dir: string): Logger {
  instance = new Logger(dir)
  return instance
}

export function getLogger(): Logger {
  if (!instance) {
    instance = new Logger(path.join(process.cwd(), 'logs'))
  }
  return instance
}
