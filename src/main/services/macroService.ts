/**
 * Context-aware natural-language macros.
 *
 * A macro is a parameterised, replayable tool script stored as a small `.alpha`
 * JSON file in `userData/macros`. Saving one is cheap; the value is that a
 * repeated multi-step loop becomes one deterministic dispatch instead of a
 * dozen model round-trips that can drift.
 *
 * Pure parsing/matching lives here beside the service so it can be tested
 * without touching disk or Electron.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface MacroParam {
  name: string
  description?: string
  default?: string
  required?: boolean
}

export interface MacroStep {
  tool: string
  args: Record<string, unknown>
}

export interface Macro {
  kind: 'alpha-macro'
  version: 1
  slug: string
  name: string
  description: string
  /** Example utterances; used for matching, never for execution. */
  triggers: string[]
  params: MacroParam[]
  steps: MacroStep[]
  createdAt: number
  updatedAt: number
}

export interface MacroDraft {
  name: string
  description?: string
  triggers?: string[]
  params?: MacroParam[]
  steps: MacroStep[]
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const PARAM_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*(?:\|\|\s*([^}]*))?\}\}/g

export class MacroError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

/** Stable, filesystem-safe slug. Never derived from a path. */
export function macroSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining accents before slugging: NFKD turns "é" into "e" + U+0301,
    // and the mark would otherwise become a separator ("cafe-re-sume").
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  if (!SLUG_RE.test(slug)) throw new MacroError(`Cannot derive a filename from "${name}"`, 'bad_name')
  return slug
}

export function serializeMacro(macro: Macro): string {
  return `${JSON.stringify(macro, null, 2)}\n`
}

/**
 * Parse and validate a `.alpha` file. Unknown shape is an error rather than a
 * half-usable macro: a macro that silently drops a step is worse than none.
 */
export function parseMacro(raw: string, fallbackSlug?: string): Macro {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new MacroError('Macro file is not valid JSON', 'bad_json')
  }
  if (!data || typeof data !== 'object') throw new MacroError('Macro file must be an object', 'bad_shape')
  const obj = data as Record<string, unknown>
  if (obj.kind !== 'alpha-macro') throw new MacroError('Not an Alpha macro (kind mismatch)', 'bad_kind')
  if (typeof obj.name !== 'string' || !obj.name.trim()) throw new MacroError('Macro needs a name', 'bad_name')
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new MacroError('Macro needs at least one step', 'no_steps')
  }
  const steps: MacroStep[] = obj.steps.map((step, i) => {
    if (!step || typeof step !== 'object') throw new MacroError(`Step ${i + 1} is not an object`, 'bad_step')
    const s = step as Record<string, unknown>
    if (typeof s.tool !== 'string' || !s.tool.trim()) {
      throw new MacroError(`Step ${i + 1} has no tool`, 'bad_step')
    }
    const args = s.args && typeof s.args === 'object' ? (s.args as Record<string, unknown>) : {}
    return { tool: s.tool, args }
  })
  const params: MacroParam[] = Array.isArray(obj.params)
    ? obj.params
        .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
        .map((p) => ({
          name: String(p.name ?? ''),
          description: typeof p.description === 'string' ? p.description : undefined,
          default: typeof p.default === 'string' ? p.default : undefined,
          required: p.required === true
        }))
        .filter((p) => p.name)
    : []
  const slugSource = typeof obj.slug === 'string' && obj.slug ? obj.slug : fallbackSlug ?? macroSlug(obj.name)
  if (!SLUG_RE.test(slugSource)) throw new MacroError(`Bad macro slug "${slugSource}"`, 'bad_slug')
  return {
    kind: 'alpha-macro',
    version: 1,
    slug: slugSource,
    name: obj.name,
    description: typeof obj.description === 'string' ? obj.description : '',
    triggers: Array.isArray(obj.triggers) ? obj.triggers.filter((t): t is string => typeof t === 'string') : [],
    params,
    steps,
    createdAt: Number(obj.createdAt) || 0,
    updatedAt: Number(obj.updatedAt) || 0
  }
}

/** Replace `{{name}}` / `{{name||fallback}}` throughout a step's arguments. */
export function substituteValue(value: unknown, params: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(PARAM_RE, (_match, name: string, fallback: string | undefined) => {
      const provided = params[name]
      if (provided !== undefined && provided !== '') return provided
      if (fallback !== undefined) return fallback
      return ''
    })
  }
  if (Array.isArray(value)) return value.map((item) => substituteValue(item, params))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = substituteValue(inner, params)
    }
    return out
  }
  return value
}

export interface MacroRender {
  steps: MacroStep[]
  missing: string[]
}

/** Resolve a macro's steps, reporting required params nobody supplied. */
export function renderMacro(macro: Macro, params: Record<string, string> = {}): MacroRender {
  const effective: Record<string, string> = { ...params }
  const missing: string[] = []
  for (const param of macro.params) {
    if (effective[param.name]) continue
    if (param.default !== undefined) {
      effective[param.name] = param.default
      continue
    }
    if (param.required) missing.push(param.name)
  }
  const steps = macro.steps.map((step) => ({
    tool: step.tool,
    args: substituteValue(step.args, effective) as Record<string, unknown>
  }))
  return { steps, missing }
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'then', 'to', 'of', 'for', 'in', 'on', 'my', 'me',
  'it', 'this', 'that', 'with', 'please', 'can', 'you', 'run', 'do'
])

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

/**
 * Lexical score in [0,1] between a user prompt and a macro's triggers/name.
 * Deliberately conservative: a wrong auto-dispatch is worse than a miss, since
 * the model can still reach the macro explicitly.
 */
export function scoreMacro(prompt: string, macro: Macro): number {
  const promptTokens = new Set(tokens(prompt))
  if (!promptTokens.size) return 0
  const targets = [macro.name, macro.description, ...macro.triggers].filter(Boolean).map((t) => new Set(tokens(t)))
  let best = 0
  for (const target of targets) {
    if (!target.size) continue
    let shared = 0
    for (const token of promptTokens) if (target.has(token)) shared++
    best = Math.max(best, shared / Math.max(target.size, 1))
  }
  return Math.min(best, 1)
}

export function matchMacros(prompt: string, macros: Macro[], threshold = 0.6): Array<{ macro: Macro; score: number }> {
  return macros
    .map((macro) => ({ macro, score: scoreMacro(prompt, macro) }))
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score)
}

export interface MacroServiceDeps {
  dir: string
  now?: () => number
}

/**
 * File-backed store. The directory is the only writable location, and every
 * filename comes from a validated slug — a macro can never write outside it.
 */
export class MacroService {
  private now: () => number

  constructor(private deps: MacroServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  private ensureDir(): void {
    fs.mkdirSync(this.deps.dir, { recursive: true })
  }

  private fileFor(slug: string): string {
    if (!SLUG_RE.test(slug)) throw new MacroError(`Bad macro slug "${slug}"`, 'bad_slug')
    return path.join(this.deps.dir, `${slug}.alpha`)
  }

  list(): Macro[] {
    this.ensureDir()
    const macros: Macro[] = []
    for (const name of fs.readdirSync(this.deps.dir)) {
      if (!name.endsWith('.alpha')) continue
      try {
        macros.push(parseMacro(fs.readFileSync(path.join(this.deps.dir, name), 'utf8'), name.slice(0, -6)))
      } catch {
        // One unreadable macro must not hide the rest.
      }
    }
    return macros.sort((a, b) => a.name.localeCompare(b.name))
  }

  get(slug: string): Macro | null {
    const file = this.fileFor(slug)
    if (!fs.existsSync(file)) return null
    return parseMacro(fs.readFileSync(file, 'utf8'), slug)
  }

  save(draft: MacroDraft): Macro {
    if (!draft.steps?.length) throw new MacroError('A macro needs at least one step', 'no_steps')
    const slug = macroSlug(draft.name)
    const existing = this.get(slug)
    const now = this.now()
    const macro: Macro = {
      kind: 'alpha-macro',
      version: 1,
      slug,
      name: draft.name.trim(),
      description: draft.description?.trim() ?? '',
      triggers: draft.triggers?.filter((t) => t.trim()) ?? [],
      params: draft.params ?? [],
      steps: draft.steps,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    this.ensureDir()
    fs.writeFileSync(this.fileFor(slug), serializeMacro(macro), 'utf8')
    return macro
  }

  remove(slug: string): boolean {
    const file = this.fileFor(slug)
    if (!fs.existsSync(file)) return false
    fs.rmSync(file, { force: true })
    return true
  }

  /** Best-effort match for a free-text prompt, used to offer a shortcut. */
  match(prompt: string, threshold = 0.6): Array<{ macro: Macro; score: number }> {
    return matchMacros(prompt, this.list(), threshold)
  }

  render(slug: string, params: Record<string, string> = {}): MacroRender & { macro: Macro } {
    const macro = this.get(slug)
    if (!macro) throw new MacroError(`No macro named "${slug}"`, 'not_found')
    return { macro, ...renderMacro(macro, params) }
  }
}
