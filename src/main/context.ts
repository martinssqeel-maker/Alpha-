import path from 'node:path'
import { app, safeStorage } from 'electron'
import type { AppSettings } from '@shared/types'
import { AttachmentService } from './services/attachments'
import { AuthorizedRoots } from './services/authorizedRoots'
import { BrowserPreviewService } from './services/browserPreview'
import { ChatService } from './services/chat'
import { ComputerUseService } from './services/computerUseService'
import { DesktopService } from './services/desktopService'
import { CheckpointService } from './services/checkpoints'
import { Db } from './services/db'
import { EditService } from './services/editService'
import { GitService } from './services/git'
import { GithubService } from './services/github'
import { GitHubOAuthService } from './services/githubOAuth'
import { getLogger, initLogger, type Logger } from './services/logger'
import { OllamaManager } from './services/ollamaManager'
import { ApprovalBroker, PermissionService } from './services/permissionService'
import { PlatformService } from './services/platform'
import { ProjectService } from './services/projectService'
import { ProviderRegistry } from './services/providers/registry'
import { ObfuscationCipher, SecretStore, type Cipher } from './services/secrets'
import {
  ConversationsRepo,
  ProjectsRepo,
  ProvidersRepo,
  SettingsRepo
} from './services/store'
import { TerminalService } from './services/terminal'
import { SkillsService } from './services/skills'
import { DvrService } from './services/dvrService'
import { MacroService } from './services/macroService'
import { MemoryGraph } from './services/memoryGraph'
import { VoiceService } from './services/voiceService'
import { WatcherService } from './services/watcherService'
import { UpdateService } from './services/updater'
import { EVENTS } from '@shared/channels'

class SafeStorageCipher implements Cipher {
  available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }
  encrypt(plain: string): string {
    return 'ss:' + safeStorage.encryptString(plain).toString('base64')
  }
  decrypt(payload: string): string {
    if (payload.startsWith('ss:')) {
      return safeStorage.decryptString(Buffer.from(payload.slice(3), 'base64'))
    }
    return payload
  }
}

export interface AppPaths {
  userData: string
  dbPath: string
  secretsPath: string
  checkpointsDir: string
  logsDir: string
  /** Screenshots captured by the desktop agent (window and browser). */
  screenshotsDir: string
  /** User-authored skills, including ones saved from a completed workflow. */
  skillsDir: string
  /** Replayable `.alpha` macros saved from a successful tool run. */
  macrosDir: string
  /** Declarative background watchers (JSON). */
  watchersFile: string
}

export interface AppContext {
  paths: AppPaths
  logger: Logger
  db: Db
  settings: SettingsRepo
  conversations: ConversationsRepo
  projectsRepo: ProjectsRepo
  providersRepo: ProvidersRepo
  secrets: SecretStore
  registry: ProviderRegistry
  checkpoints: CheckpointService
  projectService: ProjectService
  editService: EditService
  git: GitService
  github: GithubService
  terminal: TerminalService
  ollama: OllamaManager
  skills: SkillsService
  permissions: PermissionService
  broker: ApprovalBroker
  attachments: AttachmentService
  browserPreview: BrowserPreviewService
  roots: AuthorizedRoots
  desktop: DesktopService
  computer: ComputerUseService
  chat: ChatService
  updates: UpdateService
  platform: PlatformService
  /** Semantic memory over past solutions and preferences (local only). */
  memory: MemoryGraph
  /** Saved natural-language macros. */
  macros: MacroService
  /** Bounded in-memory replay buffer for the current session. */
  dvr: DvrService
  /** Background/scheduled triggers that start agent runs. */
  watchers: WatcherService
  /** Local whisper.cpp transcription backend. */
  voice: VoiceService
  emit: (channel: string, data: unknown) => void
}

export async function buildContext(
  userData: string,
  emit: (channel: string, data: unknown) => void
): Promise<AppContext> {
  const paths: AppPaths = {
    userData,
    dbPath: path.join(userData, 'alpha.db'),
    secretsPath: path.join(userData, 'secrets.enc'),
    checkpointsDir: path.join(userData, 'checkpoints'),
    logsDir: path.join(userData, 'logs'),
    screenshotsDir: path.join(userData, 'screenshots'),
    skillsDir: path.join(userData, 'skills'),
    macrosDir: path.join(userData, 'macros'),
    watchersFile: path.join(userData, 'watchers.json')
  }
  const logger = initLogger(paths.logsDir)
  const db = await Db.open(paths.dbPath)
  logger.info('app', `database opened at ${paths.dbPath}`)

  const settings = new SettingsRepo(db)
  const current = settings.get()
  logger.setLevel(current.privacy.logLevel)

  const conversations = new ConversationsRepo(db)
  const projectsRepo = new ProjectsRepo(db)
  const providersRepo = new ProvidersRepo(db)

  const cipher: Cipher = new SafeStorageCipher().available() ? new SafeStorageCipher() : new ObfuscationCipher()
  const secrets = new SecretStore(paths.secretsPath, cipher)
  const registry = new ProviderRegistry(providersRepo, secrets)

  // GitHub Device Flow auth. The Client ID comes from GITHUB_OAUTH_CLIENT_ID or a
  // github-oauth.json file (repo root in dev; userData — %APPDATA%/<app> — for a
  // packaged install). No client secret is ever bundled; the service shares the
  // existing `github:token` secret ref with the PAT/CLI path.
  const githubOAuthConfigPath = path.join(paths.userData, 'github-oauth.json')
  const githubOAuth = new GitHubOAuthService({ secrets, configPaths: [githubOAuthConfigPath] })

  const projectService = new ProjectService(projectsRepo)
  const checkpoints = new CheckpointService(db, paths.checkpointsDir)
  const editService = new EditService(projectService, checkpoints)
  const git = new GitService(projectService)
  const github = new GithubService(secrets, githubOAuth)
  const permissions = new PermissionService(settings)
  const terminal = new TerminalService(projectService, permissions)

  /**
   * Authorized folders for the desktop agent.
   *
   * Standard user paths come from Electron so they honour a redirected profile
   * (OneDrive Documents is common), and the current project is resolved lazily
   * because the user can open one at any time.
   */
  const roots = new AuthorizedRoots({
    standardPaths: {
      documents: safeUserPath('documents'),
      desktop: safeUserPath('desktop'),
      downloads: safeUserPath('downloads')
    },
    settings,
    projectRoot: () => {
      const id = settings.get().workspace?.activeProjectId
      if (!id) return null
      try {
        return projectService.resolveRoot(id)
      } catch {
        return null
      }
    }
  })
  const desktop = new DesktopService(roots)
  const computer = new ComputerUseService(desktop, {
    allowMouseFallback: () => settings.get().agent?.allowMouseFallback !== false,
    screenshotsDir: () => paths.screenshotsDir
  })
  const browserPreview = new BrowserPreviewService((state) => emit(EVENTS.browser, state))
  const skillsDirectory = app.isPackaged
    ? path.join(process.resourcesPath, 'product-skills')
    : path.join(app.getAppPath(), 'product-skills')
  const skills = new SkillsService(skillsDirectory, settings, paths.skillsDir)
  const broker = new ApprovalBroker()
  const attachments = new AttachmentService()

  registry.ensureLocalOllama(current.ollamaUrl)

  // --- Autonomous agent services -------------------------------------------
  // Memory embeds through the configured local Ollama host when one is present,
  // and falls back to the deterministic hashed embedding when it is not, so
  // recall never depends on a model being pulled and no text leaves the machine.
  const embeddingModel = process.env.ALPHA_EMBEDDING_MODEL ?? 'nomic-embed-text'
  const memory = new MemoryGraph({
    db,
    embedder: {
      embed: async (texts: string[]) => {
        const local = registry.list().find((p) => p.kind === 'ollama' && p.enabled)
        if (!local) throw new Error('no local embedding provider')
        const base = local.baseUrl.replace(/\/$/, '')
        const vectors: number[][] = []
        for (const text of texts) {
          const response = await fetch(`${base}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: embeddingModel, prompt: text }),
            signal: AbortSignal.timeout(8_000)
          })
          if (!response.ok) throw new Error(`embedding HTTP ${response.status}`)
          const data = (await response.json()) as { embedding?: number[] }
          if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
            throw new Error('empty embedding')
          }
          vectors.push(data.embedding)
        }
        return vectors
      }
    }
  })
  try {
    memory.prune()
  } catch (error) {
    logger.warn('memory', `prune failed: ${(error as Error).message}`)
  }

  const dvr = new DvrService()

  const chat = new ChatService({
    providers: registry,
    conversations,
    projects: projectService,
    edits: editService,
    git,
    terminal,
    permissions,
    broker,
    settings,
    skills,
    roots,
    desktop,
    computer,
    browser: browserPreview,
    // Recall is wired here rather than inside ChatService so the service keeps
    // depending on an interface, not on the memory implementation.
    memory,
    // The replay buffer records finished activities for the DVR scrubber.
    dvr,
    emit: (event) => emit('evt:chat', event)
  })

  const updates = new UpdateService(logger, (status) => emit('evt:update', status))

  const syncGatewayProvider = () => {
    registry.syncGateway({
      apiBaseUrl: platform.apiBaseUrl(),
      enabled: platform.isActive()
    })
  }

  const platform = new PlatformService({
    settings,
    secrets,
    logger,
    onStatus: (status) => emit('evt:platform', status),
    onActiveChange: () => {
      try {
        syncGatewayProvider()
        emit('evt:provider-status', { changed: true })
      } catch (e) {
        logger.warn('platform', `sync gateway provider failed: ${String(e)}`)
      }
    }
  })

  registry.attachGateway({
    getToken: () => platform.getAccessToken(),
    apiBaseUrl: () => platform.apiBaseUrl()
  })

  // Local model management. The base URL is the saved Ollama provider when there
  // is one, so a custom host set in Settings → Models is honoured, and the
  // configured default otherwise.
  const ollama = new OllamaManager({
    registry,
    baseUrl: () =>
      registry.list().find((p) => p.kind === 'ollama')?.baseUrl ?? settings.get().ollamaUrl,
    emit: (progress) => emit('evt:ollama', progress)
  })

  const macros = new MacroService({ dir: paths.macrosDir })

  // Local voice: paths come from the environment rather than a cloud setting, so
  // the offline path can never be silently swapped for a remote provider.
  const voice = new VoiceService({
    config: () => ({
      binaryPath: process.env.ALPHA_WHISPER_BIN ?? null,
      modelPath: process.env.ALPHA_WHISPER_MODEL ?? null,
      ffmpegPath: process.env.ALPHA_FFMPEG ?? null,
      language: settings.get().voice?.language
    })
  })

  // Watchers reuse the normal chat path, so a scheduled run is subject to the
  // same permissions as a typed one. A watcher without a target conversation,
  // provider and model is skipped rather than guessing: starting a run against
  // the wrong model is worse than not starting.
  const watchers = new WatcherService({
    file: paths.watchersFile,
    log: (message) => logger.warn('watchers', message),
    run: async (watcher) => {
      if (!watcher.conversationId || !watcher.providerId || !watcher.modelId) {
        logger.warn(
          'watchers',
          `watcher ${watcher.id} skipped: needs conversationId, providerId and modelId`
        )
        return
      }
      chat.send({
        conversationId: watcher.conversationId,
        providerId: watcher.providerId,
        modelId: watcher.modelId,
        mode: 'agent',
        text: watcher.prompt
      })
    }
  })
  watchers.arm()

  return {
    paths,
    logger,
    db,
    settings,
    conversations,
    projectsRepo,
    providersRepo,
    secrets,
    registry,
    checkpoints,
    projectService,
    editService,
    git,
    github,
    terminal,
    ollama,
    skills,
    permissions,
    broker,
    attachments,
    browserPreview,
    roots,
    desktop,
    computer,
    chat,
    updates,
    platform,
    memory,
    macros,
    dvr,
    watchers,
    voice,
    emit
  }
}

export function applyLogLevel(ctx: AppContext, settings: AppSettings): void {
  ctx.logger.setLevel(settings.privacy.logLevel)
}

/**
 * `app.getPath` throws for a folder a hardened or stripped Windows profile has
 * redirected away. A missing Documents folder must not stop the app from
 * booting, so fall back to the user's home and let `AuthorizedRoots` mark it
 * non-existent.
 */
function safeUserPath(name: 'documents' | 'desktop' | 'downloads'): string {
  try {
    return app.getPath(name)
  } catch {
    try {
      return path.join(app.getPath('home'), name === 'documents' ? 'Documents' : name === 'desktop' ? 'Desktop' : 'Downloads')
    } catch {
      return path.join(app.getPath('userData'), name)
    }
  }
}
