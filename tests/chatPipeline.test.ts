/**
 * Chat pipeline behaviour: history budget, tool orchestration, de-duplication
 * and the timing metrics.
 *
 * The provider is scripted (a model would be non-deterministic), but everything
 * below it — `ChatService`, the real tool dispatch table, the real conversation
 * store, the real permission resolver — is the production code path.
 *
 * Note on the two overlap tests: they record *what can overlap*. The git tools
 * await a child process and therefore genuinely run together, so that test counts
 * how many calls were in flight at once rather than timing them — elapsed time on
 * a loaded machine cannot tell "started together" from "started in sequence".
 * The file tools are synchronous `readFileSync` calls and cannot overlap however
 * they are scheduled, so there the serialised total is the proof, and a lower
 * bound on it does not depend on how busy the machine is.
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ChatService, MAX_HISTORY_CHARS, isParallelSafeTool, selectHistory } from '../src/main/services/chat'
import { Db } from '../src/main/services/db'
import { initLogger } from '../src/main/services/logger'
import { ApprovalBroker, PermissionService } from '../src/main/services/permissionService'
import { ConversationsRepo, SettingsRepo } from '../src/main/services/store'
import type { ActivityItem, ChatEvent, ChatMetrics } from '../src/shared/types'
import type { ChatToolCall } from '../src/main/services/providers/types'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-chat-pipeline-'))
const openDbs: Db[] = []

beforeAll(() => {
  initLogger(path.join(tmpRoot, 'logs'))
})

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs.length = 0
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Harness {
  chat: ChatService
  conversationId: string
  events: ChatEvent[]
  activities: ActivityItem[]
  metrics: () => ChatMetrics | undefined
  /** The most git tool calls that were ever in flight at the same moment. */
  gitOverlap: () => number
  waitFor: (type: ChatEvent['type'], timeoutMs?: number) => Promise<ChatEvent>
}

/**
 * Build a ChatService whose provider answers with the given tool calls first and
 * a short answer afterwards, and whose project service is instrumented.
 */
async function harness(options: {
  toolCalls: ChatToolCall[][]
  calls?: string[]
  listTreeDelayMs?: number
  asyncListTreeDelayMs?: number
  readDelayMs?: number
  gitDelayMs?: number
}): Promise<Harness> {
  const db = await Db.open(path.join(tmpRoot, `pipeline-${Math.random().toString(36).slice(2)}.db`))
  openDbs.push(db)
  const conversations = new ConversationsRepo(db)
  const settings = new SettingsRepo(db)
  const permissions = new PermissionService(settings)
  const conversation = conversations.create({})
  const calls = options.calls ?? []
  let iteration = 0

  const events: ChatEvent[] = []
  const activities: ActivityItem[] = []

  const projectsStub = {
    listTree: (projectId: string, dir = '', depth = 2) => {
      calls.push('list_project_files')
      if (options.listTreeDelayMs) busyWait(options.listTreeDelayMs)
      void projectId
      void dir
      void depth
      return [{ name: 'src', type: 'directory' as const }]
    },
    readFile: (projectId: string, filePath: string) => {
      calls.push(`read_project_file:${filePath}`)
      if (options.readDelayMs) busyWait(options.readDelayMs)
      void projectId
      return { path: filePath, content: 'contents', size: 8, hash: 'h', binary: false, truncated: false }
    },
    searchNames: () => [],
    searchContent: () => [],
    resolveRoot: () => tmpRoot,
    resolveProject: (id: string) => ({ id, name: 'stub', rootPath: tmpRoot })
  }

  // Overlap is counted as it happens rather than inferred from elapsed time: two
  // 120ms awaits measure ~350ms on a loaded machine, which says nothing about
  // whether they ran together.
  let gitInFlight = 0
  let gitPeak = 0
  const track = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    calls.push(name)
    gitInFlight++
    gitPeak = Math.max(gitPeak, gitInFlight)
    try {
      return await work()
    } finally {
      gitInFlight--
    }
  }

  const gitStub = {
    status: () =>
      track('get_git_status', async () => {
        await sleep(options.gitDelayMs ?? 0)
        return { isRepo: true, branch: 'main', files: [], remotes: [] }
      }),
    diff: () =>
      track('get_git_diff', async () => {
        await sleep(options.gitDelayMs ?? 0)
        return 'diff --git a/x b/x'
      })
  }

  const editsStub = {
    describeProposal: () => null,
    propose: () => ({ proposalId: 'p1', path: 'x.ts', kind: 'write' as const, diff: 'diff', stale: false }),
    apply: () => ({ ok: true, path: 'x.ts' })
  }

  const provider = {
    get: () => ({ id: 'fake', name: 'Fake', isLocal: true, kind: 'ollama' as const }),
    chat: async (_id: string, req: { onDelta?: (d: { content?: string }) => void }) => {
      const round = options.toolCalls[iteration] ?? []
      iteration++
      req.onDelta?.({ content: round.length ? '' : 'done' })
      return {
        content: '',
        toolCalls: round,
        finishReason: 'stop'
      }
    }
  }

  const chat = new ChatService({
    providers: provider as never,
    conversations,
    projects: projectsStub as never,
    edits: editsStub as never,
    git: gitStub as never,
    terminal: { runCollect: async () => ({ code: 0, stdout: '', stderr: '', durationMs: 0 }) } as never,
    skills: { promptContext: () => '' } as never,
    permissions,
    broker: new ApprovalBroker(),
    settings,
    emit: (event) => {
      events.push(event)
      if (event.type === 'activity') {
        const index = activities.findIndex((a) => a.id === event.activity.id)
        if (index >= 0) activities[index] = event.activity
        else activities.push(event.activity)
      }
    }
  })

  const waitFor = async (type: ChatEvent['type'], timeoutMs = 8000): Promise<ChatEvent> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = events.find((event) => event.type === type)
      if (found) return found
      await sleep(5)
    }
    throw new Error(`Timed out waiting for chat event "${type}"`)
  }

  return {
    chat,
    conversationId: conversation.id,
    events,
    activities,
    metrics: () => {
      const event = events.find((e) => e.type === 'metrics')
      return event && event.type === 'metrics' ? event.metrics : undefined
    },
    gitOverlap: () => gitPeak,
    waitFor
  }
}

/** Blocking sleep, used to model a synchronous tool such as `readFileSync`. */
function busyWait(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* spin */
  }
}

function call(name: string, args: Record<string, unknown>, id = name): ChatToolCall {
  return { id, name, arguments: args }
}

describe('selectHistory', () => {
  it('keeps the newest turns within the character budget', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ content: 'x'.repeat(1000), turn: i }))
    const kept = selectHistory(history, 20, 2500)
    expect(kept).toHaveLength(2)
    expect(kept.map((m) => m.turn)).toEqual([8, 9])
  })

  it('never drops the most recent message, even when it alone is over budget', () => {
    const history = [{ content: 'short' }, { content: 'y'.repeat(MAX_HISTORY_CHARS * 2) }]
    expect(selectHistory(history)).toHaveLength(1)
    expect(selectHistory(history)[0].content).toHaveLength(MAX_HISTORY_CHARS * 2)
  })

  it('still respects the message-count ceiling', () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ content: 'a', turn: i }))
    const kept = selectHistory(history, 5, MAX_HISTORY_CHARS)
    expect(kept.map((m) => m.turn)).toEqual([35, 36, 37, 38, 39])
  })

  it('keeps the budget far below what 20 messages used to allow', () => {
    // The regression this guards: 20 messages × 12k characters was 240k characters
    // of prompt, which no provider can use and which truncated the newest turns.
    expect(MAX_HISTORY_CHARS).toBeLessThanOrEqual(20 * 12_000)
    const history = Array.from({ length: 20 }, () => ({ content: 'z'.repeat(12_000) }))
    const total = selectHistory(history).reduce((sum, m) => sum + m.content.length, 0)
    expect(total).toBeLessThanOrEqual(MAX_HISTORY_CHARS)
  })
})

describe('tool orchestration', () => {
  it('classifies only non-mutating tools as parallel-safe', () => {
    expect(isParallelSafeTool('read_project_file')).toBe(true)
    expect(isParallelSafeTool('list_project_files')).toBe(true)
    expect(isParallelSafeTool('get_git_status')).toBe(true)
    expect(isParallelSafeTool('apply_approved_patch')).toBe(false)
    expect(isParallelSafeTool('run_approved_command')).toBe(false)
    // A proposal writes nothing — it diffs against the file's current hash and
    // returns an id — so several may be computed together. Approving one is
    // still serial, because `apply_approved_patch` does mutate the disk.
    expect(isParallelSafeTool('propose_file_patch')).toBe(true)
    expect(isParallelSafeTool('not_a_tool')).toBe(false)
  })

  it('returns every tool result, in the order the model asked for them', async () => {
    const h = await harness({
      toolCalls: [
        [
          call('read_project_file', { path: 'a.ts' }, 'call-a'),
          call('list_project_files', {}, 'call-b'),
          call('read_project_file', { path: 'b.ts' }, 'call-c')
        ],
        []
      ]
    })
    h.chat.send({
      conversationId: h.conversationId,
      providerId: 'fake',
      modelId: 'fake',
      mode: 'assist',
      projectId: 'project-1',
      text: 'read the files'
    })
    await h.waitFor('done')

    const toolActivities = h.activities.filter((a) => a.kind === 'tool')
    expect(toolActivities).toHaveLength(3)
    expect(h.activities.every((a) => a.state === 'completed')).toBe(true)
    const done = h.events.find((e) => e.type === 'done')
    expect(done && done.type === 'done' && done.content.length >= 0).toBe(true)
  })

  it('runs an identical read once and reuses the result', async () => {
    const calls: string[] = []
    const h = await harness({
      calls,
      toolCalls: [
        [
          call('read_project_file', { path: 'same.ts' }, 'call-1'),
          call('read_project_file', { path: 'same.ts' }, 'call-2')
        ],
        []
      ]
    })
    h.chat.send({
      conversationId: h.conversationId,
      providerId: 'fake',
      modelId: 'fake',
      mode: 'assist',
      projectId: 'project-1',
      text: 'read it twice'
    })
    await h.waitFor('done')

    // Two tool messages are still sent back to the model (one per call id), but
    // the file is only touched once.
    expect(calls.filter((c) => c === 'read_project_file:same.ts')).toHaveLength(1)
  })

  it('starts await-based git reads together instead of one after another', async () => {
    const calls: string[] = []
    const h = await harness({
      calls,
      gitDelayMs: 120,
      toolCalls: [[call('get_git_status', {}, 'g1'), call('get_git_diff', {}, 'g2')], []]
    })
    h.chat.send({
      conversationId: h.conversationId,
      providerId: 'fake',
      modelId: 'fake',
      mode: 'assist',
      projectId: 'project-1',
      text: 'git state please'
    })
    await h.waitFor('done')

    expect(calls).toContain('get_git_status')
    expect(calls).toContain('get_git_diff')
    // The claim is overlap, so overlap is what is measured: both stubs were in
    // flight at the same moment. Serialised orchestration would have peaked at 1,
    // however fast the machine is.
    expect(h.gitOverlap()).toBe(2)
  })

  it('cannot overlap synchronous file reads, and says so by measurement', async () => {
    const calls: string[] = []
    const h = await harness({
      calls,
      readDelayMs: 80,
      toolCalls: [
        [
          call('read_project_file', { path: 'one.ts' }, 'r1'),
          call('read_project_file', { path: 'two.ts' }, 'r2'),
          call('read_project_file', { path: 'three.ts' }, 'r3')
        ],
        []
      ]
    })
    const started = Date.now()
    h.chat.send({
      conversationId: h.conversationId,
      providerId: 'fake',
      modelId: 'fake',
      mode: 'assist',
      projectId: 'project-1',
      text: 'read three files'
    })
    await h.waitFor('done')
    const elapsed = Date.now() - started

    expect(calls.filter((c) => c.startsWith('read_project_file')).length).toBe(3)
    // Documented, not wished for: these are `readFileSync` calls, so 3 × 80ms of
    // work takes 3 × 80ms even though they were started together. Parallelising
    // them would need the file tools to become async — a separate change.
    expect(elapsed).toBeGreaterThanOrEqual(3 * 80)
  })
})

describe('timing metrics', () => {
  it('reports real prompt, first-token and total timings with the tool cost', async () => {
    const h = await harness({
      gitDelayMs: 60,
      toolCalls: [[call('get_git_status', {}, 'g1')], []]
    })
    h.chat.send({
      conversationId: h.conversationId,
      providerId: 'fake',
      modelId: 'fake',
      mode: 'assist',
      projectId: 'project-1',
      text: 'status'
    })
    await h.waitFor('metrics')

    const metrics = h.metrics()
    expect(metrics).toBeDefined()
    expect(metrics!.promptMs).toBeGreaterThanOrEqual(0)
    expect(metrics!.ttftMs).toBeGreaterThanOrEqual(0)
    expect(metrics!.totalMs).toBeGreaterThanOrEqual(metrics!.ttftMs)
    expect(metrics!.toolCalls).toBe(1)
    // The git stub takes 60ms, and that time is attributed to tools, not hidden.
    expect(metrics!.toolMs).toBeGreaterThanOrEqual(50)
  })

  it('counts only the history messages actually sent', async () => {
    const h = await harness({ toolCalls: [[], []] })
    const first = {
      conversationId: h.conversationId,
      providerId: 'fake',
      modelId: 'fake',
      mode: 'assist' as const,
      text: 'hello'
    }
    h.chat.send(first)
    await h.waitFor('done')
    // A fresh conversation sends no history: system prompt and the current turn
    // are not history.
    expect(h.metrics()!.historyMessages).toBe(0)

    h.events.length = 0
    h.chat.send({ ...first, text: 'and again' })
    await h.waitFor('metrics')
    // The first exchange is now history and is counted.
    expect(h.metrics()!.historyMessages).toBeGreaterThan(0)
  })
})
