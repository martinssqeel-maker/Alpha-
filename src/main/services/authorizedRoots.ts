import fs from 'node:fs'
import path from 'node:path'
import type { AuthorizedLocation, AuthorizedRootKind } from '@shared/types'
import {
  assertWithinAuthorizedRoots,
  isBlockedSystemPath,
  PathError,
  resolveUnderRoots
} from './pathGuard'
import type { SettingsRepo } from './store'

export interface StandardUserPaths {
  documents: string
  desktop: string
  downloads: string
}

export interface AuthorizedRootsOptions {
  /** Resolved once at startup from Electron's `app.getPath(...)`. */
  standardPaths: StandardUserPaths
  settings: SettingsRepo
  /** The open coding project, if any — the narrowest and highest-priority root. */
  projectRoot: () => string | null
}

/**
 * The set of folders the desktop agent may read and write.
 *
 * This is the *widening* half of the path policy: `pathGuard` still does every
 * containment and symlink check. The job here is deciding which roots exist,
 * presenting them to the model in a stable order, and refusing to hand out a
 * root the user has switched off.
 *
 * Order matters. The open project comes first so relative paths resolve there
 * when a coding task is in progress; user folders follow in a fixed, documented
 * order so `documents/report.docx` means the same thing every run.
 */
export class AuthorizedRoots {
  constructor(private readonly options: AuthorizedRootsOptions) {}

  list(): AuthorizedLocation[] {
    const settings = this.options.settings.get()
    const agent = settings.agent
    const locations: AuthorizedLocation[] = []

    const projectRoot = this.safeProjectRoot()
    if (projectRoot) {
      locations.push(this.describe('project', 'Current project', projectRoot, 'project'))
    }

    if (agent?.workspace?.documents !== false) {
      locations.push(
        this.describe('documents', 'Documents', this.options.standardPaths.documents, 'documents')
      )
    }
    if (agent?.workspace?.desktop !== false) {
      locations.push(this.describe('desktop', 'Desktop', this.options.standardPaths.desktop, 'desktop'))
    }
    if (agent?.workspace?.downloads !== false) {
      locations.push(
        this.describe('downloads', 'Downloads', this.options.standardPaths.downloads, 'downloads')
      )
    }

    for (const [index, extra] of (agent?.extraPaths ?? []).entries()) {
      if (typeof extra !== 'string' || !extra.trim()) continue
      const abs = path.resolve(extra)
      if (isBlockedSystemPath(abs)) continue
      locations.push(this.describe(`custom-${index}`, path.basename(abs) || abs, abs, 'custom'))
    }

    // De-duplicate by resolved path (a user may add Documents as a custom root).
    const seen = new Set<string>()
    return locations.filter((location) => {
      const key = path.resolve(location.path).toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  /** Just the paths, for `pathGuard` calls. */
  roots(): string[] {
    return this.list().map((location) => location.path)
  }

  /**
   * Resolve a model-supplied path to an absolute one inside an authorized root.
   * Throws `PathError` with an actionable message the model can recover from.
   */
  resolve(input: string): { abs: string; root: string; relative: string; location: AuthorizedLocation } {
    const locations = this.list()
    if (!locations.length) {
      throw new PathError(
        'No authorized locations are configured. Enable one in Settings → Agent.',
        'no_roots'
      )
    }
    // Accept friendly aliases first so `documents/x` is not mistaken for a
    // relative path inside the project.
    const aliased = this.applyAlias(input, locations)
    const resolved = resolveUnderRoots(locations, aliased)
    const location =
      locations.find((l) => path.resolve(l.path) === path.resolve(resolved.root)) ?? locations[0]
    return { ...resolved, location }
  }

  /** Verify an already-absolute path (screenshots, Office saves). */
  assertAllowed(absPath: string): void {
    assertWithinAuthorizedRoots(this.roots(), absPath)
  }

  /** Create the parent directory for a write inside an authorized root. */
  ensureParent(absPath: string): void {
    this.assertAllowed(absPath)
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
  }

  /** The root a caller should use when no path was supplied at all. */
  defaultLocation(): AuthorizedLocation {
    const locations = this.list()
    if (!locations.length) throw new PathError('No authorized locations are configured.', 'no_roots')
    // Prefer Documents for produced documents; it is the least surprising place.
    return (
      locations.find((l) => l.kind === 'documents') ??
      locations.find((l) => l.kind === 'project') ??
      locations[0]
    )
  }

  private applyAlias(input: string, locations: AuthorizedLocation[]): string {
    const cleaned = input.trim().replace(/\\/g, '/')
    const match = /^(documents?|desktop|downloads?|home|~)\/(.*)$/i.exec(cleaned)
    if (!match) return input
    const [, alias, rest] = match
    const kind: AuthorizedRootKind | 'home' =
      /^doc/i.test(alias) ? 'documents' : /^desk/i.test(alias) ? 'desktop' : /^down/i.test(alias) ? 'downloads' : 'home'
    if (kind === 'home') {
      const projectOrDocs = locations.find((l) => l.kind === 'documents') ?? locations[0]
      return path.join(projectOrDocs.path, rest)
    }
    const location = locations.find((l) => l.kind === kind)
    // No alias target enabled → leave the input alone so the normal resolver can
    // either satisfy it (project-relative) or produce the usual error.
    return location ? path.join(location.path, rest) : input
  }

  private describe(
    id: string,
    label: string,
    rawPath: string,
    kind: AuthorizedRootKind
  ): AuthorizedLocation {
    const abs = path.resolve(rawPath)
    const exists = safeExists(abs)
    return {
      id,
      label,
      path: abs,
      kind,
      exists,
      // A non-existent standard folder is still writable (we create it), so only
      // an explicit probe failure downgrades this.
      writable: !isBlockedSystemPath(abs) && (exists ? safeWritable(abs) : true)
    }
  }

  private safeProjectRoot(): string | null {
    try {
      return this.options.projectRoot()
    } catch {
      return null
    }
  }
}

function safeExists(target: string): boolean {
  try {
    return fs.existsSync(target)
  } catch {
    return false
  }
}

function safeWritable(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}
