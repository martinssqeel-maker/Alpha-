import { randomUUID } from 'node:crypto'
import type { SqlValue } from 'sql.js'
import type {
  AppSettings,
  ChatMessage,
  Conversation,
  ModelInfo,
  Project,
  ProviderConfig,
  ProviderKind
} from '@shared/types'
import { DEFAULT_OLLAMA_URL } from '@shared/types'
import { DEFAULT_PERMISSIONS } from '@shared/permissions'
import { Db } from './db'

/** Defaults for the Alpha Cloud (platform) connection. */
export const PLATFORM_DEFAULTS: AppSettings['platform'] = {
  enabled: false,
  apiBaseUrl: '',
  authRedirectScheme: 'alpha'
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  defaultProviderId: null,
  defaultModelId: null,
  ollamaUrl: DEFAULT_OLLAMA_URL,
  layout: {
    inspectorOpen: true,
    inspectorWidth: 420,
    inspectorTab: 'explorer'
  },
  voice: {
    enabled: false,
    transcriptionProviderId: null,
    transcriptionModel: '',
    autoSpeak: false,
    language: 'en'
  },
  privacy: {
    sendContextDisclosureAccepted: false,
    logLevel: 'info'
  },
  git: {
    publishBehavior: 'ask',
    requireVerifiedRemote: true
  },
  platform: { ...PLATFORM_DEFAULTS },
  permissions: DEFAULT_PERMISSIONS
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return (patch === undefined ? base : (patch as T))
  }
  const baseObj = (
    base !== null && typeof base === 'object' && !Array.isArray(base) ? base : {}
  ) as Record<string, unknown>
  const out: Record<string, unknown> = { ...baseObj }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge(baseObj[k], v)
  }
  return out as T
}

export class SettingsRepo {
  constructor(private db: Db) {}

  get(): AppSettings {
    const rows = this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings')
    const raw: Record<string, unknown> = {}
    for (const r of rows) {
      // 'root' is a redundant full snapshot written by set(); the per-key rows
      // below carry the real data, so skip it to avoid re-merging a nested blob.
      if (r.key === 'root') continue
      try {
        raw[r.key] = JSON.parse(r.value)
      } catch {
        raw[r.key] = r.value
      }
    }
    return deepMerge(DEFAULT_SETTINGS, raw)
  }

  set(patch: Record<string, unknown>): AppSettings {
    const current = this.get()
    const next = deepMerge(current, patch)
    this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'root',
      JSON.stringify(next)
    ])
    // also write individual top-level keys so partial reads are resilient
    for (const [k, v] of Object.entries(next)) {
      this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
        k,
        JSON.stringify(v)
      ])
    }
    // remove stale individual keys not in next
    const existing = this.db.all<{ key: string }>("SELECT key FROM settings WHERE key != 'root'")
    for (const row of existing) {
      if (!(row.key in next)) {
        this.db.run('DELETE FROM settings WHERE key = ?', [row.key])
      }
    }
    return next
  }
}

export class ConversationsRepo {
  constructor(private db: Db) {}

  list(): Conversation[] {
    const rows = this.db.all<Record<string, SqlValue>>(
      `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c ORDER BY updated_at DESC`
    )
    return rows.map(mapConversation)
  }

  get(id: string): Conversation | null {
    const row = this.db.one<Record<string, SqlValue>>('SELECT * FROM conversations WHERE id = ?', [id])
    return row ? mapConversation(row) : null
  }

  create(input: Partial<Conversation>): Conversation {
    const now = Date.now()
    const conv: Conversation = {
      id: input.id || randomUUID(),
      title: input.title || 'New chat',
      projectId: input.projectId ?? null,
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      createdAt: now,
      updatedAt: now
    }
    this.db.run(
      `INSERT INTO conversations (id, title, project_id, provider_id, model_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [conv.id, conv.title, conv.projectId ?? null, conv.providerId ?? null, conv.modelId ?? null, conv.createdAt, conv.updatedAt]
    )
    return conv
  }

  update(id: string, patch: Partial<Conversation>): Conversation | null {
    const current = this.get(id)
    if (!current) return null
    const next = { ...current, ...patch, id, updatedAt: Date.now() }
    this.db.run(
      `UPDATE conversations SET title = ?, project_id = ?, provider_id = ?, model_id = ?, updated_at = ? WHERE id = ?`,
      [next.title, next.projectId ?? null, next.providerId ?? null, next.modelId ?? null, next.updatedAt, id]
    )
    return next
  }

  touch(id: string): void {
    this.db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [Date.now(), id])
  }

  delete(id: string): void {
    this.db.run('DELETE FROM messages WHERE conversation_id = ?', [id])
    this.db.run('DELETE FROM conversations WHERE id = ?', [id])
  }

  clearMessages(id: string): void {
    this.db.run('DELETE FROM messages WHERE conversation_id = ?', [id])
  }

  messages(conversationId: string): ChatMessage[] {
    const rows = this.db.all<Record<string, SqlValue>>(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
      [conversationId]
    )
    return rows.map(mapMessage)
  }

  append(input: {
    id?: string
    conversationId: string
    role: ChatMessage['role']
    content: string
    modelId?: string | null
    providerId?: string | null
    toolName?: string
    toolCallId?: string
    activity?: unknown
    attachments?: unknown
  }): ChatMessage {
    const msg: ChatMessage = {
      id: input.id || randomUUID(),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      createdAt: Date.now(),
      modelId: input.modelId ?? null,
      providerId: input.providerId ?? null,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      activity: input.activity as ChatMessage['activity'],
      attachments: input.attachments as ChatMessage['attachments']
    }
    this.db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at, model_id, provider_id, tool_name, tool_call_id, activity, attachments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.id,
        msg.conversationId,
        msg.role,
        msg.content,
        msg.createdAt,
        msg.modelId ?? null,
        msg.providerId ?? null,
        msg.toolName ?? null,
        msg.toolCallId ?? null,
        input.activity ? JSON.stringify(input.activity) : null,
        input.attachments ? JSON.stringify(input.attachments) : null
      ]
    )
    this.touch(msg.conversationId)
    return msg
  }

  countForProject(projectId: string): number {
    const row = this.db.one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM conversations WHERE project_id = ?',
      [projectId]
    )
    return Number(row?.n ?? 0)
  }
}

export class ProjectsRepo {
  constructor(private db: Db) {}

  list(): Project[] {
    const rows = this.db.all<Record<string, SqlValue>>(
      'SELECT * FROM projects ORDER BY last_opened_at DESC'
    )
    return rows.map(mapProject)
  }

  get(id: string): Project | null {
    const row = this.db.one<Record<string, SqlValue>>('SELECT * FROM projects WHERE id = ?', [id])
    return row ? mapProject(row) : null
  }

  getByPath(rootPath: string): Project | null {
    const row = this.db.one<Record<string, SqlValue>>('SELECT * FROM projects WHERE root_path = ?', [
      rootPath
    ])
    return row ? mapProject(row) : null
  }

  upsert(input: Partial<Project> & { name: string; rootPath: string }): Project {
    const existing = this.getByPath(input.rootPath)
    const now = Date.now()
    if (existing) {
      this.touch(existing.id, input.isGitRepo, input.languageHints, input.frameworks)
      return { ...existing, lastOpenedAt: now }
    }
    const project: Project = {
      id: input.id || randomUUID(),
      name: input.name,
      rootPath: input.rootPath,
      createdAt: now,
      lastOpenedAt: now,
      isGitRepo: input.isGitRepo,
      languageHints: input.languageHints,
      frameworks: input.frameworks
    }
    this.db.run(
      `INSERT INTO projects (id, name, root_path, created_at, last_opened_at, is_git_repo, language_hints, frameworks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        project.id,
        project.name,
        project.rootPath,
        project.createdAt,
        project.lastOpenedAt,
        project.isGitRepo ? 1 : 0,
        JSON.stringify(project.languageHints ?? []),
        JSON.stringify(project.frameworks ?? [])
      ]
    )
    return project
  }

  touch(id: string, isGitRepo?: boolean, languageHints?: string[], frameworks?: string[]): void {
    const project = this.get(id)
    if (!project) return
    this.db.run(
      'UPDATE projects SET last_opened_at = ?, is_git_repo = ?, language_hints = ?, frameworks = ? WHERE id = ?',
      [
        Date.now(),
        (isGitRepo ?? project.isGitRepo) ? 1 : 0,
        JSON.stringify(languageHints ?? project.languageHints ?? []),
        JSON.stringify(frameworks ?? project.frameworks ?? []),
        id
      ]
    )
  }

  remove(id: string): void {
    this.db.run('DELETE FROM projects WHERE id = ?', [id])
  }
}

export class ProvidersRepo {
  constructor(private db: Db) {}

  list(): ProviderConfig[] {
    const rows = this.db.all<Record<string, SqlValue>>('SELECT * FROM providers ORDER BY name ASC')
    return rows.map(mapProvider)
  }

  get(id: string): ProviderConfig | null {
    const row = this.db.one<Record<string, SqlValue>>('SELECT * FROM providers WHERE id = ?', [id])
    return row ? mapProvider(row) : null
  }

  save(input: {
    id?: string
    kind: ProviderKind
    name: string
    baseUrl: string
    enabled: boolean
    isLocal: boolean
    hasApiKey: boolean
    preset?: string
  }): ProviderConfig {
    const now = Date.now()
    const id = input.id || randomUUID()
    const existing = this.get(id)
    if (existing) {
      this.db.run(
        `UPDATE providers SET kind = ?, name = ?, base_url = ?, enabled = ?, is_local = ?, has_api_key = ?, preset = ?, updated_at = ? WHERE id = ?`,
        [
          input.kind,
          input.name,
          input.baseUrl,
          input.enabled ? 1 : 0,
          input.isLocal ? 1 : 0,
          input.hasApiKey ? 1 : 0,
          input.preset ?? null,
          now,
          id
        ]
      )
    } else {
      this.db.run(
        `INSERT INTO providers (id, kind, name, base_url, enabled, is_local, has_api_key, preset, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.kind,
          input.name,
          input.baseUrl,
          input.enabled ? 1 : 0,
          input.isLocal ? 1 : 0,
          input.hasApiKey ? 1 : 0,
          input.preset ?? null,
          now,
          now
        ]
      )
    }
    return this.get(id) as ProviderConfig
  }

  remove(id: string): void {
    this.db.run('DELETE FROM providers WHERE id = ?', [id])
  }
}

export function modelKey(model: ModelInfo): string {
  return `${model.providerId}:${model.id}`
}

function mapConversation(row: Record<string, SqlValue>): Conversation {
  return {
    id: String(row.id),
    title: String(row.title),
    projectId: (row.project_id as string) ?? null,
    providerId: (row.provider_id as string) ?? null,
    modelId: (row.model_id as string) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    messageCount: row.message_count !== undefined ? Number(row.message_count) : undefined
  }
}

function mapMessage(row: Record<string, SqlValue>): ChatMessage {
  let activity: ChatMessage['activity']
  let attachments: ChatMessage['attachments']
  try {
    activity = row.activity ? JSON.parse(String(row.activity)) : undefined
  } catch {
    activity = undefined
  }
  try {
    attachments = row.attachments ? JSON.parse(String(row.attachments)) : undefined
  } catch {
    attachments = undefined
  }
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: String(row.role) as ChatMessage['role'],
    content: String(row.content),
    createdAt: Number(row.created_at),
    modelId: (row.model_id as string) ?? null,
    providerId: (row.provider_id as string) ?? null,
    toolName: (row.tool_name as string) ?? undefined,
    toolCallId: (row.tool_call_id as string) ?? undefined,
    activity,
    attachments
  }
}

function mapProject(row: Record<string, SqlValue>): Project {
  let languageHints: string[] = []
  let frameworks: string[] = []
  try {
    languageHints = row.language_hints ? JSON.parse(String(row.language_hints)) : []
  } catch {
    languageHints = []
  }
  try {
    frameworks = row.frameworks ? JSON.parse(String(row.frameworks)) : []
  } catch {
    frameworks = []
  }
  return {
    id: String(row.id),
    name: String(row.name),
    rootPath: String(row.root_path),
    createdAt: Number(row.created_at),
    lastOpenedAt: Number(row.last_opened_at),
    isGitRepo: Boolean(row.is_git_repo),
    languageHints,
    frameworks
  }
}

function mapProvider(row: Record<string, SqlValue>): ProviderConfig {
  return {
    id: String(row.id),
    kind: String(row.kind) as ProviderKind,
    name: String(row.name),
    baseUrl: String(row.base_url),
    enabled: Boolean(row.enabled),
    isLocal: Boolean(row.is_local),
    hasApiKey: Boolean(row.has_api_key),
    preset: (row.preset as string) ?? undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}
