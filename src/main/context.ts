import path from 'node:path'
import { app, safeStorage } from 'electron'
import type { AppSettings } from '@shared/types'
import { AttachmentService } from './services/attachments'
import { ChatService } from './services/chat'
import { CheckpointService } from './services/checkpoints'
import { Db } from './services/db'
import { EditService } from './services/editService'
import { GitService } from './services/git'
import { GithubService } from './services/github'
import { GitHubOAuthService } from './services/githubOAuth'
import { getLogger, initLogger, type Logger } from './services/logger'
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
import { UpdateService } from './services/updater'

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
  skills: SkillsService
  permissions: PermissionService
  broker: ApprovalBroker
  attachments: AttachmentService
  chat: ChatService
  updates: UpdateService
  platform: PlatformService
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
    logsDir: path.join(userData, 'logs')
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
  const skillsDirectory = app.isPackaged
    ? path.join(process.resourcesPath, 'product-skills')
    : path.join(app.getAppPath(), 'product-skills')
  const skills = new SkillsService(skillsDirectory, settings)
  const broker = new ApprovalBroker()
  const attachments = new AttachmentService()

  registry.ensureLocalOllama(current.ollamaUrl)

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
    skills,
    permissions,
    broker,
    attachments,
    chat,
    updates,
    platform,
    emit
  }
}

export function applyLogLevel(ctx: AppContext, settings: AppSettings): void {
  ctx.logger.setLevel(settings.privacy.logLevel)
}
