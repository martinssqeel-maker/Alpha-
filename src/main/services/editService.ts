import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { applyPatch, createTwoFilesPatch } from 'diff'
import type { EditProposalResult } from '@shared/ipc'
import { getLogger } from './logger'
import { PathError } from './pathGuard'
import type { CheckpointService } from './checkpoints'
import type { ProjectService } from './projectService'

interface Proposal {
  id: string
  projectId: string
  path: string
  kind: 'write' | 'patch' | 'delete'
  after?: string
  patch?: string
  baseHash: string | null
  existedAtPropose: boolean
  createdAt: number
}

export interface ProposeInput {
  projectId: string
  path: string
  kind?: 'write' | 'patch' | 'delete'
  after?: string
  patch?: string
  baseHash?: string
}

export class EditService {
  private proposals = new Map<string, Proposal>()

  constructor(
    private projects: ProjectService,
    private checkpoints: CheckpointService
  ) {}

  describeProposal(id: string): { path: string; kind: Proposal['kind'] } | null {
    const proposal = this.proposals.get(id)
    return proposal ? { path: proposal.path, kind: proposal.kind } : null
  }

  propose(input: ProposeInput): EditProposalResult {
    const kind = input.kind ?? 'write'
    let original = ''
    let existed = false
    let baseHash: string | null = input.baseHash ?? null
    try {
      const res = this.projects.readFile(input.projectId, input.path, { allowSensitive: true })
      original = res.content
      existed = true
      if (input.baseHash) baseHash = input.baseHash
      else baseHash = res.hash
    } catch (e) {
      if (e instanceof PathError && e.code === 'not_found') {
        original = ''
        existed = false
        baseHash = null
      } else {
        throw e
      }
    }

    let next = ''
    if (kind === 'write') {
      next = input.after ?? ''
    } else if (kind === 'patch') {
      if (!existed) throw new PathError('Cannot apply a patch to a file that does not exist.', 'not_found')
      if (!input.patch) throw new PathError('No patch provided.', 'invalid')
      const applied = applyPatch(original, input.patch, { fuzzFactor: 0 })
      if (applied === false) {
        throw new PathError(
          'The patch could not be applied cleanly. The file may have changed or the patch is malformed.',
          'patch_failed'
        )
      }
      next = applied
    } else {
      next = ''
    }

    const stale =
      existed && baseHash !== null
        ? this.projects.hashFile(input.projectId, input.path) !== baseHash
        : false

    const oldLabel = existed ? `a/${input.path}` : '/dev/null'
    const newLabel = kind === 'delete' ? '/dev/null' : `b/${input.path}`
    let diff = ''
    try {
      diff = createTwoFilesPatch(oldLabel, newLabel, original, next, '', '', { context: 3 })
    } catch (e) {
      getLogger().warn('edit', `diff generation failed: ${(e as Error).message}`)
      diff = ''
    }

    const proposal: Proposal = {
      id: randomUUID(),
      projectId: input.projectId,
      path: input.path,
      kind,
      after: input.after,
      patch: input.patch,
      baseHash,
      existedAtPropose: existed,
      createdAt: Date.now()
    }
    this.proposals.set(proposal.id, proposal)
    return {
      proposalId: proposal.id,
      path: proposal.path,
      kind,
      diff,
      stale,
      baseHash: baseHash ?? undefined
    }
  }

  apply(id: string): { ok: boolean; path: string; checkpointId?: string; message?: string } {
    const p = this.proposals.get(id)
    if (!p) return { ok: false, path: '', message: 'Proposal not found or expired.' }

    const currentHash = this.projects.hashFile(p.projectId, p.path)
    const nowExists = currentHash !== null

    if (p.existedAtPropose) {
      if (!nowExists) {
        return { ok: false, path: p.path, message: 'The file was deleted since the change was proposed.' }
      }
      if (p.baseHash && currentHash !== p.baseHash) {
        return {
          ok: false,
          path: p.path,
          message: 'The file changed on disk since the change was proposed. Re-read and re-propose.'
        }
      }
    } else if (nowExists) {
      return {
        ok: false,
        path: p.path,
        message: 'A file now exists at this path. Review it before writing.'
      }
    }

    let checkpointId: string | undefined
    if (p.existedAtPropose) {
      const cp = this.checkpoints.create(p.projectId, this.absPath(p))
      if (cp) checkpointId = cp.id
    }

    if (p.kind === 'delete') {
      const res = this.projects.deleteFile(p.projectId, p.path)
      if (!res.ok) return { ok: false, path: p.path, message: res.message }
      this.proposals.delete(id)
      return { ok: true, path: p.path, checkpointId }
    }

    // Determine final content
    let content = ''
    if (p.kind === 'write') content = p.after ?? ''
    else if (p.kind === 'patch') {
      const original = this.projects.readFile(p.projectId, p.path, { allowSensitive: true }).content
      const applied = applyPatch(original, p.patch ?? '', { fuzzFactor: 0 })
      if (applied === false) {
        return { ok: false, path: p.path, message: 'Patch no longer applies cleanly.' }
      }
      content = applied
    }

    const write = this.projects.writeFile(p.projectId, p.path, content, {
      expectedHash: p.existedAtPropose ? p.baseHash ?? undefined : undefined,
      createCheckpoint: false
    })
    if (!write.ok) return { ok: false, path: p.path, message: write.message, checkpointId }
    this.proposals.delete(id)
    getLogger().info('edit', `applied ${p.kind} to ${p.path}`)
    return { ok: true, path: p.path, checkpointId }
  }

  private absPath(p: Proposal): string {
    const root = this.projects.resolveRoot(p.projectId)
    return path.join(root, p.path)
  }
}
