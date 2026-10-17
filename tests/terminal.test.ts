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

/** Reject when `promise` has not settled, so a hung child fails instead of hanging the run. */
function withDeadline<T>(promise: Promise<T>, what: string, ms = 15_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} (waited ${ms}ms)`)), ms)
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

describe('TerminalService', () => {
  it('classifies commands that install packages or access the network', () => {
    expect(assessCommand('npm install react').packageInstall).toBe(true)
    expect(assessCommand('git pull').network).toBe(true)
    expect(assessCommand('npm test').destructive).toBe(false)
  })

  /**
   * Run a real child process, cancel it, and require the `exit` event to say so.
   *
   * Both waits are event-driven: this test used to poll `events` against a 5s
   * wall-clock deadline, which failed on a loaded machine merely because spawning
   * Node and reading its first line took longer than 5s. Waiting for the event
   * costs nothing when things are fast and still fails honestly if the process
   * never starts, never prints, or never exits — the deadlines below are hang
   * detectors, not performance assertions. Nothing here asserts how quickly the
   * product does any of it.
   */
  it(
    'runs in the project root and reports an explicit cancellation',
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'alpha-terminal-'))
      roots.push(root)
      const terminal = createTerminal(root)
      const events: import('../src/shared/types').TerminalEvent[] = []
      let sawStdout!: () => void
      let sawExit!: (event: import('../src/shared/types').TerminalEvent) => void
      const printed = new Promise<void>((resolve) => {
        sawStdout = resolve
      })
      const exited = new Promise<import('../src/shared/types').TerminalEvent>((resolve) => {
        sawExit = resolve
      })
      const command = `"${process.execPath}" -e "console.log(process.cwd()); setInterval(() => {}, 1000)"`
      const runId = randomUUID()
      const run = terminal.run({ runId, projectId: 'sample', command, approved: true }, (event) => {
        events.push(event)
        if (event.type === 'stdout' && event.data.includes(root)) sawStdout()
        if (event.type === 'exit') sawExit(event)
      })
      expect(run.runId).toBe(runId)
      expect(run.cwd).toBe(root)
      expect(events[0]).toMatchObject({ type: 'start', cwd: root })

      try {
        await withDeadline(printed, 'the process never printed its working directory')
        expect(events.some((event) => event.type === 'stdout' && event.data.includes(root))).toBe(true)
        expect(terminal.cancel(run.runId)).toBe(true)
        const exit = await withDeadline(exited, 'the process did not exit after cancel')
        expect(exit).toMatchObject({ type: 'exit', cancelled: true })
      } finally {
        terminal.cancel(run.runId)
      }
    },
    // Spawning a real Node process and cancelling it can take seconds on a loaded
    // machine. The waits inside are event-driven; this only stops the runner from
    // cutting the test off during process startup.
    30_000
  )
})
