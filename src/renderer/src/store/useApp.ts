import { create } from 'zustand'
import type {
  ActivityItem,
  AppSettings,
  AttachmentRef,
  ChatMessage,
  Conversation,
  FileNode,
  GitStatus,
  InspectorTab,
  ModelInfo,
  PlatformStatus,
  Project,
  ProviderConfig,
  ProviderStatus,
  UpdateEvent,
  UpdateStatus
} from '@shared/types'
import { api, onChat, onPlatform, onTerminal, onUpdate } from '../lib/api'

export type View = 'chat' | 'models' | 'providers' | 'projects' | 'github' | 'settings' | 'help'

export interface Toast {
  id: string
  message: string
  kind: 'info' | 'success' | 'error'
}

export interface TerminalLine {
  id: string
  stream: 'stdout' | 'stderr' | 'meta'
  data: string
}

export interface TerminalSession {
  runId: string
  command: string
  cwd: string
  lines: TerminalLine[]
  exit?: { code: number | null; durationMs: number }
  running: boolean
}

interface Streaming {
  requestId: string
  text: string
  thinking: string
  activities: ActivityItem[]
}

interface PendingApproval {
  requestId: string
  approvalId: string
  title: string
  detail: string
}

interface State {
  ready: boolean
  settings: AppSettings | null
  view: View
  inspectorTab: InspectorTab
  inspectorOpen: boolean
  inspectorWidth: number

  conversations: Conversation[]
  activeConversationId: string | null
  messages: ChatMessage[]
  draft: string

  projects: Project[]
  activeProjectId: string | null
  tree: FileNode[]
  gitStatus: GitStatus | null

  providers: ProviderConfig[]
  statuses: Record<string, ProviderStatus>
  models: ModelInfo[]
  selectedProviderId: string | null
  selectedModelId: string | null
  modelsLoading: boolean

  streaming: Streaming | null
  isSending: boolean
  pendingApprovals: PendingApproval[]

  terminals: TerminalSession[]
  activeRunId: string | null

  toasts: Toast[]
  busy: boolean

  update: UpdateStatus | null

  platform: PlatformStatus
  platformAccess: Record<string, boolean>

  init: () => Promise<void>
  setView: (v: View) => void
  setInspectorTab: (t: InspectorTab) => void
  setInspectorOpen: (open: boolean) => void
  setInspectorWidth: (w: number) => void
  applyTheme: () => void
  saveSettings: (patch: Record<string, unknown>) => Promise<void>

  toast: (message: string, kind?: Toast['kind']) => void
  dismissToast: (id: string) => void
  setDraft: (text: string) => void

  refreshProviders: () => Promise<void>
  refreshModels: () => Promise<void>
  selectModel: (providerId: string, modelId: string) => void

  loadConversations: () => Promise<void>
  openConversation: (id: string) => Promise<void>
  newConversation: (projectId?: string | null) => Promise<string>
  deleteConversation: (id: string) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>

  loadProjects: () => Promise<void>
  openProject: () => Promise<void>
  openProjectByPath: (path: string) => Promise<void>
  selectProject: (id: string) => Promise<void>
  removeProject: (id: string) => Promise<void>
  refreshTree: () => Promise<void>
  refreshGit: () => Promise<void>

  send: (text: string, attachments: AttachmentRef[]) => Promise<void>
  stop: () => Promise<void>
  respondApproval: (approvalId: string, approved: boolean) => Promise<void>

  runCommand: (command: string, approved?: boolean) => Promise<void>
  cancelRun: (runId: string) => Promise<void>

  checkForUpdates: () => Promise<void>
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>

  refreshPlatform: () => Promise<void>
  signInToPlatform: (email: string) => Promise<{ ok: boolean; message?: string }>
  signOutOfPlatform: () => Promise<void>
}

let chatUnsub: (() => void) | null = null
let termUnsub: (() => void) | null = null
let updateUnsub: (() => void) | null = null
let platformUnsub: (() => void) | null = null

export const useApp = create<State>((set, get) => ({
  ready: false,
  settings: null,
  view: 'chat',
  inspectorTab: 'explorer',
  inspectorOpen: true,
  inspectorWidth: 420,

  conversations: [],
  activeConversationId: null,
  messages: [],
  draft: '',

  projects: [],
  activeProjectId: null,
  tree: [],
  gitStatus: null,

  providers: [],
  statuses: {},
  models: [],
  selectedProviderId: null,
  selectedModelId: null,
  modelsLoading: false,

  streaming: null,
  isSending: false,
  pendingApprovals: [],

  terminals: [],
  activeRunId: null,

  toasts: [],
  busy: false,

  update: null,

  platform: { enabled: false, configured: false, authenticated: false, config: null },
  platformAccess: {},

  init: async () => {
    const settings = await api.settings.get()
    const layout = settings.layout
    set({
      settings,
      inspectorOpen: layout.inspectorOpen,
      inspectorWidth: layout.inspectorWidth,
      inspectorTab: layout.inspectorTab
    })
    get().applyTheme()

    if (!chatUnsub) chatUnsub = onChat((event) => handleChatEvent(event, set, get))
    if (!termUnsub) termUnsub = onTerminal((event) => handleTerminalEvent(event, set, get))
    if (!updateUnsub) updateUnsub = onUpdate((event) => handleUpdateEvent(event, set, get))
    if (!platformUnsub) platformUnsub = onPlatform((status) => handlePlatformEvent(status, set, get))

    // Seed platform state from the main process. The `evt:platform` push above can
    // be emitted while the window is still booting (before this subscription
    // exists), and those events are not replayed — without this pull the Account
    // modal could sit on "Alpha Cloud is disabled" for a fully configured app.
    await get().refreshPlatform()

    await get().refreshProviders()
    await get().refreshModels()
    await get().loadConversations()
    await get().loadProjects()

    const { selectedProviderId, selectedModelId } = get()
    if (selectedProviderId && selectedModelId) {
      const existing = get().conversations[0]
      if (existing) await get().openConversation(existing.id)
      else await get().newConversation(get().activeProjectId)
    }
    set({ ready: true })
  },

  setView: (view) => set({ view }),
  setInspectorTab: (inspectorTab) => {
    set({ inspectorTab, inspectorOpen: true })
    void persistLayout(get)
  },
  setInspectorOpen: (inspectorOpen) => {
    set({ inspectorOpen })
    void persistLayout(get)
  },
  setInspectorWidth: (inspectorWidth) => set({ inspectorWidth }),
  applyTheme: () => {
    const theme = get().settings?.theme ?? 'dark'
    document.documentElement.setAttribute('data-theme', theme)
    void api.setTheme(theme === 'dark')
  },

  saveSettings: async (patch) => {
    const settings = await api.settings.set(patch)
    set({ settings })
    get().applyTheme()
  },

  toast: (message, kind = 'info') => {
    const id = Math.random().toString(36).slice(2)
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setDraft: (draft) => set({ draft }),

  refreshProviders: async () => {
    try {
      const providers = await api.providers.list()
      set({ providers })
      const statuses: Record<string, ProviderStatus> = {}
      const list = await api.providers.status()
      for (const s of list) statuses[s.providerId] = s
      set({ statuses })
    } catch (e) {
      get().toast(`Could not load providers: ${(e as Error).message}`, 'error')
    }
  },

  refreshModels: async () => {
    set({ modelsLoading: true })
    const providers = get().providers
    const all: ModelInfo[] = []
    for (const p of providers) {
      if (!p.enabled) continue
      try {
        const list = await api.providers.models(p.id)
        all.push(...list)
      } catch (e) {
        set((s) => ({
          statuses: {
            ...s.statuses,
            [p.id]: {
              providerId: p.id,
              state: 'error',
              message: (e as Error).message,
              checkedAt: Date.now()
            }
          }
        }))
      }
    }
    set({ models: all, modelsLoading: false })

    const { selectedProviderId, selectedModelId, settings } = get()
    const stillValid = all.some(
      (m) => m.providerId === selectedProviderId && m.id === selectedModelId
    )
    if (!stillValid) {
      const preferred = settings?.defaultModelId
        ? all.find((m) => m.id === settings.defaultModelId)
        : undefined
      const local = all.find((m) => m.providerKind === 'ollama')
      const pick = preferred ?? local ?? all[0]
      if (pick) set({ selectedProviderId: pick.providerId, selectedModelId: pick.id })
    }
  },

  selectModel: (providerId, modelId) => {
    set({ selectedProviderId: providerId, selectedModelId: modelId })
    const conv = get().conversations.find((c) => c.id === get().activeConversationId)
    if (conv) {
      void api.conversations.update({ id: conv.id, providerId, modelId }).then(() => get().loadConversations())
    }
  },

  loadConversations: async () => {
    const conversations = await api.conversations.list()
    set({ conversations })
  },

  openConversation: async (id) => {
    const { conversation, messages } = await api.conversations.get(id)
    set({
      activeConversationId: id,
      messages,
      draft: '',
      view: 'chat',
      selectedProviderId: conversation.providerId ?? get().selectedProviderId,
      selectedModelId: conversation.modelId ?? get().selectedModelId,
      activeProjectId: conversation.projectId ?? get().activeProjectId
    })
    if (conversation.projectId) {
      try {
        await get().selectProject(conversation.projectId)
      } catch {
        /* ignore */
      }
    }
  },

  newConversation: async (projectId) => {
    const model = get().selectedModelId
    const provider = get().selectedProviderId
    const conversation = await api.conversations.create({
      projectId: projectId ?? get().activeProjectId ?? null,
      providerId: provider,
      modelId: model
    })
    set({ activeConversationId: conversation.id, messages: [], draft: '', view: 'chat' })
    await get().loadConversations()
    return conversation.id
  },

  deleteConversation: async (id) => {
    await api.conversations.remove(id)
    const { activeConversationId } = get()
    await get().loadConversations()
    if (activeConversationId === id) {
      const next = get().conversations[0]
      if (next) await get().openConversation(next.id)
      else set({ activeConversationId: null, messages: [] })
    }
  },

  renameConversation: async (id, title) => {
    await api.conversations.update({ id, title })
    await get().loadConversations()
  },

  loadProjects: async () => {
    const projects = await api.projects.list()
    set({ projects })
  },

  openProject: async () => {
    const { path } = await api.projects.pick()
    if (!path) return
    await get().openProjectByPath(path)
  },

  openProjectByPath: async (path) => {
    try {
      const info = await api.projects.open(path)
      await get().loadProjects()
      set({
        activeProjectId: info.project.id,
        tree: info.files,
        gitStatus: info.git
      })
      const conv = get().conversations.find((c) => c.id === get().activeConversationId)
      if (conv && !conv.projectId) {
        await api.conversations.update({ id: conv.id, projectId: info.project.id })
        await get().loadConversations()
      }
      get().toast(`Opened ${info.project.name}`, 'success')
    } catch (e) {
      get().toast(`Could not open project: ${(e as Error).message}`, 'error')
    }
  },

  selectProject: async (id) => {
    const info = await api.projects.info(id)
    set({ activeProjectId: id, tree: info.files, gitStatus: info.git })
  },

  removeProject: async (id) => {
    await api.projects.remove(id)
    if (get().activeProjectId === id) set({ activeProjectId: null, tree: [], gitStatus: null })
    await get().loadProjects()
  },

  refreshTree: async () => {
    const id = get().activeProjectId
    if (!id) return
    const tree = await api.projects.tree(id, '', 2)
    set({ tree })
  },

  refreshGit: async () => {
    const id = get().activeProjectId
    if (!id) return
    try {
      const gitStatus = await api.git.status(id)
      set({ gitStatus })
    } catch {
      /* ignore */
    }
  },

  send: async (text, attachments) => {
    const state = get()
    let conversationId = state.activeConversationId
    if (!conversationId) {
      conversationId = await state.newConversation(state.activeProjectId)
    }
    const providerId = state.selectedProviderId
    const modelId = state.selectedModelId
    if (!providerId || !modelId) {
      state.toast('Select a model before sending.', 'error')
      return
    }
    if (Object.prototype.hasOwnProperty.call(state.platformAccess, modelId) && state.platformAccess[modelId] === false) {
      state.toast('This model is not included in your plan.', 'error')
      return
    }
    const mode = state.settings?.permissions.mode ?? 'assist'

    const tempId = 'temp-' + Math.random().toString(36).slice(2)
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: tempId,
          conversationId: conversationId as string,
          role: 'user',
          content: text,
          createdAt: Date.now(),
          attachments
        }
      ],
      isSending: true,
      streaming: null,
      draft: ''
    }))

    try {
      const { requestId } = await api.chat.send({
        conversationId,
        providerId,
        modelId,
        mode,
        projectId: state.activeProjectId,
        text,
        attachments
      })
      set({ streaming: { requestId, text: '', thinking: '', activities: [] } })
    } catch (e) {
      set({ isSending: false })
      get().toast(`Failed to send: ${(e as Error).message}`, 'error')
      await refreshMessages(get, set, conversationId)
    }
  },

  stop: async () => {
    const requestId = get().streaming?.requestId
    if (requestId) {
      await api.chat.cancel(requestId)
    }
    set({ isSending: false })
  },

  respondApproval: async (approvalId, approved) => {
    const req = get().pendingApprovals.find((a) => a.approvalId === approvalId)
    set((s) => ({ pendingApprovals: s.pendingApprovals.filter((a) => a.approvalId !== approvalId) }))
    if (req) await api.chat.approval(req.requestId, approvalId, approved)
  },

  runCommand: async (command, approved = false) => {
    const projectId = get().activeProjectId
    if (!projectId) {
      get().toast('Open a project first.', 'error')
      return
    }
    const runId = 'run-' + Math.random().toString(36).slice(2)
    set((s) => ({
      inspectorOpen: true,
      inspectorTab: 'terminal',
      activeRunId: runId,
      terminals: [
        ...s.terminals.slice(-4),
        { runId, command, cwd: '', lines: [], running: true }
      ]
    }))
    try {
      const result = await api.terminal.run({ projectId, command, approved })
      if (result.requiresApproval) {
        get().toast(`Command requires approval: ${result.reason}`, 'info')
        const ok = window.confirm(`Run this command in the project?\n\n${command}\n\nReason: ${result.reason}`)
        if (ok) {
          await get().runCommand(command, true)
        } else {
          set((s) => ({
            terminals: s.terminals.map((t) =>
              t.runId === runId ? { ...t, running: false, lines: [...t.lines, { id: crypto.randomUUID(), stream: 'meta' as const, data: 'Cancelled by user.\n' }] } : t
            )
          }))
        }
        return
      }
      if (!result.approved) {
        get().toast(result.reason, 'error')
      }
    } catch (e) {
      get().toast(`Command failed to start: ${(e as Error).message}`, 'error')
      set((s) => ({ terminals: s.terminals.map((t) => (t.runId === runId ? { ...t, running: false } : t)) }))
    }
  },

  cancelRun: async (runId) => {
    await api.terminal.cancel(runId)
  },

  checkForUpdates: async () => {
    try {
      const status = await api.updates.check()
      set({ update: status })
      if (status.state === 'unsupported') get().toast(status.message ?? 'Updates are only available in packaged builds.', 'info')
      else if (status.state === 'up-to-date') get().toast('You are on the latest version.', 'success')
      else if (status.state === 'available') get().toast(`Version ${status.version} is available. Click Download.`, 'info')
      else if (status.state === 'error') get().toast(status.message ?? 'Update check failed.', 'error')
    } catch (e) {
      get().toast(`Update check failed: ${(e as Error).message}`, 'error')
    }
  },

  downloadUpdate: async () => {
    const status = await api.updates.download()
    set({ update: status })
    if (status.state === 'error') get().toast(status.message ?? 'Download failed.', 'error')
  },

  installUpdate: async () => {
    const result = await api.updates.install()
    if (!result.ok) get().toast(result.message ?? 'Could not install the update.', 'error')
  },

  refreshPlatform: async () => {
    const status = await api.platform.status()
    setPlatform(status, set, get)
  },

  signInToPlatform: async (email) => {
    const result = await api.platform.signIn(email)
    return result
  },

  signOutOfPlatform: async () => {
    await api.platform.signOut()
    await get().refreshPlatform()
    void get().refreshProviders()
    void get().refreshModels()
  }
}))

async function refreshMessages(
  get: () => State,
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
  conversationId: string
): Promise<void> {
  try {
    const { messages } = await api.conversations.get(conversationId)
    set({ messages })
    await get().loadConversations()
  } catch {
    /* ignore */
  }
}

function persistLayout(get: () => State): Promise<void> {
  const { inspectorOpen, inspectorWidth, inspectorTab } = get()
  return api.settings
    .set({ layout: { inspectorOpen, inspectorWidth, inspectorTab } })
    .then(() => undefined)
    .catch(() => undefined)
}

function handleChatEvent(
  event: import('@shared/types').ChatEvent,
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State
): void {
  switch (event.type) {
    case 'start':
      set({ streaming: { requestId: event.requestId, text: '', thinking: '', activities: [] } })
      break
    case 'delta':
      set((s) =>
        s.streaming && s.streaming.requestId === event.requestId
          ? { streaming: { ...s.streaming, text: s.streaming.text + event.content } }
          : {}
      )
      break
    case 'thinking':
      set((s) =>
        s.streaming && s.streaming.requestId === event.requestId
          ? { streaming: { ...s.streaming, thinking: s.streaming.thinking + event.content } }
          : {}
      )
      break
    case 'activity': {
      const activity = event.activity
      set((s) => {
        if (!s.streaming) return {}
        const activities = [...s.streaming.activities]
        const idx = activities.findIndex((a) => a.id === activity.id)
        if (idx >= 0) activities[idx] = activity
        else activities.push(activity)
        const pendingApprovals = [...s.pendingApprovals]
        if (activity.state === 'awaiting-approval' && activity.approvalId) {
          if (!pendingApprovals.some((p) => p.approvalId === activity.approvalId)) {
            pendingApprovals.push({
              requestId: event.requestId,
              approvalId: activity.approvalId,
              title: activity.title,
              detail: activity.detail ?? ''
            })
          }
        }
        return { streaming: { ...s.streaming, activities }, pendingApprovals }
      })
      break
    }
    case 'done':
    case 'cancelled': {
      const convId = get().activeConversationId
      set({ streaming: null, isSending: false })
      if (convId) void refreshMessages(get, set, convId)
      void get().refreshGit()
      break
    }
    case 'error': {
      const convId = get().activeConversationId
      set({ streaming: null, isSending: false })
      get().toast(event.error, 'error')
      if (convId) void refreshMessages(get, set, convId)
      break
    }
    default:
      break
  }
}

function handleTerminalEvent(
  event: import('@shared/types').TerminalEvent,
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State
): void {
  switch (event.type) {
    case 'start':
      set((s) => ({
        terminals: s.terminals.map((t) =>
          t.runId === event.runId
            ? { ...t, cwd: event.cwd, command: event.command, running: true }
            : t
        )
      }))
      break
    case 'stdout':
      appendTerminal(set, event.runId, 'stdout', event.data)
      break
    case 'stderr':
      appendTerminal(set, event.runId, 'stderr', event.data)
      break
    case 'exit':
      set((s) => ({
        terminals: s.terminals.map((t) =>
          t.runId === event.runId
            ? {
                ...t,
                running: false,
                exit: { code: event.code, durationMs: event.durationMs },
                lines: [
                  ...t.lines,
                  {
                    id: Math.random().toString(36).slice(2),
                    stream: 'meta' as const,
                    data: `\n[exit ${event.code ?? '?'} in ${event.durationMs}ms]\n`
                  }
                ]
              }
            : t
        )
      }))
      break
    case 'error':
      appendTerminal(set, event.runId, 'stderr', `\n[error] ${event.error}\n`)
      break
    default:
      break
  }
}

function handleUpdateEvent(
  event: UpdateEvent,
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State
): void {
  set({ update: event })
  if (event.state === 'downloaded') {
    get().toast('Update downloaded — restart to install.', 'success')
  }
}

function setPlatform(
  status: PlatformStatus,
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State
): void {
  const prev = get().platform
  const access: Record<string, boolean> = {}
  for (const m of status.config?.models ?? []) access[m.modelId] = m.allowed
  set({ platform: status, platformAccess: access })
  if (prev.authenticated !== status.authenticated || prev.enabled !== status.enabled) {
    void get().refreshProviders()
    void get().refreshModels()
  }
}

function handlePlatformEvent(
  status: PlatformStatus,
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State
): void {
  setPlatform(status, set, get)
}

function appendTerminal(
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
  runId: string,
  stream: 'stdout' | 'stderr',
  data: string
): void {
  set((s) => ({
    terminals: s.terminals.map((t) =>
      t.runId === runId
        ? {
            ...t,
            lines: [...t.lines, { id: Math.random().toString(36).slice(2), stream, data }]
          }
        : t
    )
  }))
}
