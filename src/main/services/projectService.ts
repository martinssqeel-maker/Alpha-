import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { FileNode, Project, SearchResult } from '@shared/types'
import type { FileReadResult } from '@shared/ipc'
import { getLogger } from './logger'
import { ProjectIgnore } from './ignoreRules'
import {
  assertInsideRoot,
  detectLanguage,
  isBinaryBuffer,
  isGitInternal,
  isSensitivePath,
  PathError,
  safeResolve
} from './pathGuard'
import type { ProjectsRepo } from './store'

export interface ProjectMetadata {
  languageHints: string[]
  frameworks: string[]
  scripts: Record<string, string>
  packageManager?: string
  suggestedCommands: { label: string; command: string; reason: string }[]
}

const MAX_FILE_BYTES = 1_500_000
const MAX_CONTENT_RESULTS = 200
const MAX_SCAN_FILES = 25000

function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex')
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

export class ProjectService {
  private ignores = new Map<string, ProjectIgnore>()

  constructor(private repo: ProjectsRepo) {}

  resolveProject(id: string): Project {
    const project = this.repo.get(id)
    if (!project) throw new PathError('Project not found', 'not_found')
    return project
  }

  resolveRoot(id: string): string {
    return this.resolveProject(id).rootPath
  }

  ignoreFor(id: string): ProjectIgnore {
    let ig = this.ignores.get(id)
    if (!ig) {
      ig = new ProjectIgnore(this.resolveRoot(id))
      this.ignores.set(id, ig)
    }
    return ig
  }

  openProject(rootPath: string): { project: Project; metadata: ProjectMetadata } {
    const abs = path.resolve(rootPath)
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      throw new PathError('The selected folder does not exist.', 'not_found')
    }
    if (!stat.isDirectory()) {
      throw new PathError('The selected path is not a folder.', 'not_dir')
    }
    const metadata = this.detectMetadata(abs)
    const project = this.repo.upsert({
      name: path.basename(abs) || abs,
      rootPath: abs,
      isGitRepo: fs.existsSync(path.join(abs, '.git')),
      languageHints: metadata.languageHints,
      frameworks: metadata.frameworks
    })
    this.ignores.delete(project.id)
    getLogger().info('project', `opened ${abs}`)
    return { project, metadata }
  }

  private detectMetadata(root: string): ProjectMetadata {
    const languageHints = new Set<string>()
    const frameworks = new Set<string>()
    const scripts: Record<string, string> = {}
    let packageManager: string | undefined
    const suggestedCommands: ProjectMetadata['suggestedCommands'] = []

    const has = (f: string): boolean => fs.existsSync(path.join(root, f))
    const readJson = (f: string): Record<string, unknown> | null => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'))
      } catch {
        return null
      }
    }

    if (has('package.json')) {
      languageHints.add('JavaScript/TypeScript')
      const pkg = readJson('package.json') ?? {}
      const deps = {
        ...((pkg.dependencies as Record<string, string>) ?? {}),
        ...((pkg.devDependencies as Record<string, string>) ?? {})
      }
      const depNames = Object.keys(deps)
      for (const [name, label] of [
        ['react', 'React'],
        ['next', 'Next.js'],
        ['vue', 'Vue'],
        ['svelte', 'Svelte'],
        ['@angular/core', 'Angular'],
        ['express', 'Express'],
        ['nestjs', 'NestJS'],
        ['vite', 'Vite']
      ] as const) {
        if (depNames.includes(name)) frameworks.add(label)
      }
      const s = (pkg.scripts as Record<string, string>) ?? {}
      for (const [k, v] of Object.entries(s)) scripts[k] = String(v)
      if (has('pnpm-lock.yaml')) packageManager = 'pnpm'
      else if (has('yarn.lock')) packageManager = 'yarn'
      else if (has('bun.lockb')) packageManager = 'bun'
      else packageManager = 'npm'
      const runner = packageManager === 'npm' ? 'npm run' : packageManager
      if (scripts.test) suggestedCommands.push({ label: 'Run tests', command: `${runner} test`, reason: 'package.json test script' })
      if (scripts.build) suggestedCommands.push({ label: 'Build', command: `${runner} build`, reason: 'package.json build script' })
      if (scripts.lint) suggestedCommands.push({ label: 'Lint', command: `${runner} lint`, reason: 'package.json lint script' })
      if (scripts.dev) suggestedCommands.push({ label: 'Dev server', command: `${runner} dev`, reason: 'package.json dev script' })
    }
    if (has('tsconfig.json')) languageHints.add('TypeScript')
    if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
      languageHints.add('Python')
      if (has('requirements.txt')) {
        suggestedCommands.push({ label: 'Install deps', command: 'pip install -r requirements.txt', reason: 'requirements.txt', })
      }
      suggestedCommands.push({ label: 'Run tests', command: 'python -m pytest', reason: 'pytest convention' })
    }
    if (has('Cargo.toml')) {
      languageHints.add('Rust')
      suggestedCommands.push({ label: 'Run tests', command: 'cargo test', reason: 'Cargo.toml' })
      suggestedCommands.push({ label: 'Build', command: 'cargo build', reason: 'Cargo.toml' })
    }
    if (has('go.mod')) {
      languageHints.add('Go')
      suggestedCommands.push({ label: 'Run tests', command: 'go test ./...', reason: 'go.mod' })
      suggestedCommands.push({ label: 'Build', command: 'go build ./...', reason: 'go.mod' })
    }
    if (has('pom.xml')) languageHints.add('Java')
    if (has('build.gradle') || has('build.gradle.kts')) languageHints.add('Kotlin/Java')
    if (has('composer.json')) languageHints.add('PHP')
    if (has('Gemfile')) languageHints.add('Ruby')
    if (has('pubspec.yaml')) {
      languageHints.add('Dart/Flutter')
      suggestedCommands.push({ label: 'Run tests', command: 'flutter test', reason: 'pubspec.yaml' })
    }
    if (fs.existsSync(path.join(root, '.git'))) {
      suggestedCommands.push({ label: 'Git status', command: 'git status', reason: 'Git repository' })
    }
    if (languageHints.size === 0) languageHints.add('Unknown')

    return {
      languageHints: [...languageHints],
      frameworks: [...frameworks],
      scripts,
      packageManager,
      suggestedCommands
    }
  }

  suggestCommands(projectId: string): ProjectMetadata['suggestedCommands'] {
    return this.detectMetadata(this.resolveRoot(projectId)).suggestedCommands
  }

  listTree(projectId: string, relPath = '', depth = 2): FileNode[] {
    const root = this.resolveRoot(projectId)
    const ig = this.ignoreFor(projectId)
    const start = relPath ? safeResolve(root, relPath) : root
    assertInsideRoot(root, start)
    let stat: fs.Stats
    try {
      stat = fs.statSync(start)
    } catch {
      throw new PathError('Directory not found', 'not_found')
    }
    if (!stat.isDirectory()) throw new PathError('Not a directory', 'not_dir')
    return this.readDir(root, start, ig, depth, 0)
  }

  private readDir(
    root: string,
    absDir: string,
    ig: ProjectIgnore,
    maxDepth: number,
    depth: number
  ): FileNode[] {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch (e) {
      getLogger().debug('project', `readdir failed ${absDir}: ${(e as Error).message}`)
      return []
    }
    const nodes: FileNode[] = []
    const dirs: FileNode[] = []
    const files: FileNode[] = []
    for (const entry of entries) {
      if (nodes.length + dirs.length + files.length > 5000) break
      const abs = path.join(absDir, entry.name)
      const rel = toPosix(path.relative(root, abs))
      if (entry.name === '.git') continue
      const isDir = entry.isDirectory()
      if (ig.shouldIgnore(rel, isDir)) continue
      let size: number | undefined
      if (!isDir) {
        try {
          size = fs.statSync(abs).size
        } catch {
          size = undefined
        }
      }
      const node: FileNode = {
        name: entry.name,
        path: rel,
        type: isDir ? 'directory' : 'file',
        size,
        ignored: isSensitivePath(rel) || undefined
      }
      if (isDir) {
        if (depth < maxDepth) {
          node.children = this.readDir(root, abs, ig, maxDepth, depth + 1)
        }
        dirs.push(node)
      } else {
        files.push(node)
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name))
    files.sort((a, b) => a.name.localeCompare(b.name))
    return [...dirs, ...files]
  }

  readFile(
    projectId: string,
    relPath: string,
    opts: { maxBytes?: number; allowSensitive?: boolean } = {}
  ): FileReadResult {
    const root = this.resolveRoot(projectId)
    const abs = safeResolve(root, relPath)
    assertInsideRoot(root, abs)
    if (isGitInternal(relPath)) throw new PathError('Access to .git internals is blocked.', 'git_internal')
    if (isSensitivePath(relPath) && !opts.allowSensitive) {
      throw new PathError(
        'This file looks like it may contain secrets and is protected. Enable sensitive-file access to read it.',
        'sensitive'
      )
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      throw new PathError('File not found', 'not_found')
    }
    if (stat.isDirectory()) throw new PathError('Path is a directory', 'is_dir')
    const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES
    const full = stat.size <= 5_000_000 ? fs.readFileSync(abs) : fs.readFileSync(abs).subarray(0, maxBytes)
    const truncated = full.length > maxBytes
    const slice = truncated ? full.subarray(0, maxBytes) : full
    const binary = isBinaryBuffer(slice)
    return {
      path: toPosix(relPath),
      content: binary ? '' : slice.toString('utf8'),
      size: stat.size,
      hash: sha1(full),
      binary,
      truncated,
      language: detectLanguage(abs)
    }
  }

  hashFile(projectId: string, relPath: string): string | null {
    try {
      const root = this.resolveRoot(projectId)
      const abs = safeResolve(root, relPath)
      assertInsideRoot(root, abs)
      const buf = fs.readFileSync(abs)
      return sha1(buf)
    } catch {
      return null
    }
  }

  writeFile(
    projectId: string,
    relPath: string,
    content: string,
    opts: { expectedHash?: string; createCheckpoint?: boolean; onCheckpoint?: (p: string) => void } = {}
  ): { ok: boolean; hash: string; conflict?: boolean; message?: string } {
    const root = this.resolveRoot(projectId)
    const abs = safeResolve(root, relPath)
    assertInsideRoot(root, abs)
    if (isGitInternal(relPath)) {
      return { ok: false, hash: '', message: 'Writing inside .git is blocked.' }
    }
    let existed = false
    let currentHash: string | null = null
    if (fs.existsSync(abs)) {
      const s = fs.statSync(abs)
      if (s.isDirectory()) return { ok: false, hash: '', message: 'Target is a directory.' }
      existed = true
      currentHash = sha1(fs.readFileSync(abs))
      if (opts.expectedHash && currentHash !== opts.expectedHash) {
        return {
          ok: false,
          hash: currentHash,
          conflict: true,
          message: 'The file changed on disk since it was read. Re-read the file before editing.'
        }
      }
      if (opts.createCheckpoint !== false) {
        opts.onCheckpoint?.(abs)
      }
    }
    const buf = Buffer.from(content, 'utf8')
    const tmp = abs + '.alpha-tmp-' + process.pid + '-' + Date.now()
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(tmp, buf)
      fs.renameSync(tmp, abs)
    } catch (e) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      return { ok: false, hash: '', message: (e as Error).message }
    }
    getLogger().info('project', `${existed ? 'modified' : 'created'} ${relPath}`)
    return { ok: true, hash: sha1(buf) }
  }

  deleteFile(projectId: string, relPath: string): { ok: boolean; message?: string } {
    const root = this.resolveRoot(projectId)
    const abs = safeResolve(root, relPath)
    assertInsideRoot(root, abs)
    if (isGitInternal(relPath)) return { ok: false, message: 'Deleting inside .git is blocked.' }
    try {
      const s = fs.statSync(abs)
      if (s.isDirectory()) return { ok: false, message: 'Refusing to delete a directory.' }
      fs.unlinkSync(abs)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  }

  searchNames(projectId: string, query: string, maxResults = 200): FileNode[] {
    const root = this.resolveRoot(projectId)
    const ig = this.ignoreFor(projectId)
    const q = query.toLowerCase()
    const out: FileNode[] = []
    let scanned = 0
    const walk = (dir: string): void => {
      if (out.length >= maxResults || scanned >= MAX_SCAN_FILES) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (out.length >= maxResults || scanned >= MAX_SCAN_FILES) return
        const abs = path.join(dir, entry.name)
        const rel = toPosix(path.relative(root, abs))
        if (entry.isDirectory()) {
          if (ig.shouldIgnore(rel, true)) continue
          walk(abs)
        } else {
          scanned++
          if (ig.shouldIgnore(rel, false)) continue
          if (entry.name.toLowerCase().includes(q)) {
            let size: number | undefined
            try {
              size = fs.statSync(abs).size
            } catch {
              size = undefined
            }
            out.push({ name: entry.name, path: rel, type: 'file', size })
          }
        }
      }
    }
    walk(root)
    return out
  }

  searchContent(projectId: string, query: string, maxResults = MAX_CONTENT_RESULTS): SearchResult[] {
    const root = this.resolveRoot(projectId)
    const ig = this.ignoreFor(projectId)
    const q = query.toLowerCase()
    const out: SearchResult[] = []
    let scanned = 0
    const walk = (dir: string): void => {
      if (out.length >= maxResults || scanned >= MAX_SCAN_FILES) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (out.length >= maxResults || scanned >= MAX_SCAN_FILES) return
        const abs = path.join(dir, entry.name)
        const rel = toPosix(path.relative(root, abs))
        if (entry.isDirectory()) {
          if (ig.shouldIgnore(rel, true)) continue
          walk(abs)
        } else {
          scanned++
          if (ig.shouldIgnore(rel, false)) continue
          if (isSensitivePath(rel)) continue
          const lang = detectLanguage(abs)
          if (!lang && !/\.(txt|env)\b/i.test(entry.name)) continue
          let stat: fs.Stats
          try {
            stat = fs.statSync(abs)
          } catch {
            continue
          }
          if (stat.size > MAX_FILE_BYTES) continue
          let buf: Buffer
          try {
            buf = fs.readFileSync(abs)
          } catch {
            continue
          }
          if (isBinaryBuffer(buf)) continue
          const lines = buf.toString('utf8').split(/\r?\n/)
          for (let i = 0; i < lines.length && out.length < maxResults; i++) {
            const idx = lines[i].toLowerCase().indexOf(q)
            if (idx >= 0) {
              out.push({
                path: rel,
                line: i + 1,
                column: idx + 1,
                preview: lines[i].slice(0, 240)
              })
            }
          }
        }
      }
    }
    walk(root)
    return out
  }
}
