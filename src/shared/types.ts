import type { AppearanceSettings, ThemePreference } from './theme'

export const APP_NAME = 'Alpha AI Workspace'
export const APP_ID = 'com.alpha.aiworkspace'
// Display/telemetry constant. The authoritative runtime version is read from the
// packaged app itself via `app.getVersion()` (see `app:info` diagnostics).
export const APP_VERSION = '1.0.5'
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'

export const MODES = ['chat', 'assist', 'agent'] as const
export type PermissionMode = (typeof MODES)[number]

export interface PermissionSettings {
  mode: PermissionMode
  fileWrites: PermissionLevel
  fileDeletes: PermissionLevel
  terminal: PermissionLevel
  packageInstall: PermissionLevel
  network: PermissionLevel
  gitCommit: PermissionLevel
  githubPush: PermissionLevel
  sensitiveFiles: PermissionLevel
}

export type PermissionLevel = 'allow' | 'ask' | 'deny'

export type ProviderKind = 'ollama' | 'openai-compatible' | 'gateway'

export interface ProviderConfig {
  id: string
  kind: ProviderKind
  name: string
  baseUrl: string
  enabled: boolean
  isLocal: boolean
  hasApiKey: boolean
  preset?: string
  createdAt: number
  updatedAt: number
}

export interface ModelCapabilities {
  streaming: boolean
  tools: boolean
  vision: boolean
}

export interface ModelInfo {
  id: string
  name: string
  providerId: string
  providerName: string
  providerKind: ProviderKind
  local: boolean
  capabilities: ModelCapabilities
  contextLength?: number
  parameterSize?: string
  quantization?: string
  family?: string
}

export type ProviderState = 'connected' | 'unreachable' | 'error' | 'checking' | 'unknown' | 'disabled'

export interface ProviderStatus {
  providerId: string
  state: ProviderState
  message?: string
  modelCount?: number
  latencyMs?: number
  checkedAt: number
}

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface AttachmentRef {
  id: string
  name: string
  mimeType: string
  size: number
  kind: 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'binary'
  extractedText?: string
  previewUrl?: string
  note?: string
}

export type ActivityState =
  | 'proposed'
  | 'awaiting-approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ActivityItem {
  id: string
  kind: 'tool' | 'command' | 'edit' | 'git' | 'status'
  title: string
  detail?: string
  state: ActivityState
  toolName?: string
  args?: unknown
  result?: unknown
  error?: string
  requiresApproval?: boolean
  approvalId?: string
  startedAt: number
  endedAt?: number
}

export interface ChatMessage {
  id: string
  conversationId: string
  role: Role
  content: string
  createdAt: number
  modelId?: string | null
  providerId?: string | null
  toolName?: string
  toolCallId?: string
  activity?: ActivityItem[]
  attachments?: AttachmentRef[]
}

export interface Conversation {
  id: string
  title: string
  titleSource?: 'auto' | 'manual'
  projectId?: string | null
  providerId?: string | null
  modelId?: string | null
  createdAt: number
  updatedAt: number
  messageCount?: number
  archivedAt?: number | null
}

export interface WorkspaceSelection {
  activeProjectId: string | null
  activeConversationId: string | null
}

export interface Project {
  id: string
  name: string
  rootPath: string
  createdAt: number
  lastOpenedAt: number
  isGitRepo?: boolean
  languageHints?: string[]
  frameworks?: string[]
}

export interface AppSettings {
  theme: ThemePreference
  appearance?: AppearanceSettings
  workspace?: WorkspaceSelection
  defaultProviderId?: string | null
  defaultModelId?: string | null
  ollamaUrl: string
  platform: {
    enabled: boolean
    apiBaseUrl: string
    authRedirectScheme: string
  }
  layout: {
    inspectorOpen: boolean
    inspectorWidth: number
    inspectorTab: InspectorTab
  }
  voice: {
    enabled: boolean
    transcriptionProviderId?: string | null
    transcriptionModel?: string
    autoSpeak: boolean
    language: string
  }
  privacy: {
    sendContextDisclosureAccepted: boolean
    logLevel: 'error' | 'warn' | 'info' | 'debug'
  }
  git: {
    publishBehavior: 'never' | 'ask' | 'auto'
    requireVerifiedRemote: boolean
  }
  permissions: PermissionSettings
  skills: {
    enabled: Record<string, boolean>
  }
}

export interface ProductSkill {
  id: string
  name: string
  description: string
  category: string
  version: string
  enabledByDefault: boolean
  enabled: boolean
  instructions: string
}

export type InspectorTab =
  | 'explorer'
  | 'changes'
  | 'diff'
  | 'activity'
  | 'terminal'
  | 'tests'
  | 'git'
  | 'browser'

export interface BrowserPreviewState {
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
}

export interface ChatUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

/**
 * Timing for one assistant turn, measured in the main process.
 *
 * These are real clock readings, not estimates: `promptMs` is context assembly,
 * `ttftMs` is what the user waits for before seeing anything (including a model
 * load), and the tool figures come from the activities themselves.
 */
export interface ChatMetrics {
  promptMs: number
  ttftMs: number
  totalMs: number
  promptTokens?: number
  outputTokens?: number
  tokensPerSecond?: number
  toolCalls: number
  toolMs: number
  historyMessages: number
}

export type ChatEventPayload =
  | { type: 'start'; requestId: string }
  | { type: 'metrics'; requestId: string; metrics: ChatMetrics }
  | { type: 'delta'; requestId: string; content: string }
  | { type: 'thinking'; requestId: string; content: string }
  | { type: 'activity'; requestId: string; activity: ActivityItem }
  | { type: 'tool-call'; requestId: string; call: { id: string; name: string; args: unknown } }
  | { type: 'tool-result'; requestId: string; callId: string; result: unknown }
  | { type: 'done'; requestId: string; messageId: string; content: string; usage?: ChatUsage }
  | { type: 'error'; requestId: string; error: string; code?: string }
  | { type: 'cancelled'; requestId: string }

export type ChatEvent = ChatEventPayload & { conversationId?: string }

export type TerminalEvent =
  | { type: 'start'; runId: string; command: string; cwd: string }
  | { type: 'stdout'; runId: string; data: string }
  | { type: 'stderr'; runId: string; data: string }
  | { type: 'exit'; runId: string; code: number | null; signal?: string; durationMs: number; cancelled?: boolean }
  | { type: 'error'; runId: string; error: string }

export interface ToolCallRequest {
  id: string
  name: string
  args: unknown
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  category: 'read' | 'write' | 'execute' | 'git'
  requiresApproval: boolean
  permissionKey: keyof PermissionSettings | 'read'
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
  size?: number
  ignored?: boolean
}

export interface SearchResult {
  path: string
  line: number
  column: number
  preview: string
}

export interface DiffFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  additions: number
  deletions: number
}

export interface GitStatus {
  isRepo: boolean
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  files: DiffFile[]
  remotes: { name: string; url: string }[]
  clean: boolean
  error?: string
}

export interface PlatformUsageItem {
  resource: string
  used: number
  limit: number | null
  unlimited: boolean
}

export interface PlatformModelAccess {
  modelId: string
  providerId: string
  providerLabel: string
  label: string
  allowed: boolean
  capabilities: { streaming: boolean; tools: boolean; vision: boolean }
  contextLength?: number
}

export interface PlatformAnnouncement {
  id: string
  title: string
  body: string
  level: 'info' | 'warning' | 'critical'
}

export interface PlatformConfig {
  account: {
    email: string
    fullName?: string
    status: 'active' | 'suspended' | 'disabled'
  } | null
  plan: {
    id: string
    name: string
    code: string
    interval?: string
    isTrial: boolean
  } | null
  subscription: { status: string; endsAt?: string } | null
  features: Record<string, unknown>
  limits: Record<string, number | null>
  usage: PlatformUsageItem[]
  models: PlatformModelAccess[]
  flags: Record<string, boolean>
  maintenance: { active: boolean; message?: string }
  announcements: PlatformAnnouncement[]
  desktop: { minVersion?: string; recommendedVersion?: string; forced?: string }
  serverTime: string
}

export interface PlatformStatus {
  enabled: boolean
  configured: boolean
  authenticated: boolean
  email?: string
  pendingSignIn?: boolean
  config: PlatformConfig | null
  error?: string
  lastUpdatedAt?: number
  /**
   * Which provider sign-in methods the deployment advertises. `undefined` means
   * "not asked yet" (or the deployment was unreachable), which the UI treats as
   * "offer everything" — the deployment itself then explains any refusal,
   * instead of the app hiding a provider that does work.
   */
  providers?: { google: boolean; github: boolean }
}

export interface ProposedEdit {
  path: string
  kind: 'write' | 'patch' | 'delete'
  before?: string
  after?: string
  diff?: string
  patch?: string
}

export interface PendingApproval {
  id: string
  kind: 'tool' | 'command' | 'edit' | 'git' | 'github'
  title: string
  detail: string
  payload: unknown
  permissionKey: string
  createdAt: number
}

export type UpdateState =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  version?: string
  percent?: number
  message?: string
  releaseName?: string
  releaseDate?: string
}

export type UpdateEvent = UpdateStatus

/** GitHub Device Flow: result of requesting a device code. */
export interface GithubDeviceStartResult {
  ok: boolean
  message?: string
  userCode?: string
  verificationUri?: string
  interval?: number
  expiresIn?: number
}

export type GithubDevicePollStatus =
  | 'pending'
  | 'slow_down'
  | 'success'
  | 'denied'
  | 'expired'
  | 'error'

/** GitHub Device Flow: result of a single token poll. */
export interface GithubDevicePollResult {
  status: GithubDevicePollStatus
  login?: string
  message?: string
  interval?: number
}

// ---------------------------------------------------------------------------
// Local models (Ollama)
// ---------------------------------------------------------------------------

/** A curated Ollama library entry. Sizes are approximate; the pull reports real ones. */
export interface OllamaCatalogEntry {
  name: string
  title: string
  description: string
  categories: string[]
  params: string
  approxBytes: number
  minRamGb: number
}

export interface HardwareInfo {
  totalRamGb: number
  freeRamGb: number
  cpuCount: number
  cpuModel: string
  gpu: { name: string; vramGb: number } | null
  platform: string
  probedAt: number
}

export type OllamaFit = 'comfortable' | 'tight' | 'too-large'

/** A catalog entry judged against this machine's memory. Guidance, not a benchmark. */
export interface OllamaRecommendation {
  model: OllamaCatalogEntry
  fit: OllamaFit
  needed: number
  reason: string
}

export interface OllamaStatus {
  reachable: boolean
  installed: boolean
  baseUrl: string
  installUrl: string
  version?: string
  models: ModelInfo[]
  message?: string
}

export type OllamaPullState = 'pulling' | 'done' | 'error' | 'cancelled'

/** Result of warming a local model into memory ahead of the first message. */
export interface OllamaPreloadResult {
  ok: boolean
  message?: string
  cached?: boolean
}

/** Progress for one model, streamed from Ollama while it downloads. */
export interface OllamaPullProgress {
  model: string
  state: OllamaPullState
  status: string
  completed?: number
  total?: number
  percent?: number
  elapsedMs?: number
  message?: string
}

export interface OllamaPullResult {
  ok: boolean
  model: string
  message?: string
  cancelled?: boolean
  elapsedMs?: number
}
