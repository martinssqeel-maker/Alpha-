import fs from 'node:fs'
import path from 'node:path'
import ignoreFactory, { type Ignore } from 'ignore'

export const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'release',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.turbo',
  'target',
  'bin',
  'obj',
  'venv',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.idea',
  '.gradle',
  '.terraform',
  '.dart_tool',
  'Pods',
  'vendor',
  '.git'
])

export const DEFAULT_IGNORED_GLOBS = [
  '*.log',
  '*.tmp',
  '*.temp',
  '.DS_Store',
  'Thumbs.db',
  '*.pyc',
  '*.class',
  '*.o',
  '*.obj',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib'
]

export class ProjectIgnore {
  private ig: Ignore
  private root: string

  constructor(root: string) {
    this.root = root
    this.ig = ignoreFactory()
    this.ig.add(DEFAULT_IGNORED_GLOBS)
    this.loadGitignore(path.join(root, '.gitignore'), '')
    this.loadGitignore(path.join(root, '.alphaignore'), '')
  }

  private loadGitignore(file: string, prefix: string): void {
    try {
      if (!fs.existsSync(file)) return
      const content = fs.readFileSync(file, 'utf8')
      const lines = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => (prefix ? `${prefix}/${l}` : l))
      this.ig.add(lines)
    } catch {
      /* ignore malformed ignore files */
    }
  }

  shouldIgnore(relPath: string, isDir = false): boolean {
    if (!relPath || relPath === '.') return false
    const posix = relPath.split(path.sep).join('/')
    const segments = posix.split('/')
    if (segments.some((s) => DEFAULT_IGNORED_DIRS.has(s))) return true
    try {
      return this.ig.ignores(isDir ? posix + '/' : posix)
    } catch {
      return false
    }
  }
}
