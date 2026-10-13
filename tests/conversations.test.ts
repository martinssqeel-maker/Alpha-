import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createConversationTitle } from '../src/shared/conversationTitle'
import { Db } from '../src/main/services/db'
import { ConversationsRepo, ProjectsRepo } from '../src/main/services/store'
import { EditService } from '../src/main/services/editService'
import { initLogger } from '../src/main/services/logger'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-conversation-test-'))
let openDbs: Db[] = []

beforeAll(() => {
  initLogger(path.join(tmpRoot, 'logs'))
})

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

async function openDb(name: string): Promise<Db> {
  const db = await Db.open(path.join(tmpRoot, name))
  openDbs.push(db)
  return db
}

describe('local conversation titles', () => {
  it('creates a concise sentence-case title from the first request', () => {
    expect(createConversationTitle('Please, can you fix the parser errors and add tests?')).toBe('Fix the parser errors and add')
    expect(createConversationTitle('Explain `safeStorage` support for Windows')).toBe('Explain safeStorage support for Windows')
    expect(createConversationTitle('😀', ['readme_notes.md'])).toBe('Readme notes')
  })

  it('limits titles to six words and falls back honestly for empty content', () => {
    expect(createConversationTitle('Summarize this project and identify its main risks for maintainers')).toBe('Summarize this project and identify its')
    expect(createConversationTitle('```ts\nconst x = 1\n```')).toBe('New chat')
  })
})

describe('conversation and project persistence', () => {
  it('auto-titles only an untouched placeholder and never overwrites a manual rename', async () => {
    const db = await openDb('titles.db')
    const repo = new ConversationsRepo(db)
    const conversation = repo.create({})

    expect(repo.setAutoTitle(conversation.id, 'Inspect project permissions')?.title).toBe('Inspect project permissions')
    expect(repo.get(conversation.id)?.titleSource).toBe('auto')

    repo.update(conversation.id, { title: 'Permission review' })
    expect(repo.get(conversation.id)?.titleSource).toBe('manual')
    expect(repo.setAutoTitle(conversation.id, 'Different generated title')?.title).toBe('Permission review')
  })

  it('searches saved message content, archives without deleting, and detaches chats when a project is removed', async () => {
    const db = await openDb('search-archive.db')
    const conversations = new ConversationsRepo(db)
    const projects = new ProjectsRepo(db)
    const rootPath = path.join(tmpRoot, 'sample-project')
    const project = projects.upsert({ name: 'sample-project', rootPath })
    const conversation = conversations.create({ projectId: project.id })
    conversations.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'Please investigate the stale explorer state'
    })

    expect(conversations.search('stale explorer')).toHaveLength(1)
    expect(conversations.search('%')).toHaveLength(0)
    conversations.archive(conversation.id)
    expect(conversations.list()).toHaveLength(0)
    expect(conversations.listArchived()[0]?.id).toBe(conversation.id)
    conversations.unarchive(conversation.id)
    conversations.detachProject(project.id)
    expect(conversations.get(conversation.id)?.projectId).toBeNull()

    const renamed = projects.rename(project.id, 'Frontend workspace')
    expect(renamed?.name).toBe('Frontend workspace')
    expect(renamed?.rootPath).toBe(rootPath)
  })
})

describe('approval proposal lookup', () => {
  it('shows the target for live proposals and rejects missing proposal ids', () => {
    const projects = {
      readFile: () => ({ path: 'GUIDE.md', content: 'before', hash: 'content-hash', size: 6, truncated: false, binary: false }),
      hashFile: () => 'content-hash'
    }
    const checkpoints = { create: () => undefined }
    const edits = new EditService(projects as never, checkpoints as never)
    const proposal = edits.propose({ projectId: 'project', path: 'GUIDE.md', kind: 'write', after: 'after' })

    expect(edits.describeProposal(proposal.proposalId)).toEqual({ path: 'GUIDE.md', kind: 'write' })
    expect(edits.describeProposal('unknown-proposal')).toBeNull()
  })
})
