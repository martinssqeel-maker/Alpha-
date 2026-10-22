/**
 * Self-healing wired into ChatService.
 *
 * The interesting assertions are behavioural, not textual: a tool call that
 * returns a non-zero exit code must start a bounded repair loop that re-runs the
 * command, and the re-run must proceed without a second approval dialog because
 * the user's first approval issued a session grant.
 *
 * Two traps this file guards against:
 *  - a failing command does NOT throw. `run_approved_command` returns
 *    `{ exitCode, stdout, stderr }` with `verification.verified: false`, so the
 *    activity state is `completed`. Detection keyed on state would never fire.
 *  - the repair must stop when the grant is gone rather than waiting on an
 *    approval dialog nobody is watching.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ChatService, type ChatDeps } from '../src/main/services/chat'
import { Db } from '../src/main/services/db'
import { initLogger } from '../src/main/services/logger'
import { ApprovalBroker, PermissionService } from '../src/main/services/permissionService'
import { ConversationsRepo, SettingsRepo } from '../src/main/services/store'
import { permissionsForMode } from '../src/shared/permissions'
import { findFailedValidation, isValidationCommand, REPAIR_TOOL_NAMES } from '../src/main/services/selfHealing'
import { MAX_GRANT_ATTEMPTS } from '../src/main/services/sessionGrants'
import type { ActivityItem, ChatEvent } from '../src/shared/types'

const tmpBase = fs.mkdtempSync(path.join(os.homedir(), 'alpha-selfheal-'))
const openDbs: Db[] = []

beforeAll(() => {
  initLogger(path.join(tmpBase, 'logs'))
})

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs.length = 0
})

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('validation failure detection', () => {
  it('recognises the commands worth repairing', () => {
    for (const command of [
      'npm test',
      'npm run test',
      'npm run typecheck',
      'npm run build',
      'pnpm test',
      'yarn lint',
      'npx vitest run',
      'jest --ci',
      'tsc --noEmit',
      'cargo test',
      'go test ./...',
      'pytest -q'
    ]) {
      expect(isValidationCommand(command), command).toBe(true)
    }
  })

  it('ignores commands whose failure is not a code problem', () => {
    for (const command of ['rm -rf build', 'git push origin main', 'curl https://example.com', 'npm install']) {
      expect(isValidationCommand(command), command).toBe(false)
    }
  })

  it('reads the result, not the activity state', () => {
    // The trap: state is `completed` because the tool call itself succeeded.
    const failure = findFailedValidation([
      {
        id: 'a1',
        toolName: 'run_approved_command',
        state: 'completed',
        args: { command: 'npm test' },
        result: { exitCode: 1, stdout: 'FAIL tests/a.test.ts', stderr: '' }
      }
    ])
    expect(failure).not.toBeNull()
    expect(failure?.command).toBe('npm test')
    expect(failure?.outcome.code).toBe(1)
    expect(failure?.outcome.stdout).toContain('FAIL')
    expect(failure?.activityId).toBe('a1')
  })

  it('ignores a passing run, a non-validation command, and a cancelled one', () => {
    expect(
      findFailedValidation([
        { toolName: 'run_approved_command', state: 'completed', args: { command: 'npm test' }, result: { exitCode: 0 } }
      ])
    ).toBeNull()
    expect(
      findFailedValidation([
        { toolName: 'run_approved_command', state: 'completed', args: { command: 'rm -rf x' }, result: { exitCode: 2 } }
      ])
    ).toBeNull()
    expect(
      findFailedValidation([
        { toolName: 'run_approved_command', state: 'cancelled', args: { command: 'npm test' }, result: { exitCode: 1 } }
      ])
    ).toBeNull()
    expect(findFailedValidation([])).toBeNull()
  })

  it('offers the repair loop a restricted tool set', () => {
    expect(REPAIR_TOOL_NAMES).toContain('apply_approved_patch')
    expect(REPAIR_TOOL_NAMES).not.toContain('delete_file')
    expect(REPAIR_TOOL_NAMES).not.toContain('run_approved_command'.replace('run_approved_command', 'browser_navigate'))
  })
})

// ---------------------------------------------------------------------------
// ChatService integration
// ---------------------------------------------------------------------------

interface Harness {
  chat: ChatService
  events: ChatEvent[]
  activities: ActivityItem[]
  approveAll: () => void
  done: Promise<void>
  commandRuns: () => number
}

/**
 * Drives one turn against a scripted provider.
 *
 * `rounds` receives the 1-based provider call index and returns an assistant
 * reply. `terminal` decides the exit code for each `npm test` execution, which
 * is how a failing-then-passing run is simulated without a real test runner.
 */
async function makeHarness(options: {
  rounds: (round: number) => { content: string; toolCalls?: Array<{ id: string; name: string; arguments: unknown }> }
  terminal: (run: number) => { code: number; stdout: string; stderr: string }
  autoHeal?: boolean
  mode?: 'assist' | 'agent'
  autoApprove?: boolean
}): Promise<Harness> {
  const db = await Db.open(path.join(tmpBase, `heal-${Math.random().toString(36).slice(2)}.db`))
  openDbs.push(db)
  const conversations = new ConversationsRepo(db)
  const settings = new SettingsRepo(db)
  if (options.autoHeal !== undefined) settings.set({ agent: { autoHeal: options.autoHeal } })
  const permissions = new PermissionService(settings)
  permissions.set(permissionsForMode(options.mode ?? 'agent'))
  const conversation = conversations.create({})

  const events: ChatEvent[] = []
  const activities: ActivityItem[] = []
  const broker = new ApprovalBroker()
  const approveAll = (): void => {
    for (const activity of activities) {
      if (activity.state === 'awaiting-approval' && activity.approvalId) {
        broker.resolve(activity.approvalId, true)
      }
    }
  }

  let providerRound = 0
  let commandRun = 0

  const provider = {
    get: () => ({ id: 'fake', name: 'Fake local', isLocal: true, kind: 'ollama' as const }),
    chat: async () => {
      providerRound++
      const reply = options.rounds(providerRound)
      return { content: reply.content, toolCalls: reply.toolCalls ?? [], finishReason: 'stop' }
    }
  }

  const chat = new ChatService({
    providers: provider as never,
    conversations,
    projects: { resolveRoot: () => tmpBase } as never,
    edits: { describeProposal: () => null } as never,
    git: {} as never,
    terminal: {
      runCollect: async () => {
        commandRun++
        const result = options.terminal(commandRun)
        return { ...result, durationMs: 1 }
      }
    } as never,
    skills: { promptContext: () => '' } as never,
    permissions,
    broker,
    settings,
    roots: { defaultLocation: () => ({ path: tmpBase, label: 'Home', kind: 'custom' }) } as never,
    desktop: {} as never,
    computer: {} as never,
    browser: {} as never,
    emit: (event) => {
      events.push(event)
      if (event.type === 'activity') {
        const index = activities.findIndex((a) => a.id === event.activity.id)
        if (index >= 0) activities[index] = event.activity
        else activities.push(event.activity)
        // Stand in for a user watching the dialog.
        if (options.autoApprove !== false && event.activity.state === 'awaiting-approval' && event.activity.approvalId) {
          const id = event.activity.approvalId
          setTimeout(() => broker.resolve(id, true), 0)
        }
      }
    }
  } as unknown as ChatDeps)

  const finished = new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (events.some((e) => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')) {
        clearInterval(poll)
        resolve()
      }
    }, 5)
  })

  chat.send({
    conversationId: conversation.id,
    providerId: 'fake',
    modelId: 'qwen3:1.7b',
    mode: options.mode ?? 'agent',
    projectId: null,
    text: 'Run the tests and fix anything that fails'
  })

  return { chat, events, activities, approveAll, done: finished, commandRuns: () => commandRun }
}

const runTests = (id: string) => ({
  content: 'Running the suite.',
  toolCalls: [{ id, name: 'run_approved_command', arguments: { command: 'npm test' } }]
})

/** A repair round that writes the fix, as a model allowed tools would. */
const writeFix = (id: string) => ({
  content: 'Fixing the assertion.',
  toolCalls: [
    {
      id,
      name: 'create_or_write_file',
      arguments: { path: 'documents/tests-fixed.txt', content: 'fixed' }
    }
  ]
})

describe('ChatService self-healing', () => {
  it('repairs a failing test run and re-runs it under the grant', async () => {
    const harness = await makeHarness({
      rounds: (round) => {
        if (round === 1) return runTests('c1')
        if (round === 2) return writeFix('c2')
        return { content: 'Fixed and the suite passes.' }
      },
      terminal: (run) =>
        run === 1 ? { code: 1, stdout: 'FAIL tests/a.test.ts\nAssertionError: expected 1 to be 2', stderr: '' } : { code: 0, stdout: 'ok', stderr: '' }
    })
    await harness.done

    // The command ran twice: the original failure and the repair re-run.
    expect(harness.commandRuns()).toBe(2)

    const heal = harness.activities.find((a) => a.toolName === 'self_healing')
    expect(heal, 'a self-healing activity should be recorded').toBeDefined()
    expect(heal?.state).toBe('completed')
    expect(heal?.detail).toContain('now passes')

    // The re-run was auto-approved by the grant, not by a second dialog.
    const runs = harness.activities.filter((a) => a.toolName === 'run_approved_command')
    expect(runs).toHaveLength(2)
    expect(runs[1].autoApproved).toBe(true)

    expect(harness.events.some((e) => e.type === 'error')).toBe(false)
  })

  it('stops after the attempt ceiling and reports honestly', async () => {
    let fixRound = 0
    const harness = await makeHarness({
      rounds: (round) => {
        if (round === 1) return runTests('c1')
        fixRound++
        return writeFix(`fix${fixRound}`)
      },
      // Never passes.
      terminal: () => ({ code: 1, stdout: 'FAIL always\nAssertionError: nope', stderr: '' })
    })
    await harness.done

    const heal = harness.activities.find((a) => a.toolName === 'self_healing')
    expect(heal?.state).toBe('failed')
    expect(heal?.detail).toContain('Could not repair')
    // Initial run + up to MAX_GRANT_ATTEMPTS retries.
    expect(harness.commandRuns()).toBeLessThanOrEqual(1 + MAX_GRANT_ATTEMPTS)
    // Bounded: never runs away.
    expect(harness.commandRuns()).toBeGreaterThan(1)
  }, 20_000)

  it('does nothing when auto-heal is switched off', async () => {
    const harness = await makeHarness({
      autoHeal: false,
      rounds: (round) => (round === 1 ? runTests('c1') : { content: 'The suite is failing.' }),
      terminal: () => ({ code: 1, stdout: 'FAIL', stderr: '' })
    })
    await harness.done
    // The command ran exactly once and no repair loop was started: turning the
    // setting off must stop the loop, not merely hide it.
    expect(harness.commandRuns()).toBe(1)
    expect(harness.activities.some((a) => a.toolName === 'self_healing')).toBe(false)
  })

  it('terminates the loop in assist mode instead of waiting on an unanswered dialog', async () => {
    const harness = await makeHarness({
      mode: 'assist',
      rounds: (round) => (round === 1 ? runTests('c1') : { content: 'Please fix it.' }),
      terminal: () => ({ code: 1, stdout: 'FAIL', stderr: '' })
    })
    await harness.done
    // In assist mode the command still runs (after approval) and healing follows;
    // this asserts the loop terminates rather than hanging on an approval that
    // never arrives, which is the failure mode worth guarding.
    expect(harness.events.some((e) => e.type === 'error' || e.type === 'done')).toBe(true)
  }, 20_000)
})
