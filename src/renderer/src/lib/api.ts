import { CH, EVENTS } from '@shared/channels'
import type { ChannelName, IpcContract } from '@shared/ipc'
import type { BrowserPreviewState, ChatEvent, PlatformStatus, TerminalEvent, UpdateEvent } from '@shared/types'
import type { ResolvedTheme } from '@shared/theme'

async function invoke<K extends ChannelName>(
  channel: K,
  payload?: IpcContract[K]['req']
): Promise<IpcContract[K]['res']> {
  return window.alpha.invoke(channel as string, payload) as Promise<IpcContract[K]['res']>
}

export function onChat(cb: (event: ChatEvent) => void): () => void {
  return window.alpha.subscribe(EVENTS.chat, cb as (d: unknown) => void)
}

export function onTerminal(cb: (event: TerminalEvent) => void): () => void {
  return window.alpha.subscribe(EVENTS.terminal, cb as (d: unknown) => void)
}

export function onBrowser(cb: (state: BrowserPreviewState) => void): () => void {
  return window.alpha.subscribe(EVENTS.browser, cb as (d: unknown) => void)
}

export function onUpdate(cb: (event: UpdateEvent) => void): () => void {
  return window.alpha.subscribe(EVENTS.update, cb as (d: unknown) => void)
}

export const api = {
  diagnostics: () => invoke(CH.diagnostics, undefined),
  setTheme: (theme: ResolvedTheme) => invoke(CH.appTheme, { theme }),
  revealPath: (path: string) => invoke(CH.revealPath, { path }),

  updates: {
    check: () => invoke(CH.updateCheck, undefined),
    download: () => invoke(CH.updateDownload, undefined),
    install: () => invoke(CH.updateInstall, undefined),
    status: () => invoke(CH.updateStatus, undefined)
  },

  settings: {
    get: () => invoke(CH.settingsGet, undefined),
    set: (patch: Record<string, unknown>) => invoke(CH.settingsSet, { patch })
  },

  secrets: {
    set: (ref: string, value: string) => invoke(CH.secretsSet, { ref, value }),
    delete: (ref: string) => invoke(CH.secretsDelete, { ref }),
    has: (ref: string) => invoke(CH.secretsHas, { ref })
  },

  skills: {
    list: () => invoke(CH.skillsList, undefined),
    setEnabled: (id: string, enabled: boolean) => invoke(CH.skillsSetEnabled, { id, enabled })
  },

  providers: {
    list: () => invoke(CH.providersList, undefined),
    save: (input: unknown) => invoke(CH.providersSave, input),
    remove: (id: string) => invoke(CH.providersRemove, { id }),
    test: (input: unknown) => invoke(CH.providersTest, input),
    models: (id: string) => invoke(CH.providersModels, { id }),
    status: (id?: string) => invoke(CH.providersStatus, id ? { id } : undefined)
  },

  chat: {
    send: (input: unknown) => invoke(CH.chatSend, input),
    cancel: (requestId: string) => invoke(CH.chatCancel, { requestId }),
    approval: (requestId: string, approvalId: string, approved: boolean) =>
      invoke(CH.chatApproval, { requestId, approvalId, approved })
  },

  conversations: {
    list: () => invoke(CH.conversationsList, undefined),
    search: (query: string) => invoke(CH.conversationsSearch, { query }),
    archived: () => invoke(CH.conversationsArchived, undefined),
    get: (id: string) => invoke(CH.conversationsGet, { id }),
    create: (input: unknown) => invoke(CH.conversationsCreate, input),
    update: (input: unknown) => invoke(CH.conversationsUpdate, input),
    remove: (id: string) => invoke(CH.conversationsDelete, { id }),
    archive: (id: string) => invoke(CH.conversationsArchive, { id }),
    unarchive: (id: string) => invoke(CH.conversationsUnarchive, { id }),
    append: (input: unknown) => invoke(CH.conversationsAppend, input),
    clear: (id: string) => invoke(CH.conversationsClear, { id })
  },

  projects: {
    pick: () => invoke(CH.projectPick, undefined),
    open: (path: string) => invoke(CH.projectOpen, { path }),
    list: () => invoke(CH.projectList, undefined),
    remove: (id: string) => invoke(CH.projectRemove, { id }),
    rename: (id: string, name: string) => invoke(CH.projectRename, { id, name }),
    info: (id: string) => invoke(CH.projectInfo, { id }),
    tree: (projectId: string, path?: string, depth?: number) =>
      invoke(CH.projectTree, { projectId, path, depth }),
    read: (projectId: string, path: string, maxBytes?: number) =>
      invoke(CH.projectRead, { projectId, path, maxBytes }),
    write: (projectId: string, path: string, content: string, expectedHash?: string) =>
      invoke(CH.projectWrite, { projectId, path, content, expectedHash }),
    search: (projectId: string, query: string) => invoke(CH.projectSearch, { projectId, query }),
    searchContent: (projectId: string, query: string) =>
      invoke(CH.projectSearchContent, { projectId, query })
  },

  edits: {
    propose: (input: unknown) => invoke(CH.editPropose, input),
    apply: (proposalId: string) => invoke(CH.editApply, { proposalId }),
    checkpoints: (projectId: string) => invoke(CH.editCheckpoints, { projectId }),
    restore: (checkpointId: string) => invoke(CH.editRestore, { checkpointId })
  },

  terminal: {
    run: (input: unknown) => invoke(CH.terminalRun, input),
    cancel: (runId: string) => invoke(CH.terminalCancel, { runId })
  },

  browser: {
    navigate: (url: string) => invoke(CH.browserNavigate, { url }),
    back: () => invoke(CH.browserBack, undefined),
    forward: () => invoke(CH.browserForward, undefined),
    reload: () => invoke(CH.browserReload, undefined),
    openExternal: () => invoke(CH.browserOpenExternal, undefined),
    setLayout: (visible: boolean, bounds: { x: number; y: number; width: number; height: number }) =>
      invoke(CH.browserLayout, { visible, bounds }),
    getState: () => invoke(CH.browserState, undefined)
  },

  git: {
    status: (projectId: string) => invoke(CH.gitStatus, { projectId }),
    diff: (projectId: string, path?: string, staged?: boolean) =>
      invoke(CH.gitDiff, { projectId, path, staged }),
    stage: (projectId: string, files: string[]) => invoke(CH.gitStage, { projectId, files }),
    unstage: (projectId: string, files: string[]) => invoke(CH.gitUnstage, { projectId, files }),
    commit: (input: unknown) => invoke(CH.gitCommit, input),
    push: (projectId: string) => invoke(CH.gitPush, { projectId }),
    pull: (projectId: string) => invoke(CH.gitPull, { projectId }),
    log: (projectId: string, limit?: number) => invoke(CH.gitLog, { projectId, limit }),
    branches: (projectId: string) => invoke(CH.gitBranches, { projectId }),
    createBranch: (projectId: string, name: string, checkout?: boolean) =>
      invoke(CH.gitCreateBranch, { projectId, name, checkout }),
    checkout: (projectId: string, name: string) => invoke(CH.gitCheckout, { projectId, name }),
    init: (projectId: string) => invoke(CH.gitInit, { projectId }),
    remotes: (projectId: string) => invoke(CH.gitRemotes, { projectId }),
    setRemote: (projectId: string, name: string, url: string) =>
      invoke(CH.gitSetRemote, { projectId, name, url })
  },

  github: {
    status: () => invoke(CH.githubStatus, undefined),
    connect: (input: unknown) => invoke(CH.githubConnect, input),
    disconnect: () => invoke(CH.githubDisconnect, undefined),
    repos: (query?: string) => invoke(CH.githubRepos, query ? { query } : undefined),
    createRepo: (input: unknown) => invoke(CH.githubCreateRepo, input)
  },

  attachments: {
    analyze: (path: string) => invoke(CH.attachmentsAnalyze, { path }),
    pick: () => invoke(CH.attachmentsPick, undefined)
  },

  voice: {
    transcribe: (input: unknown) => invoke(CH.voiceTranscribe, input)
  },

  platform: {
    status: () => invoke(CH.platformStatus, undefined),
    signIn: (email: string) => invoke(CH.platformSignIn, { email }),
    signOut: () => invoke(CH.platformSignOut, undefined),
    refresh: () => invoke(CH.platformRefresh, undefined)
  }
}

export function onPlatform(cb: (status: PlatformStatus) => void): () => void {
  return window.alpha.subscribe(EVENTS.platform, cb as (d: unknown) => void)
}

export type Api = typeof api
