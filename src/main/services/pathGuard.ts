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

// ---------------------------------------------------------------------------
// Authorized locations (desktop agent)
// ---------------------------------------------------------------------------
//
// The coding workflow confines everything to one project root. Desktop work
// needs a few more, but "more roots" must not mean "anywhere": the agent gets a
// fixed, explicit list, and OS-owned directories stay off-limits even if a user
// adds one by mistake.

/**
 * Directories the agent must never read or write, whatever the roots say.
 *
 * These are matched on the *resolved absolute* path after normalisation, so
 * `C:\Windows\..\Windows` and `C:/WINDOWS` trip the same rule on Windows and a
 * `/etc` prefix trips the POSIX half.
 */
const SYSTEM_PATH_PATTERNS: RegExp[] = [
  /^[a-z]:\/windows(\/|$)/i,
  /^[a-z]:\/program files( \(x86\))?(\/|$)/i,
  /^[a-z]:\/programdata(\/|$)/i,
  /^[a-z]:\/system volume information(\/|$)/i,
  /^[a-z]:\/\$recycle\.bin(\/|$)/i,
  /^[a-z]:\/recovery(\/|$)/i,
  // The app's own encrypted secret store and Electron profile live here.
  /^[a-z]:\/users\/[^/]+\/appdata(\/|$)/i,
  /^[a-z]:\/users\/[^/]+\/ntuser\./i,
  /^\/(etc|usr|bin|sbin|lib|lib64|boot|sys|proc|dev|var)(\/|$)/i,
  /^\/system(\/|$)/i,
  /^\/library(\/|$)/i
]

/**
 * True when the absolute path points into an OS-owned or credential directory.
 *
 * Both the raw argument and its resolved form are tested, with separators
 * normalised to `/`. Checking only the resolved path would make the Windows
 * patterns depend on the host OS (`path.resolve` on POSIX just prefixes the
 * cwd to `C:\Windows`), and a security check that behaves differently in a test
 * run than in production is not worth having.
 */
export function isBlockedSystemPath(absPath: string): boolean {
  const candidates = new Set<string>()
  const normalise = (value: string): string => value.replace(/\\/g, '/')
  candidates.add(normalise(absPath))
  try {
    candidates.add(normalise(path.resolve(absPath)))
  } catch {
    /* an unresolvable path is judged on its literal form */
  }
  for (const candidate of candidates) {
    if (SYSTEM_PATH_PATTERNS.some((re) => re.test(candidate))) return true
  }
  return false
}

/**
 * Resolve a user/model supplied path against a list of roots.
 *
 * Two accepted shapes, both deliberate:
 *  - an absolute path that already sits inside an authorized root, and
 *  - a root-qualified path such as `documents/report.docx`, which is what small
 *    models actually produce when told "save it to Documents".
 *
 * Anything else is rejected rather than guessed at.
 */
export function resolveUnderRoots(
  roots: Array<{ path: string; label?: string; kind?: string }>,
  input: string
): { abs: string; root: string; relative: string } {
  if (typeof input !== 'string' || !input.trim()) {
    throw new PathError('A file path is required.', 'invalid')
  }
  if (input.includes('\0')) throw new PathError('Invalid path', 'invalid')

  const cleaned = input.trim()
  const isAbsolute = path.isAbsolute(cleaned)

  const candidates: Array<{ root: string; abs: string }> = []
  if (isAbsolute) {
    const abs = path.resolve(cleaned)
    for (const root of roots) {
      const resolvedRoot = path.resolve(root.path)
      if (isWithin(resolvedRoot, abs)) candidates.push({ root: resolvedRoot, abs })
    }
    if (!candidates.length) {
      throw new PathError(
        `That path is outside every authorized location: ${cleaned}. Use one of the roots from list_authorized_locations.`,
        'escape'
      )
    }
  } else {
    for (const root of roots) {
      const resolvedRoot = path.resolve(root.path)
      let candidate: string
      try {
        candidate = safeResolve(resolvedRoot, cleaned)
      } catch {
        continue
      }
      if (isWithin(resolvedRoot, candidate)) candidates.push({ root: resolvedRoot, abs: candidate })
    }
    if (!candidates.length) {
      // Fall back to the first root so a plain `report.docx` lands somewhere
      // predictable instead of failing the whole turn.
      const primary = roots[0]
      if (!primary) throw new PathError('No authorized locations are configured.', 'no_roots')
      const resolvedRoot = path.resolve(primary.path)
      candidates.push({ root: resolvedRoot, abs: safeResolve(resolvedRoot, cleaned) })
    }
  }

  const chosen = candidates[0]
  if (isBlockedSystemPath(chosen.abs)) {
    throw new PathError(
      `That location is protected by the operating system: ${chosen.abs}`,
      'system_path'
    )
  }
  assertInsideRoot(chosen.root, chosen.abs)
  return { abs: chosen.abs, root: chosen.root, relative: path.relative(chosen.root, chosen.abs) }
}

/**
 * Assert that a path is inside at least one root and is not a protected system
 * location. Kept separate from `resolveUnderRoots` so callers that already hold
 * an absolute path (screenshots, office documents) can verify it cheaply.
 */
export function assertWithinAuthorizedRoots(roots: string[], absPath: string): void {
  const abs = path.resolve(absPath)
  if (isBlockedSystemPath(abs)) {
    throw new PathError(`That location is protected by the operating system: ${abs}`, 'system_path')
  }
  for (const root of roots) {
    const resolvedRoot = path.resolve(root)
    if (isWithin(resolvedRoot, abs)) {
      assertInsideRoot(resolvedRoot, abs)
      return
    }
  }
  throw new PathError(
    `That path is outside every authorized location: ${abs}`,
    'escape'
  )
}

