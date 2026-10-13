import { z } from 'zod'
import { RESOLVED_THEME_OPTIONS } from './theme'

export const zPermissionLevel = z.enum(['allow', 'ask', 'deny'])
export const zPermissionMode = z.enum(['chat', 'assist', 'agent'])

export const zProviderSave = z.object({
  id: z.string().min(1).optional(),
  kind: z.enum(['ollama', 'openai-compatible', 'gateway']),
  name: z.string().min(1).max(120),
  baseUrl: z.string().min(1).max(2000),
  enabled: z.boolean().default(true),
  isLocal: z.boolean().default(false),
  preset: z.string().max(80).optional(),
  apiKey: z.string().max(4000).optional()
})

export const zProviderTest = z.object({
  id: z.string().optional(),
  kind: z.enum(['ollama', 'openai-compatible', 'gateway']),
  baseUrl: z.string().min(1),
  apiKey: z.string().max(4000).optional()
})

export const zPlatformSignIn = z.object({
  email: z.string().email()
})

export const zChatSend = z.object({
  conversationId: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  mode: zPermissionMode,
  projectId: z.string().nullable().optional(),
  text: z.string().min(0).max(200_000),
  attachments: z.array(z.any()).max(20).optional(),
  allowTools: z.boolean().optional()
})

export const zApproval = z.object({
  requestId: z.string().min(1),
  approvalId: z.string().min(1),
  approved: z.boolean(),
  remember: z.boolean().optional()
})

export const zConversationCreate = z.object({
  title: z.string().max(200).optional(),
  projectId: z.string().nullable().optional(),
  providerId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional()
})

export const zConversationUpdate = z.object({
  id: z.string().min(1),
  title: z.string().max(200).optional(),
  projectId: z.string().nullable().optional(),
  providerId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional()
})
export const zConversationSearch = z.object({ query: z.string().min(1).max(500) })
export const zProjectRename = z.object({ id: z.string().min(1), name: z.string().trim().min(1).max(100) })
export const zSkillEnable = z.object({ id: z.string().min(2).max(64), enabled: z.boolean() })

export const zId = z.object({ id: z.string().min(1) })

// Payload schemas for the channels whose request key is not `id`. These mirror
// `IpcContract` in shared/ipc.ts, which is the contract both sides are written
// against: validating with the wrong key shape rejects every call before it
// reaches its handler (the caller only sees "Invalid request: Required").
export const zRequestId = z.object({ requestId: z.string().min(1) })
export const zRunId = z.object({ runId: z.string().min(1) })
export const zProjectId = z.object({ projectId: z.string().min(1) })
export const zIdNullable = z.object({ id: z.string().min(1).nullable() })

export const zConversationAppend = z.object({
  conversationId: z.string().min(1),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().max(2_000_000),
  messageId: z.string().optional(),
  modelId: z.string().nullable().optional(),
  providerId: z.string().nullable().optional(),
  activity: z.any().optional(),
  attachments: z.any().optional()
})

export const zProjectOpen = z.object({ path: z.string().min(1) })
export const zProjectRead = z.object({
  projectId: z.string().min(1),
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(5_000_000).optional()
})
export const zProjectWrite = z.object({
  projectId: z.string().min(1),
  path: z.string().min(1),
  content: z.string().max(5_000_000),
  expectedHash: z.string().optional(),
  createCheckpoint: z.boolean().optional()
})
export const zProjectTree = z.object({
  projectId: z.string().min(1),
  path: z.string().optional(),
  depth: z.number().int().min(1).max(8).optional()
})
export const zSearch = z.object({
  projectId: z.string().min(1),
  query: z.string().min(1).max(500),
  glob: z.string().max(300).optional(),
  maxResults: z.number().int().min(1).max(1000).optional()
})

export const zEditPropose = z.object({
  projectId: z.string().min(1),
  path: z.string().min(1),
  kind: z.enum(['write', 'patch', 'delete']).default('write'),
  after: z.string().optional(),
  patch: z.string().optional(),
  baseHash: z.string().optional()
})
export const zEditApply = z.object({
  proposalId: z.string().min(1)
})
export const zCheckpointRestore = z.object({
  checkpointId: z.string().min(1)
})

export const zTerminalRun = z.object({
  runId: z.string().uuid().optional(),
  projectId: z.string().min(1),
  command: z.string().min(1).max(4000),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(30 * 60 * 1000).optional(),
  purpose: z.string().max(300).optional(),
  approved: z.boolean().optional()
})

export const zBrowserNavigate = z.object({ url: z.string().min(1).max(2048) })
export const zBrowserLayout = z.object({
  visible: z.boolean(),
  bounds: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite(),
    height: z.number().finite()
  })
})

export const zGitCommit = z.object({
  projectId: z.string().min(1),
  message: z.string().min(1).max(5000),
  files: z.array(z.string()).max(10000).optional(),
  push: z.boolean().optional()
})
export const zGitPush = z.object({ projectId: z.string().min(1) })
export const zGitPull = z.object({ projectId: z.string().min(1) })
export const zGitDiff = z.object({
  projectId: z.string().min(1),
  path: z.string().optional(),
  staged: z.boolean().optional()
})
export const zGitCreateBranch = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(200),
  checkout: z.boolean().optional()
})
export const zGitCheckout = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(200)
})
export const zGitSetRemote = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(80),
  url: z.string().min(1).max(2000)
})

export const zGithubConnect = z.object({
  token: z.string().min(1).max(4000).optional(),
  method: z.enum(['token', 'device']).default('token')
})
export const zGithubCreateRepo = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  private: z.boolean().optional()
})

export const zAttachmentAnalyze = z.object({
  path: z.string().min(1),
  kind: z.string().optional()
})

export const zVoiceTranscribe = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.string().optional(),
  providerId: z.string().optional(),
  model: z.string().optional()
})

export const zSettingsSet = z.object({
  patch: z.record(z.any())
})

export const zAppTheme = z.object({
  theme: z.enum(RESOLVED_THEME_OPTIONS)
})
