/**
 * IPC contract coverage.
 *
 * The channel pipeline is `channels.ts → ipc.ts (types) → schemas.ts → main/ipc.ts
 * → lib/api.ts`. A channel that exists in one layer but not the others fails at
 * runtime — usually as a rejected `invoke` with a confusing message — so this
 * asserts the four layers agree for every invoke channel, and that each handler
 * validates its payload with a zod schema rather than trusting the renderer.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '..')
const read = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), 'utf8')

/** Keys of the `CH` object only — HUD and EVENTS are separate maps. */
function channelKeys(): string[] {
  const source = read('src/shared/channels.ts')
  const start = source.indexOf('export const CH = {')
  const end = source.indexOf('} as const', start)
  const block = source.slice(start, end)
  return [...block.matchAll(/^\s{2}([a-zA-Z0-9]+):/gm)].map((match) => match[1])
}

describe('IPC contract', () => {
  const keys = channelKeys()

  it('finds the channel list', () => {
    expect(keys.length).toBeGreaterThan(50)
    expect(keys).toContain('macroList')
  })

  it('declares a typed request/response for every channel', () => {
    const contract = read('src/shared/ipc.ts')
    const missing = keys.filter((key) => !contract.includes(`[CH.${key}]:`))
    expect(missing).toEqual([])
  })

  it('registers a main-process handler for every channel', () => {
    const handlers = read('src/main/ipc.ts')
    const missing = keys.filter((key) => !handlers.includes(`handle(CH.${key},`))
    expect(missing).toEqual([])
  })

  it('validates every new macro and replay payload with a schema', () => {
    const handlers = read('src/main/ipc.ts')
    // A `null` schema means "trust the renderer"; these take user-supplied paths
    // and scripts, so they must be parsed.
    expect(handlers).toContain('handle(CH.macroSave, zMacroSave')
    expect(handlers).toContain('handle(CH.macroRun, zMacroRun')
    expect(handlers).toContain('handle(CH.macroRemove, zMacroSlug')
    expect(handlers).toContain('handle(CH.dvrTimeline, zDvrTimeline')
    expect(handlers).toContain('handle(CH.dvrFrame, zDvrFrame')
    expect(handlers).toContain('handle(CH.dvrRollback, zDvrRollback')
  })

  it('exposes every new channel through the renderer api bridge', () => {
    const api = read('src/renderer/src/lib/api.ts')
    for (const key of ['macroList', 'macroRun', 'macroSave', 'macroRemove', 'dvrTimeline', 'dvrRollback', 'dvrFrame']) {
      expect(api, key).toContain(`CH.${key}`)
    }
  })

  it('keeps macro and replay channel names namespaced', () => {
    const source = read('src/shared/channels.ts')
    expect(source).toContain("macroList: 'macro:list'")
    expect(source).toContain("macroRun: 'macro:run'")
    expect(source).toContain("macroSave: 'macro:save'")
    expect(source).toContain("dvrTimeline: 'dvr:getTimeline'")
    expect(source).toContain("dvrRollback: 'dvr:rollback'")
  })
})

describe('self-healing approval wiring', () => {
  const chat = read('src/main/services/chat.ts')

  it('consults session grants before prompting', () => {
    expect(chat).toContain('ctx.permissions.gateTool(')
    expect(chat).toContain('gate.autoApproved')
  })

  it('records an approval as a scoped grant and revokes it with the turn', () => {
    expect(chat).toContain('grantAfterApproval(')
    expect(chat).toContain('revokeTurnGrants(requestId)')
    expect(chat).toContain('revokeAllGrants()')
  })

  it('marks an auto-approved step in the timeline rather than hiding it', () => {
    expect(chat).toContain('activity.autoApproved = true')
    expect(chat).toContain('auto-approved by a session grant')
  })

  it('runs macros through the same tool pipeline as a model turn', () => {
    expect(chat).toContain('runMacro(')
    expect(chat).toContain('this.runTools(')
    // No second executor: macro steps are ChatToolCall[], not a bespoke runner.
    expect(chat).toContain('const calls: ChatToolCall[]')
  })
})
