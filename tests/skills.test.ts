import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillsService } from '../src/main/services/skills'
import type { SettingsRepo } from '../src/main/services/store'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function fixture(): { service: SkillsService; set: ReturnType<typeof vi.fn> } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-skills-'))
  tempDirectories.push(directory)
  fs.writeFileSync(path.join(directory, 'review.md'), [
    '---',
    'id: code-review',
    'name: Code Review',
    'description: Review changes carefully.',
    'category: Quality',
    'version: 1.0.0',
    'enabled-by-default: true',
    '---',
    '',
    'Check the change and its tests.'
  ].join('\n'))

  let value: Record<string, unknown> = { skills: { enabled: {} } }
  const set = vi.fn((patch: Record<string, unknown>) => {
    value = { ...value, ...patch, skills: { ...(value.skills as object), ...(patch.skills as object) } }
    return value
  })
  const settings = {
    get: () => value,
    set
  } as unknown as SettingsRepo
  return { service: new SkillsService(directory, settings), set }
}

describe('SkillsService', () => {
  it('discovers skill metadata and uses the default enabled state', () => {
    const { service } = fixture()
    expect(service.list()).toMatchObject([
      { id: 'code-review', name: 'Code Review', enabled: true, instructions: 'Check the change and its tests.' }
    ])
  })

  it('persists enablement preferences and updates prompt context', () => {
    const { service, set } = fixture()
    expect(service.promptContext()).toContain('Check the change and its tests.')

    const disabled = service.setEnabled('code-review', false)
    expect(set).toHaveBeenCalledWith({ skills: { enabled: { 'code-review': false } } })
    expect(disabled[0].enabled).toBe(false)
    expect(service.promptContext()).toBe('')

    expect(service.setEnabled('code-review', true)[0].enabled).toBe(true)
    expect(service.promptContext()).toContain('### Code Review')
  })

  it('rejects unknown skill identifiers', () => {
    const { service } = fixture()
    expect(() => service.setEnabled('missing-skill', true)).toThrow('Skill not found.')
  })
})
