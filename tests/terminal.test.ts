import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectService } from '../src/main/services/projectService'
import type { PermissionService } from '../src/main/services/permissionService'
import { assessCommand, TerminalService } from '../src/main/services/terminal'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createTerminal(root: string): TerminalService {
  const projects = { resolveProject: () => ({ rootPath: root }) } as unknown as ProjectService
  const permissions = { resolve: () => 'allow' } as unknown as PermissionService
  return new TerminalService(projects, permissions)
}

describe('TerminalService', () => {
  it('classifies commands that install packages or access the network', () => {
    expect(assessCommand('npm install react').packageInstall).toBe(true)
    expect(assessCommand('git pull').network).toBe(true)
    expect(assessCommand('npm test').destructive).toBe(false)
  })

  it('runs in the project root and reports an explicit cancellation', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'alpha-terminal-'))
    roots.push(root)
    const terminal = createTerminal(root)
    const events: import('../src/shared/types').TerminalEvent[] = []
    let finish!: (event: import('../src/shared/types').TerminalEvent) => void
    const exited = new Promise<import('../src/shared/types').TerminalEvent>((resolve) => {
      finish = resolve
    })
    const command = `"${process.execPath}" -e "console.log(process.cwd()); setInterval(() => {}, 1000)"`
    const runId = randomUUID()
    const run = terminal.run({ runId, projectId: 'sample', command, approved: true }, (event) => {
      events.push(event)
      if (event.type === 'exit') finish(event)
    })
    expect(run.runId).toBe(runId)
    expect(run.cwd).toBe(root)
    expect(events[0]).toMatchObject({ type: 'start', cwd: root })

    try {
      const stdoutDeadline = Date.now() + 5000
      while (!events.some((event) => event.type === 'stdout') && Date.now() < stdoutDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(events.some((event) => event.type === 'stdout' && event.data.includes(root))).toBe(true)
      expect(terminal.cancel(run.runId)).toBe(true)
      const exit = await new Promise<import('../src/shared/types').TerminalEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('terminal process did not exit')), 7000)
        void exited.then((event) => {
          clearTimeout(timer)
          resolve(event)
        })
      })
      expect(exit).toMatchObject({ type: 'exit', cancelled: true })
    } finally {
      terminal.cancel(run.runId)
    }
  })
})
