import fs from 'node:fs'
import path from 'node:path'
import type { ProductSkill } from '@shared/types'
import { getLogger } from './logger'
import type { SettingsRepo } from './store'

interface SkillDefinition extends Omit<ProductSkill, 'enabled'> {}

export class SkillsService {
  private readonly definitions: SkillDefinition[]

  constructor(private readonly directory: string, private readonly settings: SettingsRepo) {
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

  private discover(): SkillDefinition[] {
    let files: string[]
    try {
      files = fs.readdirSync(this.directory)
        .filter((name) => name.toLowerCase().endsWith('.md'))
        .sort((a, b) => a.localeCompare(b))
    } catch (error) {
      getLogger().warn('skills', `could not read skill directory: ${(error as Error).message}`)
      return []
    }
    const definitions: SkillDefinition[] = []
    const seen = new Set<string>()
    for (const file of files) {
      try {
        const parsed = parseSkill(fs.readFileSync(path.join(this.directory, file), 'utf8'))
        if (seen.has(parsed.id)) throw new Error(`duplicate skill id: ${parsed.id}`)
        seen.add(parsed.id)
        definitions.push(parsed)
      } catch (error) {
        getLogger().warn('skills', `ignored ${file}: ${(error as Error).message}`)
      }
    }
    return definitions
  }
}

function parseSkill(source: string): SkillDefinition {
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
