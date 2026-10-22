import fs from 'node:fs'
import path from 'node:path'
import type { ProductSkill } from '@shared/types'
import { getLogger } from './logger'
import type { SettingsRepo } from './store'

export interface SkillDefinition extends Omit<ProductSkill, 'enabled'> {}

export interface SaveSkillInput {
  id: string
  name: string
  description?: string
  category?: string
  instructions: string
}

/**
 * Product skills: short, user-visible instruction sets injected into the system
 * prompt.
 *
 * There are two directories on purpose. The bundled one (`product-skills/`, or
 * `resources/product-skills` in a packaged build) is part of the install and may
 * be read-only. Anything the user creates — including "Save as Skill" from a
 * successful workflow — goes to the per-user directory, so an upgrade can never
 * delete it and a read-only install still works.
 */
export class SkillsService {
  private definitions: SkillDefinition[]

  constructor(
    private readonly directory: string,
    private readonly settings: SettingsRepo,
    private readonly userDirectory?: string
  ) {
    this.definitions = this.discover()
  }

  list(): ProductSkill[] {
    const enabled = this.settings.get().skills?.enabled ?? {}
    return this.definitions.map((skill) => ({
      ...skill,
      enabled: enabled[skill.id] ?? skill.enabledByDefault
    }))
  }

  setEnabled(id: string, value: boolean): ProductSkill[] {
    if (!this.definitions.some((skill) => skill.id === id)) throw new Error('Skill not found.')
    const current = this.settings.get()
    const enabled = { ...(current.skills?.enabled ?? {}), [id]: value }
    this.settings.set({ skills: { enabled } })
    return this.list()
  }

  promptContext(): string {
    const active = this.list().filter((skill) => skill.enabled)
    if (!active.length) return ''
    const instructions = active.map((skill) => `### ${skill.name}\n${skill.instructions}`).join('\n\n')
    return `Enabled Alpha agent skills (apply when relevant):\n\n${instructions}`
  }

  /**
   * Write a new skill markdown file and make it available immediately.
   *
   * Saving is deliberately a plain file write: the same format a hand-authored
   * skill uses, in a directory the next launch reads. There is no registry to
   * update and no migration to run.
   */
  save(input: SaveSkillInput): { skills: ProductSkill[]; path: string } {
    const target = this.writableDirectory()
    fs.mkdirSync(target, { recursive: true })
    const filePath = path.join(target, `${input.id}.md`)

    const metadata = [
      '---',
      `id: ${input.id}`,
      `name: ${singleLine(input.name)}`,
      `description: ${singleLine(input.description ?? `Saved workflow: ${input.name}`)}`,
      `category: ${singleLine(input.category ?? 'Saved workflows')}`,
      'version: 1.0.0',
      'enabled-by-default: true',
      '---',
      '',
      input.instructions.trim(),
      ''
    ].join('\n')

    fs.writeFileSync(filePath, metadata, 'utf8')
    this.definitions = this.discover()

    // A saved skill that is explicitly switched off stays off; a new one is on.
    const current = this.settings.get()
    const enabled = { ...(current.skills?.enabled ?? {}) }
    if (!(input.id in enabled)) {
      enabled[input.id] = true
      this.settings.set({ skills: { enabled } })
    }

    getLogger().info('skills', `saved skill ${input.id} to ${filePath}`)
    return { skills: this.list(), path: filePath }
  }

  /** Where new skills can actually be written. */
  private writableDirectory(): string {
    if (this.userDirectory) return this.userDirectory
    // No user directory configured (tests, or a call site that opted out):
    // fall back to the bundled one and let a write error surface honestly.
    return this.directory
  }

  private discover(): SkillDefinition[] {
    const byId = new Map<string, SkillDefinition>()
    // Bundled first, then user — a user file with the same id wins.
    for (const directory of [this.directory, this.userDirectory]) {
      if (!directory) continue
      let files: string[]
      try {
        files = fs
          .readdirSync(directory)
          .filter((name) => name.toLowerCase().endsWith('.md'))
          .sort((a, b) => a.localeCompare(b))
      } catch (error) {
        // A missing user directory is normal on a fresh profile.
        if (directory === this.userDirectory && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
        getLogger().warn('skills', `could not read ${directory}: ${(error as Error).message}`)
        continue
      }
      for (const file of files) {
        try {
          const parsed = parseSkill(fs.readFileSync(path.join(directory, file), 'utf8'))
          const existing = byId.get(parsed.id)
          if (existing && directory !== this.userDirectory) {
            throw new Error(`duplicate skill id: ${parsed.id}`)
          }
          byId.set(parsed.id, parsed)
        } catch (error) {
          getLogger().warn('skills', `ignored ${file}: ${(error as Error).message}`)
        }
      }
    }
    return [...byId.values()]
  }
}

/** Front-matter values are single lines; newlines would corrupt the block. */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

export function parseSkill(source: string): SkillDefinition {
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/)
  if (!match) throw new Error('missing YAML-style metadata header')
  const metadata = new Map<string, string>()
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 1) continue
    metadata.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  const id = required(metadata, 'id')
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) throw new Error('invalid skill id')
  const instructions = match[2].trim()
  if (!instructions) throw new Error('instruction body is empty')
  return {
    id,
    name: required(metadata, 'name'),
    description: required(metadata, 'description'),
    category: required(metadata, 'category'),
    version: required(metadata, 'version'),
    enabledByDefault: metadata.get('enabled-by-default') === 'true',
    instructions
  }
}

function required(metadata: Map<string, string>, key: string): string {
  const value = metadata.get(key)
  if (!value) throw new Error(`missing ${key} metadata`)
  return value
}
