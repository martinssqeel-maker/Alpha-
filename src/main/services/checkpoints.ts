import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CheckpointInfo } from '@shared/ipc'
import { Db } from './db'
import { getLogger } from './logger'

export class CheckpointService {
  constructor(
    private db: Db,
    private baseDir: string
  ) {
    try {
      fs.mkdirSync(baseDir, { recursive: true })
    } catch {
      /* ignore */
    }
  }

  create(projectId: string, absPath: string): CheckpointInfo | null {
    try {
      if (!fs.existsSync(absPath)) return null
      const stat = fs.statSync(absPath)
      if (!stat.isFile()) return null
      const id = randomUUID()
      const dir = path.join(this.baseDir, projectId)
      fs.mkdirSync(dir, { recursive: true })
      const backupPath = path.join(dir, id)
      fs.copyFileSync(absPath, backupPath)
      const info: CheckpointInfo = {
        id,
        projectId,
        path: absPath,
        createdAt: Date.now(),
        size: stat.size
      }
      this.db.run(
        'INSERT INTO checkpoints (id, project_id, path, created_at, size, backup_path) VALUES (?, ?, ?, ?, ?, ?)',
        [id, projectId, absPath, info.createdAt, stat.size, backupPath]
      )
      return info
    } catch (e) {
      getLogger().error('checkpoints', `create failed: ${(e as Error).message}`)
      return null
    }
  }

  list(projectId: string): CheckpointInfo[] {
    const rows = this.db.all<{
      id: string
      project_id: string
      path: string
      created_at: number
      size: number
    }>(
      'SELECT id, project_id, path, created_at, size FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC LIMIT 200',
      [projectId]
    )
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      path: r.path,
      createdAt: Number(r.created_at),
      size: Number(r.size)
    }))
  }

  private backupPath(id: string): string | null {
    const row = this.db.one<{ backup_path: string }>(
      'SELECT backup_path FROM checkpoints WHERE id = ?',
      [id]
    )
    return row ? row.backup_path : null
  }

  restore(id: string): { ok: boolean; message?: string } {
    const row = this.db.one<{ path: string; backup_path: string }>(
      'SELECT path, backup_path FROM checkpoints WHERE id = ?',
      [id]
    )
    if (!row) return { ok: false, message: 'Checkpoint not found' }
    try {
      if (!fs.existsSync(row.backup_path)) {
        return { ok: false, message: 'Backup file is missing on disk' }
      }
      fs.mkdirSync(path.dirname(row.path), { recursive: true })
      fs.copyFileSync(row.backup_path, row.path)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  }

  get(id: string): CheckpointInfo | null {
    const row = this.db.one<{
      id: string
      project_id: string
      path: string
      created_at: number
      size: number
    }>('SELECT id, project_id, path, created_at, size FROM checkpoints WHERE id = ?', [id])
    if (!row) return null
    return {
      id: row.id,
      projectId: row.project_id,
      path: row.path,
      createdAt: Number(row.created_at),
      size: Number(row.size)
    }
  }
}
