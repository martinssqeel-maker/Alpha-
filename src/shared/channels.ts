export const CH = {
  appInfo: 'app:info',
  diagnostics: 'app:diagnostics',
  appTheme: 'app:theme',
  revealPath: 'shell:showItem',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateStatus: 'update:status',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  secretsSet: 'secrets:set',
  secretsDelete: 'secrets:delete',
  secretsHas: 'secrets:has',

  providersList: 'providers:list',
  providersSave: 'providers:save',
  providersRemove: 'providers:remove',
  providersTest: 'providers:test',
  providersModels: 'providers:models',
  providersStatus: 'providers:status',

  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatApproval: 'chat:approval',

  conversationsList: 'conversations:list',
  conversationsGet: 'conversations:get',
  conversationsCreate: 'conversations:create',
  conversationsUpdate: 'conversations:update',
  conversationsDelete: 'conversations:delete',
  conversationsAppend: 'conversations:append',
  conversationsClear: 'conversations:clear',

  projectPick: 'project:pick',
  projectOpen: 'project:open',
  projectList: 'project:list',
  projectRemove: 'project:remove',
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

  attachmentsAnalyze: 'attachments:analyze',
  attachmentsPick: 'attachments:pick',

  voiceTranscribe: 'voice:transcribe',

  platformStatus: 'platform:status',
  platformSignIn: 'platform:signin',
  platformSignOut: 'platform:signout',
  platformRefresh: 'platform:refresh'
} as const

export const EVENTS = {
  chat: 'evt:chat',
  terminal: 'evt:terminal',
  providerStatus: 'evt:provider-status',
  project: 'evt:project',
  update: 'evt:update',
  platform: 'evt:platform'
} as const

export type Channel = (typeof CH)[keyof typeof CH]
export type EventChannel = (typeof EVENTS)[keyof typeof EVENTS]

export const INVOKE_CHANNELS: readonly string[] = Object.values(CH)
export const EVENT_CHANNELS: readonly string[] = Object.values(EVENTS)
