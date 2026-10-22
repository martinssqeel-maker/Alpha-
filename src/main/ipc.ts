import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import type { ZodTypeAny } from 'zod'
import type { ChatEvent, TerminalEvent } from '@shared/types'
import {
  zAppTheme,
  zApproval,
  zAttachmentAnalyze,
  zBrowserLayout,
  zBrowserNavigate,
  zChatSend,
  zCheckpointRestore,
  zConversationAppend,
  zConversationCreate,
  zConversationSearch,
  zConversationUpdate,
  zEditApply,
  zEditPropose,
  zGithubConnect,
  zGithubCreateRepo,
  zGitCheckout,
  zGitCommit,
  zGitCreateBranch,
  zGitDiff,
  zGitPull,
  zGitPush,
  zGitSetRemote,
  zId,
  zOllamaModel,
  zOpenExternal,
  zProjectOpen,
  zProjectRename,
  zProjectRead,
  zProjectTree,
  zProjectWrite,
  zPlatformSignIn,
  zPlatformSignInWith,
  zProjectId,
  zProviderSave,
  zProviderTest,
  zRequestId,
  zRunId,
  zSearch,
  zSkillEnable,
  zSkillSave,
  zSettingsSet,
  zTerminalRun,
  zVoiceTranscribe
} from '@shared/schemas'
import type { DiagnosticsInfo } from '@shared/ipc'
import { createThemeTokens, DEFAULT_APPEARANCE_SETTINGS, THEME_TOKENS } from '@shared/theme'
import { CH } from '@shared/channels'
import type { AppContext } from './context'
import type { BrowserPreviewService } from './services/browserPreview'

type Handler = (payload: unknown) => unknown | Promise<unknown>

export function registerIpc(ctx: AppContext, browserPreview: BrowserPreviewService): void {
  const handle = (channel: string, schema: ZodTypeAny | null, fn: Handler): void => {
    ipcMain.handle(channel, async (_event, payload) => {
      let args: unknown = payload
      if (schema) {
        const parsed = schema.safeParse(payload)
        if (!parsed.success) {
          throw new Error('Invalid request: ' + parsed.error.issues.map((i) => i.message).join('; '))
        }
        args = parsed.data
      }
      return fn(args)
    })
  }

  const chatEvent = (event: ChatEvent): void => ctx.emit('evt:chat', event)
  const termEvent = (event: TerminalEvent): void => ctx.emit('evt:terminal', event)

  handle(CH.appInfo, null, async (): Promise<DiagnosticsInfo> => diagnostics(ctx))
  handle(CH.diagnostics, null, async (): Promise<DiagnosticsInfo> => diagnostics(ctx))
  handle(CH.updateCheck, null, () => ctx.updates.check())
  handle(CH.updateDownload, null, () => ctx.updates.download())
  handle(CH.updateInstall, null, () => ctx.updates.install())
  handle(CH.updateStatus, null, () => ctx.updates.getStatus())

  handle(CH.platformStatus, null, () => ctx.platform.status())
  handle(CH.platformSignIn, zPlatformSignIn, (p) => ctx.platform.signIn((p as { email: string }).email))

  // Provider sign-in opens the system browser on the Function and comes back via
  // the alpha:// deep link. The app never receives a provider token or secret —
  // GitHub's docs require the client secret at the token step, so the Function
  // owns the exchange. This is account sign-in only: it is NOT the GitHub
  // repository connection, which stays a separate action on the GitHub page.
  handle(CH.platformSignInWith, zPlatformSignInWith, async (p) => {
    const provider = (p as { provider: 'google' | 'github' }).provider
    const url = ctx.platform.providerSignInUrl(provider)
    if (!url) {
      return {
        ok: false,
        message: 'Alpha Cloud is not configured. Set the API base URL in Settings → Platform.'
      }
    }
    const available = await ctx.platform.providerAvailable(provider)
    if (!available) {
      const label = provider === 'google' ? 'Google' : 'GitHub'
      return { ok: false, message: `Signing in with ${label} is not enabled on this deployment yet.` }
    }
    await shell.openExternal(url)
    return { ok: true, message: 'Finish signing in in your browser — Alpha completes it automatically.' }
  })

  handle(CH.platformSignOut, null, () => ctx.platform.signOut())
  handle(CH.platformRefresh, null, () => ctx.platform.refresh())

  handle(CH.appTheme, zAppTheme, (p) => {
    const { theme, mode } = p as { theme: keyof typeof THEME_TOKENS; mode: 'system' | 'dark' | 'light' }
    nativeTheme.themeSource = mode
    const tokens = createThemeTokens(theme, { ...DEFAULT_APPEARANCE_SETTINGS, mode }, nativeTheme.shouldUseDarkColors)
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.setTitleBarOverlay?.({
          color: tokens['--surface-1'],
          symbolColor: tokens['--text-secondary'],
          height: 40
        })
        win.setBackgroundColor(tokens['--surface-0'])
      } catch {
        /* not supported */
      }
    }
    return { ok: true }
  })

  handle(CH.settingsGet, null, () => ctx.settings.get())
  handle(CH.settingsSet, zSettingsSet, (p) => {
    const patch = (p as { patch: Record<string, unknown> }).patch
    const next = ctx.settings.set(patch)
    if (typeof next.privacy?.logLevel === 'string') ctx.logger.setLevel(next.privacy.logLevel)
    return next
  })

  handle(CH.secretsSet, null, (p) => {
    const { ref, value } = p as { ref: string; value: string }
    if (!ref || typeof value !== 'string') throw new Error('ref and value are required')
    ctx.secrets.set(ref, value)
    return { ok: true }
  })
  handle(CH.secretsDelete, null, (p) => {
    ctx.secrets.delete((p as { ref: string }).ref)
    return { ok: true }
  })
  handle(CH.secretsHas, null, (p) => ({ has: ctx.secrets.has((p as { ref: string }).ref) }))

  handle(CH.skillsList, null, () => ctx.skills.list())
  handle(CH.skillsSetEnabled, zSkillEnable, (p) => {
    const { id, enabled } = p as { id: string; enabled: boolean }
    return ctx.skills.setEnabled(id, enabled)
  })
  handle(CH.skillsSave, zSkillSave, (p) =>
    ctx.skills.save(
      p as { id: string; name: string; description?: string; category?: string; instructions: string }
    )
  )
  handle(CH.agentLocations, null, () => ctx.roots.list())
  handle(CH.agentPickLocation, null, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Add a folder the agent may use',
      properties: ['openDirectory', 'createDirectory']
    })
    const picked = result.canceled ? null : (result.filePaths[0] ?? null)
    if (!picked) return { path: null }
    const current = ctx.settings.get()
    const extraPaths = [...(current.agent?.extraPaths ?? []), picked]
    // Deduplicate case-insensitively: Windows treats C:\Docs and c:\docs alike.
    const seen = new Set<string>()
    const deduped = extraPaths.filter((value) => {
      const key = value.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    ctx.settings.set({ agent: { extraPaths: deduped } })
    return { path: picked }
  })

  handle(CH.providersList, null, () => ctx.registry.list())
  handle(CH.providersSave, zProviderSave, (p) => ctx.registry.save(p as never))
  handle(CH.providersRemove, zId, (p) => {
    ctx.registry.remove((p as { id: string }).id)
    return { ok: true }
  })
  handle(CH.providersTest, zProviderTest, (p) => ctx.registry.test(p as never))
  handle(CH.providersModels, zId, (p) => ctx.registry.modelsFor((p as { id: string }).id))
  handle(CH.providersStatus, null, (p) => {
    const id = (p as { id?: string } | undefined)?.id
    if (id) {
      const provider = ctx.registry.get(id)
      if (!provider) return []
      return ctx.registry.test({ id, kind: provider.kind, baseUrl: provider.baseUrl })
        .then((s) => [s])
    }
    return ctx.registry.statuses()
  })

  // Local models. Detection, catalog metadata and every download/removal go to
  // the running Ollama service; progress events are streamed back on `evt:ollama`.
  handle(CH.ollamaStatus, null, () => ctx.ollama.status())
  handle(CH.ollamaCatalog, null, () => ctx.ollama.catalog())
  handle(CH.ollamaHardware, null, async () => ({
    hardware: await ctx.ollama.hardware(),
    recommendations: await ctx.ollama.recommendations()
  }))
  handle(CH.ollamaPull, zOllamaModel, async (p) => {
    const model = (p as { model: string }).model
    const result = await ctx.ollama.pull(model)
    // A finished pull changes the installed list, so refresh what the UI shows.
    ctx.emit('evt:provider-status', { changed: true })
    return result
  })
  // Warming a model is best-effort: the request that follows still works if this
  // fails, it just pays the load itself.
  handle(CH.ollamaPreload, zOllamaModel, (p) => ctx.ollama.preload((p as { model: string }).model))
  handle(CH.ollamaCancel, zOllamaModel, (p) => ({
    ok: ctx.ollama.cancelPull((p as { model: string }).model)
  }))
  handle(CH.ollamaRemove, zOllamaModel, async (p) => {
    const result = await ctx.ollama.remove((p as { model: string }).model)
    if (result.ok) ctx.emit('evt:provider-status', { changed: true })
    return result
  })

  handle(CH.chatSend, zChatSend, (p) => ctx.chat.send(p as never))
  handle(CH.chatCancel, zRequestId, (p) => ({ ok: ctx.chat.cancel((p as { requestId: string }).requestId) }))
  handle(CH.chatApproval, zApproval, (p) => {
    const a = p as { approvalId: string; approved: boolean }
    ctx.broker.resolve(a.approvalId, a.approved)
    return { ok: true }
  })

  handle(CH.conversationsList, null, () => ctx.conversations.list())
  handle(CH.conversationsSearch, zConversationSearch, (p) => ctx.conversations.search((p as { query: string }).query))
  handle(CH.conversationsArchived, null, () => ctx.conversations.listArchived())
  handle(CH.conversationsGet, zId, (p) => {
    const id = (p as { id: string }).id
    const conversation = ctx.conversations.get(id)
    if (!conversation) throw new Error('Conversation not found')
    return { conversation, messages: ctx.conversations.messages(id) }
  })
  handle(CH.conversationsCreate, zConversationCreate, (p) => ctx.conversations.create(p as never))
  handle(CH.conversationsUpdate, zConversationUpdate, (p) => {
    const { id, ...patch } = p as { id: string }
    const updated = ctx.conversations.update(id, patch as never)
    if (!updated) throw new Error('Conversation not found')
    return updated
  })
  handle(CH.conversationsDelete, zId, (p) => {
    ctx.conversations.delete((p as { id: string }).id)
    return { ok: true }
  })
  handle(CH.conversationsArchive, zId, (p) => {
    ctx.conversations.archive((p as { id: string }).id)
    return { ok: true }
  })
  handle(CH.conversationsUnarchive, zId, (p) => {
    ctx.conversations.unarchive((p as { id: string }).id)
    return { ok: true }
  })
  handle(CH.conversationsAppend, zConversationAppend, (p) => ctx.conversations.append(p as never))
  handle(CH.conversationsClear, zId, (p) => {
    ctx.conversations.clearMessages((p as { id: string }).id)
    return { ok: true }
  })

  handle(CH.projectPick, null, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Open project folder' })
      : await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Open project folder' })
    if (result.canceled || !result.filePaths.length) return { path: null }
    return { path: result.filePaths[0] }
  })

  handle(CH.projectOpen, zProjectOpen, async (p) => {
    const { project } = ctx.projectService.openProject((p as { path: string }).path)
    const gitStatus = await ctx.git.status(project.id)
    const files = ctx.projectService.listTree(project.id, '', 1)
    return { project, git: gitStatus, files }
  })

  handle(CH.projectList, null, () => ctx.projectsRepo.list())
  handle(CH.projectRemove, zId, (p) => {
    const id = (p as { id: string }).id
    ctx.conversations.detachProject(id)
    ctx.projectsRepo.remove(id)
    return { ok: true }
  })
  handle(CH.projectRename, zProjectRename, (p) => {
    const { id, name } = p as { id: string; name: string }
    const project = ctx.projectsRepo.rename(id, name)
    if (!project) throw new Error('Project not found or label is empty')
    return project
  })
  handle(CH.projectInfo, zId, async (p) => {
    const id = (p as { id: string }).id
    ctx.projectsRepo.touch(id)
    const project = ctx.projectService.resolveProject(id)
    const gitStatus = await ctx.git.status(id)
    const files = ctx.projectService.listTree(id, '', 1)
    return { project, git: gitStatus, files }
  })
  handle(CH.projectTree, zProjectTree, (p) => {
    const { projectId, path, depth } = p as { projectId: string; path?: string; depth?: number }
    return ctx.projectService.listTree(projectId, path ?? '', depth ?? 2)
  })
  handle(CH.projectRead, zProjectRead, (p) => {
    const { projectId, path, maxBytes } = p as { projectId: string; path: string; maxBytes?: number }
    const allowSensitive = ctx.permissions.resolve('sensitiveFiles') === 'allow'
    return ctx.projectService.readFile(projectId, path, { maxBytes, allowSensitive })
  })
  handle(CH.projectWrite, zProjectWrite, (p) => {
    const { projectId, path, content, expectedHash } = p as {
      projectId: string
      path: string
      content: string
      expectedHash?: string
    }
    const decision = ctx.permissions.resolve('fileWrites')
    if (decision === 'deny') throw new Error('File writes are disabled by the current permission settings.')
    let checkpointId: string | undefined
    const res = ctx.projectService.writeFile(projectId, path, content, {
      expectedHash,
      createCheckpoint: true,
      onCheckpoint: (abs) => {
        const cp = ctx.checkpoints.create(projectId, abs)
        if (cp) checkpointId = cp.id
      }
    })
    return { ...res, checkpointId }
  })
  handle(CH.projectSearch, zSearch, (p) => {
    const { projectId, query, maxResults } = p as { projectId: string; query: string; maxResults?: number }
    return ctx.projectService.searchNames(projectId, query, maxResults ?? 200)
  })
  handle(CH.projectSearchContent, zSearch, (p) => {
    const { projectId, query, maxResults } = p as { projectId: string; query: string; maxResults?: number }
    return ctx.projectService.searchContent(projectId, query, maxResults ?? 200)
  })

  handle(CH.editPropose, zEditPropose, (p) => ctx.editService.propose(p as never))
  handle(CH.editApply, zEditApply, (p) => {
    const decision = ctx.permissions.resolve('fileWrites')
    if (decision === 'deny') throw new Error('File writes are disabled by the current permission settings.')
    return ctx.editService.apply((p as { proposalId: string }).proposalId)
  })
  handle(CH.editCheckpoints, zProjectId, (p) =>
    ctx.checkpoints.list((p as { projectId: string }).projectId)
  )
  handle(CH.editRestore, zCheckpointRestore, (p) => ctx.checkpoints.restore((p as { checkpointId: string }).checkpointId))

  handle(CH.terminalRun, zTerminalRun, (p) => ctx.terminal.run(p as never, termEvent))
  handle(CH.terminalCancel, zRunId, (p) => ({ ok: ctx.terminal.cancel((p as { runId: string }).runId) }))

  handle(CH.browserNavigate, zBrowserNavigate, (p) => browserPreview.navigate((p as { url: string }).url))
  handle(CH.browserBack, null, () => browserPreview.back())
  handle(CH.browserForward, null, () => browserPreview.forward())
  handle(CH.browserReload, null, () => browserPreview.reload())
  handle(CH.browserOpenExternal, null, () => browserPreview.openExternally())
  handle(CH.browserLayout, zBrowserLayout, (p) => {
    const { visible, bounds } = p as { visible: boolean; bounds: { x: number; y: number; width: number; height: number } }
    browserPreview.setLayout(visible, bounds)
    return { ok: true }
  })
  handle(CH.browserState, null, () => browserPreview.getState())

  handle(CH.gitStatus, zProjectId, (p) => ctx.git.status((p as { projectId: string }).projectId))
  handle(CH.gitDiff, zGitDiff, (p) => {
    const { projectId, path, staged } = p as { projectId: string; path?: string; staged?: boolean }
    return ctx.git.diff(projectId, path, staged).then((patch) => ({ patch }))
  })
  handle(CH.gitStage, null, (p) => {
    const { projectId, files } = p as { projectId: string; files: string[] }
    return ctx.git.stage(projectId, files)
  })
  handle(CH.gitUnstage, null, (p) => {
    const { projectId, files } = p as { projectId: string; files: string[] }
    return ctx.git.unstage(projectId, files)
  })
  handle(CH.gitCommit, zGitCommit, async (p) => {
    const input = p as { projectId: string; message: string; files?: string[]; push?: boolean }
    if (ctx.permissions.get().mode === 'chat') throw new Error('Commits are disabled in chat mode.')
    if (ctx.permissions.resolve('gitCommit') === 'deny') throw new Error('Git commits are disabled by permission settings.')
    const res = await ctx.git.commit(input.projectId, input.message, input.files)
    if (!res.ok) return res
    let pushed = false
    if (input.push) {
      if (ctx.permissions.resolve('githubPush') === 'deny') {
        return { ...res, pushed: false, message: 'Committed, but pushing is disabled by permission settings.' }
      }
      const pushRes = await ctx.git.push(input.projectId)
      pushed = pushRes.ok
      return { ...res, pushed, message: pushRes.message }
    }
    return { ...res, pushed }
  })
  handle(CH.gitPush, zGitPush, async (p) => {
    if (ctx.permissions.get().mode === 'chat') throw new Error('Push is disabled in chat mode.')
    if (ctx.permissions.resolve('githubPush') === 'deny') throw new Error('Push is disabled by permission settings.')
    return ctx.git.push((p as { projectId: string }).projectId)
  })
  handle(CH.gitPull, zGitPull, (p) => ctx.git.pull((p as { projectId: string }).projectId))
  handle(CH.gitLog, null, (p) => {
    const { projectId, limit } = p as { projectId: string; limit?: number }
    return ctx.git.log(projectId, limit).then((entries) => ({ entries }))
  })
  handle(CH.gitBranches, zProjectId, (p) =>
    ctx.git.branches((p as { projectId: string }).projectId)
  )
  handle(CH.gitCreateBranch, zGitCreateBranch, (p) => {
    const { projectId, name, checkout } = p as { projectId: string; name: string; checkout?: boolean }
    return ctx.git.createBranch(projectId, name, checkout ?? true)
  })
  handle(CH.gitCheckout, zGitCheckout, (p) => {
    const { projectId, name } = p as { projectId: string; name: string }
    return ctx.git.checkout(projectId, name)
  })
  handle(CH.gitInit, zProjectId, (p) => ctx.git.init((p as { projectId: string }).projectId))
  handle(CH.gitRemotes, zProjectId, (p) =>
    ctx.git.remotes((p as { projectId: string }).projectId)
  )
  handle(CH.gitSetRemote, zGitSetRemote, (p) => {
    const { projectId, name, url } = p as { projectId: string; name: string; url: string }
    return ctx.git.setRemote(projectId, name, url)
  })

  handle(CH.githubStatus, null, async () => ({
    ...(await ctx.github.status()),
    oauthConfigured: ctx.github.isOauthConfigured()
  }))
  handle(CH.githubConnect, zGithubConnect, (p) => ctx.github.connect(p as never))
  handle(CH.githubDisconnect, null, () => {
    ctx.github.disconnect()
    return { ok: true }
  })
  // GitHub Device Flow. Start opens GitHub's official device page in the user's
  // default browser; the renderer then polls at GitHub's interval. No client
  // secret is involved and no browser callback is faked.
  handle(CH.githubDeviceStart, null, async () => {
    const result = await ctx.github.startDeviceFlow()
    if (result.ok && result.verificationUri) {
      void shell.openExternal(result.verificationUri)
    }
    return result
  })
  handle(CH.githubDevicePoll, null, () => ctx.github.pollDevice())
  handle(CH.githubDeviceCancel, null, () => {
    ctx.github.cancelDevice()
    return { ok: true }
  })
  handle(CH.githubDeviceOpen, null, () => {
    const uri = ctx.github.deviceVerificationUri()
    if (!uri) return { ok: false, message: 'No sign-in is in progress.' }
    void shell.openExternal(uri)
    return { ok: true }
  })
  handle(CH.githubRepos, null, (p) => ctx.github.repos((p as { query?: string } | undefined)?.query))
  handle(CH.githubCreateRepo, zGithubCreateRepo, (p) => ctx.github.createRepo(p as never))

  handle(CH.attachmentsAnalyze, zAttachmentAnalyze, (p) =>
    ctx.attachments.analyze((p as { path: string }).path)
  )
  handle(CH.attachmentsPick, null, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
      : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return { paths: [], attachments: [] }
    const attachments = []
    for (const filePath of result.filePaths) {
      try {
        attachments.push(await ctx.attachments.analyze(filePath))
      } catch {
        /* skip unreadable files */
      }
    }
    return { paths: result.filePaths, attachments }
  })

  handle(CH.voiceTranscribe, zVoiceTranscribe, async (p) => {
    const input = p as { audioBase64: string; mimeType?: string; providerId?: string; model?: string }
    const settings = ctx.settings.get()
    const providerId = input.providerId ?? settings.voice.transcriptionProviderId
    if (!providerId) {
      return { text: '', error: 'No transcription provider configured. Set one in Settings → Voice.' }
    }
    try {
      const audio = Buffer.from(input.audioBase64, 'base64')
      const text = await ctx.registry.transcribe(
        providerId,
        audio,
        input.mimeType ?? 'audio/webm',
        input.model ?? settings.voice.transcriptionModel,
        settings.voice.language
      )
      return { text, provider: providerId }
    } catch (e) {
      return { text: '', error: (e as Error).message }
    }
  })

  // Open a path in the OS file explorer is a safe, useful helper.
  ipcMain.handle('shell:showItem', (_e, p: { path: string }) => {
    if (p?.path) shell.showItemInFolder(p.path)
    return { ok: true }
  })

  // http(s) only — `zOpenExternal` rejects file:, javascript: and custom schemes,
  // so a link from the UI can never hand the shell something executable.
  handle(CH.openExternal, zOpenExternal, async (p) => {
    const url = (p as { url: string }).url
    try {
      await shell.openExternal(url)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  })
}

async function diagnostics(ctx: AppContext): Promise<DiagnosticsInfo> {
  const git = await ctx.git.checkAvailable()
  const ghAvailable = await ctx.github.ghAvailable()
  let statuses: DiagnosticsInfo['providers'] = []
  try {
    statuses = ctx.registry.cachedStatuses()
  } catch {
    statuses = []
  }
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    sqlite: true,
    git,
    gh: { available: ghAvailable },
    providers: statuses,
    dbPath: ctx.paths.dbPath,
    dataPath: ctx.paths.userData,
    logPath: ctx.paths.logsDir + '/alpha.log'
  }
}
