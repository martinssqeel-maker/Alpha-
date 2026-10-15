import { CH } from './channels'
import type {
  ActivityItem,
  AppSettings,
  AttachmentRef,
  BrowserPreviewState,
  ChatMessage,
  Conversation,
  DiffFile,
  FileNode,
  GitStatus,
  GithubDevicePollResult,
  GithubDeviceStartResult,
  ModelInfo,
  HardwareInfo,
  OllamaCatalogEntry,
  OllamaPreloadResult,
  OllamaPullProgress,
  OllamaPullResult,
  OllamaRecommendation,
  OllamaStatus,
  PendingApproval,
  PlatformStatus,
  Project,
  ProductSkill,
  ProviderConfig,
  ProviderStatus,
  SearchResult,
  UpdateStatus
} from './types'
import type { ResolvedTheme } from './theme'

export interface DiagnosticsInfo {
  appVersion: string
  electron: string
  chrome: string
  node: string
  platform: string
  sqlite: boolean
  git: { available: boolean; version?: string }
  gh: { available: boolean; version?: string }
  providers: ProviderStatus[]
  dbPath: string
  dataPath: string
  logPath: string
}

export interface ProjectInfo {
  project: Project
  git: GitStatus
  files: FileNode[]
}

export interface EditProposalResult {
  proposalId: string
  path: string
  kind: 'write' | 'patch' | 'delete'
  diff: string
  stale: boolean
  baseHash?: string
}

export interface CheckpointInfo {
  id: string
  projectId: string
  path: string
  createdAt: number
  size: number
}

export interface FileReadResult {
  path: string
  content: string
  size: number
  hash: string
  binary: boolean
  truncated: boolean
  language?: string
}

export interface TerminalRunResult {
  runId: string
  approved: boolean
  requiresApproval?: boolean
  approvalId?: string
  command: string
  cwd: string
  reason: string
}

export interface IpcContract {
  [CH.appInfo]: { req: void; res: DiagnosticsInfo }
  [CH.diagnostics]: { req: void; res: DiagnosticsInfo }
  [CH.appTheme]: { req: { theme: ResolvedTheme }; res: { ok: true } }
  [CH.revealPath]: { req: { path: string }; res: { ok: true } }
  [CH.openExternal]: { req: { url: string }; res: { ok: boolean; message?: string } }
  [CH.updateCheck]: { req: void; res: UpdateStatus }
  [CH.updateDownload]: { req: void; res: UpdateStatus }
  [CH.updateInstall]: { req: void; res: { ok: boolean; message?: string } }
  [CH.updateStatus]: { req: void; res: UpdateStatus }

  [CH.settingsGet]: { req: void; res: AppSettings }
  [CH.settingsSet]: { req: { patch: Record<string, unknown> }; res: AppSettings }

  [CH.secretsSet]: { req: { ref: string; value: string }; res: { ok: true } }
  [CH.secretsDelete]: { req: { ref: string }; res: { ok: true } }
  [CH.secretsHas]: { req: { ref: string }; res: { has: boolean } }

  [CH.skillsList]: { req: void; res: ProductSkill[] }
  [CH.skillsSetEnabled]: { req: { id: string; enabled: boolean }; res: ProductSkill[] }

  [CH.providersList]: { req: void; res: ProviderConfig[] }
  [CH.providersSave]: { req: unknown; res: ProviderConfig }
  [CH.providersRemove]: { req: { id: string }; res: { ok: true } }
  [CH.providersTest]: { req: unknown; res: ProviderStatus }
  [CH.providersModels]: { req: { id: string }; res: ModelInfo[] }
  [CH.providersStatus]: { req: { id?: string } | undefined; res: ProviderStatus[] }

  [CH.ollamaStatus]: { req: void; res: OllamaStatus }
  [CH.ollamaCatalog]: { req: void; res: OllamaCatalogEntry[] }
  [CH.ollamaHardware]: { req: void; res: { hardware: HardwareInfo; recommendations: OllamaRecommendation[] } }
  [CH.ollamaPull]: { req: { model: string }; res: OllamaPullResult }
  [CH.ollamaPreload]: { req: { model: string }; res: OllamaPreloadResult }
  [CH.ollamaCancel]: { req: { model: string }; res: { ok: boolean } }
  [CH.ollamaRemove]: { req: { model: string }; res: OllamaPullResult }

  [CH.chatSend]: { req: unknown; res: { requestId: string } }
  [CH.chatCancel]: { req: { requestId: string }; res: { ok: true } }
  [CH.chatApproval]: { req: { requestId: string; approvalId: string; approved: boolean; remember?: boolean }; res: { ok: true } }

  [CH.conversationsList]: { req: void; res: Conversation[] }
  [CH.conversationsSearch]: { req: { query: string }; res: Conversation[] }
  [CH.conversationsArchived]: { req: void; res: Conversation[] }
  [CH.conversationsGet]: { req: { id: string }; res: { conversation: Conversation; messages: ChatMessage[] } }
  [CH.conversationsCreate]: { req: unknown; res: Conversation }
  [CH.conversationsUpdate]: { req: unknown; res: Conversation }
  [CH.conversationsDelete]: { req: { id: string }; res: { ok: true } }
  [CH.conversationsArchive]: { req: { id: string }; res: { ok: true } }
  [CH.conversationsUnarchive]: { req: { id: string }; res: { ok: true } }
  [CH.conversationsAppend]: { req: unknown; res: ChatMessage }
  [CH.conversationsClear]: { req: { id: string }; res: { ok: true } }

  [CH.projectPick]: { req: void; res: { path: string | null } }
  [CH.projectOpen]: { req: { path: string }; res: ProjectInfo }
  [CH.projectList]: { req: void; res: Project[] }
  [CH.projectRemove]: { req: { id: string }; res: { ok: true } }
  [CH.projectRename]: { req: { id: string; name: string }; res: Project }
  [CH.projectInfo]: { req: { id: string }; res: ProjectInfo }
  [CH.projectTree]: { req: unknown; res: FileNode[] }
  [CH.projectRead]: { req: unknown; res: FileReadResult }
  [CH.projectWrite]: { req: unknown; res: { ok: boolean; hash: string; checkpointId?: string; conflict?: boolean; message?: string } }
  [CH.projectSearch]: { req: unknown; res: FileNode[] }
  [CH.projectSearchContent]: { req: unknown; res: SearchResult[] }

  [CH.editPropose]: { req: unknown; res: EditProposalResult }
  [CH.editApply]: { req: { proposalId: string }; res: { ok: boolean; path: string; checkpointId?: string; message?: string } }
  [CH.editCheckpoints]: { req: { projectId: string }; res: CheckpointInfo[] }
  [CH.editRestore]: { req: { checkpointId: string }; res: { ok: boolean; message?: string } }

  [CH.terminalRun]: { req: unknown; res: TerminalRunResult }
  [CH.terminalCancel]: { req: { runId: string }; res: { ok: true } }

  [CH.browserNavigate]: { req: { url: string }; res: BrowserPreviewState }
  [CH.browserBack]: { req: void; res: void }
  [CH.browserForward]: { req: void; res: void }
  [CH.browserReload]: { req: void; res: void }
  [CH.browserOpenExternal]: { req: void; res: { ok: boolean; message?: string } }
  [CH.browserLayout]: { req: { visible: boolean; bounds: { x: number; y: number; width: number; height: number } }; res: { ok: true } }
  [CH.browserState]: { req: void; res: BrowserPreviewState }

  [CH.gitStatus]: { req: { projectId: string }; res: GitStatus }
  [CH.gitDiff]: { req: unknown; res: { patch: string } }
  [CH.gitStage]: { req: { projectId: string; files: string[] }; res: { ok: true } }
  [CH.gitUnstage]: { req: { projectId: string; files: string[] }; res: { ok: true } }
  [CH.gitCommit]: { req: unknown; res: { ok: boolean; commit?: string; pushed?: boolean; message?: string } }
  [CH.gitPush]: { req: { projectId: string }; res: { ok: boolean; message?: string } }
  [CH.gitPull]: { req: { projectId: string }; res: { ok: boolean; message?: string; conflict?: boolean } }
  [CH.gitLog]: { req: { projectId: string; limit?: number }; res: { entries: { hash: string; subject: string; author: string; date: string }[] } }
  [CH.gitBranches]: { req: { projectId: string }; res: { local: string[]; remote: string[]; current?: string } }
  [CH.gitCreateBranch]: { req: unknown; res: { ok: boolean; message?: string } }
  [CH.gitCheckout]: { req: unknown; res: { ok: boolean; message?: string } }
  [CH.gitInit]: { req: { projectId: string }; res: { ok: boolean; message?: string } }
  [CH.gitRemotes]: { req: { projectId: string }; res: { name: string; url: string }[] }
  [CH.gitSetRemote]: { req: unknown; res: { ok: boolean; message?: string } }

  [CH.githubStatus]: { req: void; res: { connected: boolean; login?: string; method?: string; scopes?: string[]; message?: string; oauthConfigured?: boolean } }
  [CH.githubConnect]: { req: unknown; res: { ok: boolean; login?: string; message?: string; verificationUri?: string; userCode?: string; deviceCode?: string; interval?: number; expiresIn?: number } }
  [CH.githubDisconnect]: { req: void; res: { ok: true } }
  [CH.githubDeviceStart]: { req: void; res: GithubDeviceStartResult }
  [CH.githubDevicePoll]: { req: void; res: GithubDevicePollResult }
  [CH.githubDeviceCancel]: { req: void; res: { ok: true } }
  [CH.githubDeviceOpen]: { req: void; res: { ok: boolean; message?: string } }
  [CH.githubRepos]: { req: { query?: string } | undefined; res: { fullName: string; name: string; private: boolean; cloneUrl: string; defaultBranch: string; updatedAt: string }[] }
  [CH.githubCreateRepo]: { req: unknown; res: { ok: boolean; fullName?: string; cloneUrl?: string; message?: string } }

  [CH.attachmentsAnalyze]: { req: { path: string; kind?: string }; res: AttachmentRef }
  [CH.attachmentsPick]: { req: void; res: { paths: string[]; attachments: AttachmentRef[] } }

  [CH.voiceTranscribe]: { req: unknown; res: { text: string; error?: string; provider?: string } }

  [CH.platformStatus]: { req: void; res: PlatformStatus }
  [CH.platformSignIn]: { req: { email: string }; res: { ok: boolean; message?: string } }
  [CH.platformSignInWith]: {
    req: { provider: 'google' | 'github' }
    res: { ok: boolean; message?: string }
  }
  [CH.platformSignOut]: { req: void; res: { ok: true } }
  [CH.platformRefresh]: { req: void; res: PlatformStatus }
}

export type ChannelName = keyof IpcContract
