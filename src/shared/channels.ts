export const CH = {
  appInfo: 'app:info',
  diagnostics: 'app:diagnostics',
  appTheme: 'app:theme',
  revealPath: 'shell:showItem',
  openExternal: 'shell:openExternal',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateStatus: 'update:status',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  secretsSet: 'secrets:set',
  secretsDelete: 'secrets:delete',
  secretsHas: 'secrets:has',

  skillsList: 'skills:list',
  skillsSetEnabled: 'skills:setEnabled',
  skillsSave: 'skills:save',
  agentLocations: 'agent:locations',
  agentPickLocation: 'agent:pickLocation',

  providersList: 'providers:list',
  providersSave: 'providers:save',
  providersRemove: 'providers:remove',
  providersTest: 'providers:test',
  providersModels: 'providers:models',
  providersStatus: 'providers:status',

  ollamaStatus: 'ollama:status',
  ollamaCatalog: 'ollama:catalog',
  ollamaHardware: 'ollama:hardware',
  ollamaPull: 'ollama:pull',
  ollamaPreload: 'ollama:preload',
  ollamaCancel: 'ollama:cancel',
  ollamaRemove: 'ollama:remove',

  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatApproval: 'chat:approval',

  conversationsList: 'conversations:list',
  conversationsSearch: 'conversations:search',
  conversationsArchived: 'conversations:archived',
  conversationsGet: 'conversations:get',
  conversationsCreate: 'conversations:create',
  conversationsUpdate: 'conversations:update',
  conversationsDelete: 'conversations:delete',
  conversationsArchive: 'conversations:archive',
  conversationsUnarchive: 'conversations:unarchive',
  conversationsAppend: 'conversations:append',
  conversationsClear: 'conversations:clear',

  projectPick: 'project:pick',
  projectOpen: 'project:open',
  projectList: 'project:list',
  projectRemove: 'project:remove',
  projectRename: 'project:rename',
  projectInfo: 'project:info',
  projectTree: 'project:tree',
  projectRead: 'project:read',
  projectWrite: 'project:write',
  projectSearch: 'project:search',
  projectSearchContent: 'project:searchContent',

  editPropose: 'edit:propose',
  editApply: 'edit:apply',
  editCheckpoints: 'edit:checkpoints',
  editRestore: 'edit:restore',

  terminalRun: 'terminal:run',
  terminalCancel: 'terminal:cancel',

  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserOpenExternal: 'browser:openExternal',
  browserLayout: 'browser:layout',
  browserState: 'browser:state',

  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  gitStage: 'git:stage',
  gitUnstage: 'git:unstage',
  gitCommit: 'git:commit',
  gitPush: 'git:push',
  gitPull: 'git:pull',
  gitLog: 'git:log',
  gitBranches: 'git:branches',
  gitCreateBranch: 'git:createBranch',
  gitCheckout: 'git:checkout',
  gitInit: 'git:init',
  gitRemotes: 'git:remotes',
  gitSetRemote: 'git:setRemote',

  githubStatus: 'github:status',
  githubConnect: 'github:connect',
  githubDisconnect: 'github:disconnect',
  githubRepos: 'github:repos',
  githubCreateRepo: 'github:createRepo',
  githubDeviceStart: 'github:deviceStart',
  githubDevicePoll: 'github:devicePoll',
  githubDeviceCancel: 'github:deviceCancel',
  githubDeviceOpen: 'github:deviceOpen',

  attachmentsAnalyze: 'attachments:analyze',
  attachmentsPick: 'attachments:pick',

  voiceTranscribe: 'voice:transcribe',

  macroList: 'macro:list',
  macroSave: 'macro:save',
  macroRun: 'macro:run',
  macroRemove: 'macro:remove',

  dvrTimeline: 'dvr:getTimeline',
  dvrFrame: 'dvr:frame',
  dvrRollback: 'dvr:rollback',

  platformStatus: 'platform:status',
  platformSignIn: 'platform:signin',
  platformSignInWith: 'platform:signinWith',
  platformSignOut: 'platform:signout',
  platformRefresh: 'platform:refresh'
} as const

/**
 * Channels used by the always-on-top control pill.
 *
 * The HUD is a separate window with its own minimal preload, so its buttons use
 * one-way `send` rather than the request/response `invoke` surface. Keeping the
 * names here means there is still exactly one place that lists IPC channels.
 */
export const HUD = {
  decision: 'hud:decision',
  stop: 'hud:stop',
  state: 'hud:state'
} as const

export const EVENTS = {
  chat: 'evt:chat',
  terminal: 'evt:terminal',
  browser: 'evt:browser',
  providerStatus: 'evt:provider-status',
  project: 'evt:project',
  update: 'evt:update',
  platform: 'evt:platform',
  ollama: 'evt:ollama',
  /** Emergency kill-switch fired; the renderer shows a toast. */
  agentStopped: 'evt:agent-stopped'
} as const

export type Channel = (typeof CH)[keyof typeof CH]
export type EventChannel = (typeof EVENTS)[keyof typeof EVENTS]

export const INVOKE_CHANNELS: readonly string[] = Object.values(CH)
export const EVENT_CHANNELS: readonly string[] = Object.values(EVENTS)
