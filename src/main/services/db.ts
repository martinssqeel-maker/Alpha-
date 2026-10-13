import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from 'sql.js'
import { getLogger } from './logger'

const require = createRequire(__filename)

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    project_id TEXT,
    provider_id TEXT,
    model_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    model_id TEXT,
    provider_id TEXT,
    tool_name TEXT,
    tool_call_id TEXT,
    activity TEXT,
    attachments TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    is_git_repo INTEGER DEFAULT 0,
    language_hints TEXT,
    frameworks TEXT
  );
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_local INTEGER NOT NULL DEFAULT 0,
    has_api_key INTEGER NOT NULL DEFAULT 0,
    preset TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    size INTEGER NOT NULL,
    backup_path TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_summaries (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    project_id TEXT,
    summary TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS git_events (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    kind TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL
  );
  `,
  // v2 — conversation naming, archive state, and workspace continuity.
  `
  ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'manual';
  ALTER TABLE conversations ADD COLUMN archived_at INTEGER;
  UPDATE conversations SET title_source = 'auto' WHERE title = 'New chat';
  `
]

export class Db {
  private db: SqlJsDatabase
  private filePath: string
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false

  private constructor(db: SqlJsDatabase, filePath: string) {
    this.db = db
    this.filePath = filePath
  }

  static async open(filePath: string): Promise<Db> {
    const log = getLogger()
    let wasmBinary: Buffer | undefined
    try {
      const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
      wasmBinary = fs.readFileSync(wasmPath)
    } catch (e) {
      log.warn('db', `wasm not found via require.resolve: ${redactErr(e)}`)
    }
    const SQL = await initSqlJs(
      wasmBinary
        ? { wasmBinary: copyToArrayBuffer(wasmBinary) }
        : undefined
    )
    let data: Uint8Array | undefined
    try {
      if (fs.existsSync(filePath)) {
        data = new Uint8Array(fs.readFileSync(filePath))
      }
    } catch (e) {
      log.warn('db', `could not read existing db, starting fresh: ${redactErr(e)}`)
    }
    let db: SqlJsDatabase
    try {
      db = data ? new SQL.Database(data) : new SQL.Database()
    } catch (e) {
      log.error('db', `database corrupted, starting fresh: ${redactErr(e)}`)
      const backup = filePath + '.corrupt-' + Date.now()
      try {
        if (data) fs.writeFileSync(backup, data)
      } catch {
        /* ignore */
      }
      db = new SQL.Database()
    }
    const instance = new Db(db, filePath)
    instance.migrate()
    return instance
  }

  private migrate(): void {
    const current = this.getUserVersion()
    for (let i = current; i < MIGRATIONS.length; i++) {
      try {
        this.db.run(MIGRATIONS[i])
        this.setUserVersion(i + 1)
      } catch (e) {
        getLogger().error('db', `migration ${i + 1} failed: ${redactErr(e)}`)
        throw e
      }
    }
    this.scheduleSave()
  }

  private getUserVersion(): number {
    const res = this.db.exec('PRAGMA user_version')
    if (res.length && res[0].values.length) return Number(res[0].values[0][0]) || 0
    return 0
  }

  private setUserVersion(v: number): void {
    this.db.run(`PRAGMA user_version = ${v}`)
  }

  run(sql: string, params: SqlValue[] = []): void {
    this.db.run(sql, params)
    this.scheduleSave()
  }

  all<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): T[] {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params)
      const rows: T[] = []
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as unknown as T)
      }
      return rows
    } finally {
      stmt.free()
    }
  }

  one<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): T | null {
    const rows = this.all<T>(sql, params)
    return rows.length ? rows[0] : null
  }

  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 250)
  }

  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    try {
      const data = this.db.export()
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp = this.filePath + '.tmp'
      fs.writeFileSync(tmp, Buffer.from(data))
      fs.renameSync(tmp, this.filePath)
    } catch (e) {
      getLogger().error('db', `flush failed: ${redactErr(e)}`)
    }
  }

  close(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.flush()
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }
}

function redactErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function copyToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buffer.byteLength)
  new Uint8Array(out).set(buffer)
  return out
}
