import fs from 'node:fs'
import path from 'node:path'

export class PathError extends Error {
  code: string
  constructor(message: string, code = 'path_error') {
    super(message)
    this.code = code
  }
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

/**
 * Resolve a user/model supplied path against the project root and guarantee it
 * stays inside the root. Rejects traversal, absolute escape, null bytes.
 */
export function safeResolve(root: string, userPath: string): string {
  if (typeof userPath !== 'string' || userPath.includes('\0')) {
    throw new PathError('Invalid path', 'invalid')
  }
  const normalizedRoot = path.resolve(root)
  const candidate = path.resolve(normalizedRoot, userPath)
  if (!isWithin(normalizedRoot, candidate)) {
    throw new PathError(`Path escapes project root: ${userPath}`, 'escape')
  }
  return candidate
}

/**
 * Stronger containment check that also resolves symlinks on the nearest
 * existing ancestor, preventing symlink-based escapes.
 */
export function assertInsideRoot(root: string, absPath: string): void {
  const normalizedRoot = path.resolve(root)
  if (!isWithin(normalizedRoot, path.resolve(absPath))) {
    throw new PathError(`Path escapes project root: ${absPath}`, 'escape')
  }
  let realRoot: string
  try {
    realRoot = fs.realpathSync.native(normalizedRoot)
  } catch {
    realRoot = normalizedRoot
  }
  let probe = path.resolve(absPath)
  // Walk up to the nearest existing ancestor and realpath it.
  let existing = probe
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    existing = parent
  }
  try {
    const realExisting = fs.realpathSync.native(existing)
    if (!isWithin(realRoot, realExisting)) {
      throw new PathError(`Path resolves outside project root via symlink: ${absPath}`, 'symlink_escape')
    }
  } catch (e) {
    if (e instanceof PathError) throw e
    // realpath failure: fall back to lexical check already performed
  }
}

const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])\.env$/i,
  /(^|[\\/])id_rsa/i,
  /(^|[\\/])id_ed25519/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])credentials$/i,
  /(^|[\\/])secrets?\.(json|ya?ml|toml|txt)$/i,
  /(^|[\\/])\.aws[\\/]/i,
  /(^|[\\/])\.ssh[\\/]/i,
  /(^|[\\/])\.gnupg[\\/]/i
]

export function isSensitivePath(p: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(p))
}

const GIT_INTERNALS = /(^|[\\/])\.git([\\/]|$)/i
export function isGitInternal(p: string): boolean {
  return GIT_INTERNALS.test(p)
}

export function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.hpp': 'cpp',
  '.php': 'php',
  '.swift': 'swift',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.xml': 'xml',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.sh': 'bash',
  '.ps1': 'powershell',
  '.sql': 'sql',
  '.vue': 'vue',
  '.svelte': 'svelte'
}

export function detectLanguage(filePath: string): string | undefined {
  return LANGUAGE_BY_EXT[path.extname(filePath).toLowerCase()]
}
