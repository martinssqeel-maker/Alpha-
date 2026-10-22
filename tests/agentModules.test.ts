/**
 * The seven autonomous-agent modules.
 *
 * These tests are pure and offline: no Electron, no PowerShell, no Ollama, no
 * whisper binary. Where a module needs the outside world it takes an injected
 * dependency, which is exactly what is stubbed here. The memory graph runs
 * against a real sql.js database so the v3 migration is exercised rather than
 * mocked.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Db } from '../src/main/services/db'
import { initLogger } from '../src/main/services/logger'
import {
  MemoryGraph,
  chunkText,
  contentHash,
  cosine,
  fromBlob,
  hashEmbedding,
  toBlob
} from '../src/main/services/memoryGraph'
import {
  MacroService,
  buildMacroDraft,
  macroSlug,
  matchMacros,
  parseMacro,
  renderMacro,
  scoreMacro,
  serializeMacro,
  substituteValue,
  suggestMacroName
} from '../src/main/services/macroService'
import { DvrService, MAX_TEXT_CHARS, truncateFrameText } from '../src/main/services/dvrService'
import {
  SelfHealingLoop,
  buildRepairPrompt,
  classifyFailure,
  extractFiles,
  extractHighlights,
  truncate
} from '../src/main/services/selfHealing'
import {
  SwarmRunner,
  buildSwarmPlan,
  extractFindings,
  parseProposedFiles,
  parseVerdict,
  summarizeOutcome
} from '../src/main/services/swarmService'
import {
  WatcherService,
  debounceMs,
  isDue,
  nextRunAt,
  parseDailyAt,
  validateTrigger,
  WatcherError
} from '../src/main/services/watcherService'
import {
  VoiceService,
  buildFfmpegArgs,
  buildWhisperArgs,
  decodeAudioBase64,
  extensionFor,
  parseWhisperOutput
} from '../src/main/services/voiceService'

const tmpBase = fs.mkdtempSync(path.join(os.homedir(), 'alpha-agent-modules-'))

beforeAll(() => {
  initLogger(path.join(tmpBase, 'logs'))
})

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Module 7 — semantic memory graph
// ---------------------------------------------------------------------------

describe('memory graph — embedding primitives', () => {
  it('produces a deterministic, L2-normalised vector', () => {
    const a = hashEmbedding('resolve the failing vitest suite')
    const b = hashEmbedding('resolve the failing vitest suite')
    expect(a).toEqual(b)
    expect(a).toHaveLength(128)
    const norm = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0))
    expect(norm).toBeCloseTo(1, 6)
  })

  it('treats case and whitespace the same', () => {
    expect(hashEmbedding('Run   TESTS')).toEqual(hashEmbedding('run tests'))
  })

  it('scores identical text above unrelated text', () => {
    const query = hashEmbedding('path guard blocks system directories')
    expect(cosine(query, hashEmbedding('path guard blocks system directories'))).toBeCloseTo(1, 6)
    expect(cosine(query, hashEmbedding('lunch plans for tuesday'))).toBeLessThan(0.4)
  })

  it('round-trips vectors through a BLOB', () => {
    const vector = [0.25, -1.5, 0, 3.75]
    expect(fromBlob(toBlob(vector))).toEqual(vector)
    expect(fromBlob(null)).toEqual([])
  })

  it('chunks long text on boundaries and keeps a small overlap', () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'x'.repeat(60)}`).join('\n\n')
    const chunks = chunkText(paragraphs, 400, 40)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length <= 400)).toBe(true)
    expect(chunkText('   ')).toEqual([])
    expect(chunkText('short')).toEqual(['short'])
  })

  it('hashes content stably', () => {
    expect(contentHash('same')).toBe(contentHash('same'))
    expect(contentHash('same')).not.toBe(contentHash('different'))
  })
})

describe('memory graph — storage and recall', () => {
  let db: Db
  let memory: MemoryGraph

  beforeAll(async () => {
    db = await Db.open(path.join(tmpBase, 'memory.db'))
    memory = new MemoryGraph({ db })
  })

  afterAll(() => {
    db.close()
  })

  it('creates the memory table through the migration', () => {
    const row = db.one<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_chunks'"
    )
    expect(row?.name).toBe('memory_chunks')
  })

  it('stores a memory and finds it again by meaning-ish overlap', async () => {
    const stored = await memory.remember({
      kind: 'solution',
      text: 'The pathGuard blocks system directories; authorize a user folder instead.',
      meta: 'src/main/services/pathGuard.ts'
    })
    expect(stored).toBe(1)
    const hits = await memory.search('why is pathguard blocking my folder')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].text).toContain('pathGuard')
    expect(hits[0].meta).toContain('pathGuard.ts')
  })

  it('is idempotent for identical text under the same kind', async () => {
    await memory.remember({ kind: 'preference', text: 'prefers tabs over spaces' })
    await memory.remember({ kind: 'preference', text: 'prefers tabs over spaces' })
    const stats = memory.stats()
    expect(stats.byKind.preference).toBe(1)
  })

  it('applies weight as a recall multiplier', async () => {
    await memory.remember({ kind: 'note', text: 'deploy step is manual', weight: 1 })
    await memory.remember({ kind: 'preference', text: 'deploy step is manual always ask', weight: 9 })
    const hits = await memory.search('deploy step')
    expect(hits[0].weight).toBeGreaterThan(1)
  })

  it('filters by kind', async () => {
    const hits = await memory.search('pathguard', { kind: 'preference' })
    expect(hits.every((hit) => hit.kind === 'preference')).toBe(true)
  })

  it('respects the limit and returns nothing for an empty query', async () => {
    expect(await memory.search('deploy', { limit: 1 })).toHaveLength(1)
    expect(await memory.search('   ')).toEqual([])
  })

  it('builds a bounded context block for the system prompt', async () => {
    const block = await memory.contextBlock('pathguard folder', 200)
    expect(block.length).toBeLessThanOrEqual(260)
    expect(block).toContain('Relevant memory')
  })

  it('prunes down to the row budget', async () => {
    const before = memory.stats().total
    const removed = memory.prune(Math.max(before - 1, 1))
    expect(removed).toBeGreaterThan(0)
    expect(memory.stats().total).toBeLessThan(before)
  })

  it('clears everything on request', () => {
    memory.clear()
    expect(memory.stats().total).toBe(0)
  })

  it('falls back to hashed embeddings when the provider throws', async () => {
    const failing = new MemoryGraph({
      db,
      embedder: {
        embed: async () => {
          throw new Error('ollama is down')
        }
      }
    })
    await failing.remember({ kind: 'note', text: 'fallback still remembers this' })
    const hits = await failing.search('fallback remembers')
    expect(hits.length).toBeGreaterThan(0)
  })

  it('reports semantic capability honestly', () => {
    expect(new MemoryGraph({ db }).semanticEnabled).toBe(false)
    expect(new MemoryGraph({ db, embedder: { embed: async () => [[1]] } }).semanticEnabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Module 3 — natural-language macros
// ---------------------------------------------------------------------------

describe('macros — format and rendering', () => {
  const draft = {
    name: 'Run tests then commit',
    description: 'Validate and commit',
    triggers: ['run tests and commit'],
    params: [
      { name: 'message', required: true },
      { name: 'branch', default: 'main' }
    ],
    steps: [
      { tool: 'run_approved_command', args: { command: 'npm test' } },
      {
        tool: 'run_approved_command',
        args: { command: 'git commit -m "{{message}}" && git push origin {{branch}}' }
      }
    ]
  }

  it('derives a safe slug and rejects unusable names', () => {
    expect(macroSlug('Run tests then commit!')).toBe('run-tests-then-commit')
    expect(() => macroSlug('///')).toThrow()
    expect(macroSlug('Café résumé')).toBe('cafe-resume')
  })

  it('round-trips through .alpha JSON', () => {
    const service = new MacroService({ dir: path.join(tmpBase, 'macros-rt'), now: () => 5 })
    const saved = service.save(draft)
    const parsed = parseMacro(serializeMacro(saved), saved.slug)
    expect(parsed.name).toBe(draft.name)
    expect(parsed.steps).toHaveLength(2)
    expect(parsed.params[0]).toMatchObject({ name: 'message', required: true })
  })

  it('refuses a malformed macro instead of half-loading it', () => {
    expect(() => parseMacro('{')).toThrow(/not valid JSON/)
    expect(() => parseMacro(JSON.stringify({ kind: 'other', name: 'x', steps: [] }))).toThrow()
    expect(() => parseMacro(JSON.stringify({ kind: 'alpha-macro', name: 'x', steps: [] }))).toThrow(/at least one step/)
    expect(() =>
      parseMacro(JSON.stringify({ kind: 'alpha-macro', name: 'x', steps: [{ args: {} }] }))
    ).toThrow(/no tool/)
  })

  it('substitutes parameters, including a defaulted fallback', () => {
    expect(substituteValue('hi {{name}}', { name: 'Bob' })).toBe('hi Bob')
    expect(substituteValue('{{missing}}', {})).toBe('')
    expect(substituteValue('{{missing||fallback}}', {})).toBe('fallback')
    expect(substituteValue(['{{a}}', { b: '{{a}}' }], { a: 'x' })).toEqual(['x', { b: 'x' }])
    expect(substituteValue(42, {})).toBe(42)
  })

  it('reports missing required parameters and applies defaults', () => {
    const macro = parseMacro(
      serializeMacro(new MacroService({ dir: path.join(tmpBase, 'macros-render') }).save(draft)),
      'run-tests-then-commit'
    )
    const missing = renderMacro(macro, {})
    expect(missing.missing).toEqual(['message'])
    const ok = renderMacro(macro, { message: 'fix: thing' })
    expect(ok.missing).toEqual([])
    expect(ok.steps[1].args.command).toContain('fix: thing')
    expect(ok.steps[1].args.command).toContain('origin main')
  })

  it('scores and matches a prompt against triggers', () => {
    const macro = parseMacro(
      serializeMacro(new MacroService({ dir: path.join(tmpBase, 'macros-score') }).save(draft))
    )
    expect(scoreMacro('please run tests and commit', macro)).toBeGreaterThan(0.5)
    expect(scoreMacro('what is the weather in abuja', macro)).toBeLessThan(0.2)
    expect(matchMacros('run tests and commit', [macro], 0.5)).toHaveLength(1)
    expect(matchMacros('unrelated entirely', [macro])).toHaveLength(0)
  })
})

describe('macros — file store', () => {
  it('saves, lists, loads and removes, never escaping its directory', () => {
    const dir = path.join(tmpBase, 'macros-store')
    const service = new MacroService({ dir, now: () => 100 })
    const saved = service.save({
      name: 'Daily report',
      steps: [{ tool: 'create_or_write_file', args: { path: 'documents/report.md' } }]
    })
    expect(fs.existsSync(path.join(dir, `${saved.slug}.alpha`))).toBe(true)
    expect(service.list().map((m) => m.slug)).toContain('daily-report')
    expect(service.get(saved.slug)?.name).toBe('Daily report')
    expect(() => service.get('../escape')).toThrow()
    expect(service.remove(saved.slug)).toBe(true)
    expect(service.remove(saved.slug)).toBe(false)
    expect(service.list()).toEqual([])
  })

  it('preserves createdAt across edits and bumps updatedAt', () => {
    const service = new MacroService({ dir: path.join(tmpBase, 'macros-edit'), now: () => 10 })
    const first = service.save({ name: 'Edit me', steps: [{ tool: 'a', args: {} }] })
    const second = new MacroService({ dir: path.join(tmpBase, 'macros-edit'), now: () => 99 }).save({
      name: 'Edit me',
      steps: [{ tool: 'b', args: {} }]
    })
    expect(second.createdAt).toBe(10)
    expect(second.updatedAt).toBe(99)
    expect(first.slug).toBe(second.slug)
  })

  it('skips an unreadable macro without hiding the valid ones', () => {
    const dir = path.join(tmpBase, 'macros-bad')
    const service = new MacroService({ dir })
    service.save({ name: 'Good', steps: [{ tool: 'a', args: {} }] })
    fs.writeFileSync(path.join(dir, 'broken.alpha'), '{not json', 'utf8')
    expect(service.list().map((m) => m.name)).toEqual(['Good'])
  })
})

// ---------------------------------------------------------------------------
// Module 6 — replay buffer
// ---------------------------------------------------------------------------

describe('DVR — bounded replay buffer', () => {
  it('evicts by byte budget, keeping the newest frames', () => {
    const dvr = new DvrService({ budgetBytes: 4_000, maxFrames: 100, now: () => 1 })
    for (let i = 0; i < 20; i++) dvr.push({ kind: 'terminal', label: `cmd ${i}`, text: 'x'.repeat(500) })
    const size = dvr.size()
    expect(size.bytes).toBeLessThanOrEqual(4_000)
    expect(size.frames).toBeLessThan(20)
    expect(dvr.timeline()[dvr.timeline().length - 1].label).toBe('cmd 19')
  })

  it('evicts by frame count too', () => {
    const dvr = new DvrService({ budgetBytes: 10_000_000, maxFrames: 5 })
    for (let i = 0; i < 12; i++) dvr.push({ kind: 'note', text: `n${i}` })
    expect(dvr.size().frames).toBe(5)
    expect(dvr.timeline()[0].text).toBe('n7')
  })

  it('truncates oversized output and keeps both ends', () => {
    const long = `${'A'.repeat(MAX_TEXT_CHARS)}TAIL`
    const text = truncateFrameText(long)
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS + 40)
    expect(text).toContain('chars omitted')
    expect(text.endsWith('TAIL')).toBe(true)
  })

  it('refuses to hold an oversized screenshot payload', () => {
    const dvr = new DvrService()
    const frame = dvr.push({ kind: 'snapshot', image: 'x'.repeat(2_000_000), detail: { window: 'Notepad' } })
    expect(frame.image).toBeUndefined()
    expect(frame.detail).toMatchObject({ imageOmitted: true, window: 'Notepad' })
  })

  it('supports scrubbing and windowed timelines', () => {
    const dvr = new DvrService()
    const a = dvr.push({ kind: 'tool', label: 'a' })
    const b = dvr.push({ kind: 'tool', label: 'b' })
    dvr.push({ kind: 'tool', label: 'c' })
    expect(dvr.step(a.id, 1)?.label).toBe('b')
    expect(dvr.step(a.id, -1)).toBeNull()
    expect(dvr.get(b.id)?.label).toBe('b')
    expect(dvr.timeline({ fromId: b.id }).map((f) => f.label)).toEqual(['b', 'c'])
    expect(dvr.timeline({ limit: 1 }).map((f) => f.label)).toEqual(['c'])
  })

  it('redacts screenshots on export and keeps the rest', () => {
    const dvr = new DvrService()
    dvr.push({ kind: 'snapshot', image: 'abc', detail: { window: 'Word' } })
    const exported = dvr.exportRedacted()
    expect(exported[0].image).toBeUndefined()
    expect(exported[0].detail).toMatchObject({ window: 'Word', imageOmitted: true })
  })

  it('clears on demand', () => {
    const dvr = new DvrService()
    dvr.push({ kind: 'note', text: 'x' })
    dvr.clear()
    expect(dvr.size()).toMatchObject({ frames: 0, bytes: 0 })
  })
})

// ---------------------------------------------------------------------------
// Module 1 — self-healing loop
// ---------------------------------------------------------------------------

describe('self-healing — failure analysis', () => {
  const outcome = (code: number, stdout = '', stderr = '') => ({ code, stdout, stderr })

  it('classifies test, typecheck, build and timeout failures', () => {
    expect(classifyFailure(outcome(1, 'FAIL  tests/a.test.ts\n  AssertionError: expected 1 to be 2')).kind).toBe('test')
    expect(classifyFailure(outcome(2, 'src/a.ts(3,5): error TS2322: Type string is not assignable')).kind).toBe('typecheck')
    expect(classifyFailure(outcome(1, 'build failed: Could not resolve "./x"')).kind).toBe('build')
    expect(classifyFailure(outcome(124, '', 'ETIMEDOUT')).kind).toBe('timeout')
    expect(classifyFailure(outcome(9, 'weird', ''), 'npm run thing').kind).toBe('command')
  })

  it('extracts implicated files, ignoring node_modules and versions', () => {
    const files = extractFiles(
      'error TS1 at src/main/a.ts:12\nError: boom\n    at /x/node_modules/pkg/index.js:1\n    at lib/b.js:9\nsee 1.2.3.js'
    )
    expect(files).toContain('src/main/a.ts')
    expect(files.some((f) => f.includes('node_modules'))).toBe(false)
    expect(files.some((f) => f.startsWith('1.2'))).toBe(false)
  })

  it('pulls the diagnostic lines and puts the first one in the summary', () => {
    const report = classifyFailure(
      outcome(1, 'FAIL tests/x.test.ts\nAssertionError: expected true to be false\nsome noise\nExpected: false')
    )
    expect(report.highlights.length).toBeGreaterThan(1)
    expect(report.summary).toContain('FAIL')
    expect(report.output).toContain('AssertionError')
  })

  it('truncates huge output keeping the tail', () => {
    const text = truncate(`${'A'.repeat(10_000)}THE-END`, 1_000)
    expect(text.length).toBeLessThan(1_100)
    expect(text).toContain('chars omitted')
    expect(text.endsWith('THE-END')).toBe(true)
  })

  it('forbids the prompt from weakening the check', () => {
    const report = classifyFailure(outcome(1, 'FAIL: expected 2'))
    const prompt = buildRepairPrompt({ command: 'npm test', report, attempt: 2, maxAttempts: 3 })
    expect(prompt).toContain('npm test')
    expect(prompt).toContain('do not delete or skip failing tests')
    expect(prompt).toContain('attempt 2 of 3')
    expect(prompt).toContain('Files implicated')
  })
})

describe('self-healing — loop behaviour', () => {
  it('passes immediately when the command already succeeds', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' })
    const fix = vi.fn()
    const loop = new SelfHealingLoop({ run, fix })
    const result = await loop.heal('npm test', tmpBase)
    expect(result).toMatchObject({ healed: true, attempts: 0, reason: 'passed' })
    expect(fix).not.toHaveBeenCalled()
  })

  it('repairs, re-runs and reports success', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 1, stdout: 'FAIL tests/a.test.ts', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'passed', stderr: '' })
    const fix = vi.fn().mockResolvedValue(['tests/a.test.ts'])
    const loop = new SelfHealingLoop({ run, fix, maxAttempts: 3 })
    const result = await loop.heal('npm test', tmpBase)
    expect(result.healed).toBe(true)
    expect(result.attempts).toBe(1)
    expect(run).toHaveBeenCalledTimes(2)
    expect(fix.mock.calls[0][0]).toContain('FAIL tests/a.test.ts')
  })

  it('gives up after the attempt ceiling and keeps the history', async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: 'FAIL always', stderr: '' })
    const fix = vi.fn().mockResolvedValue(['src/a.ts'])
    const loop = new SelfHealingLoop({ run, fix, maxAttempts: 99 })
    const result = await loop.heal('npm test', tmpBase)
    expect(result.healed).toBe(false)
    expect(result.reason).toBe('exhausted')
    expect(result.attempts).toBe(3) // clamped to the ceiling
    expect(result.history).toHaveLength(3)
    expect(run).toHaveBeenCalledTimes(4) // initial + one per attempt
  })

  it('stops early when the fixer changes nothing', async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: 'FAIL', stderr: '' })
    const fix = vi.fn().mockResolvedValue([])
    const result = await new SelfHealingLoop({ run, fix }).heal('npm test', tmpBase)
    expect(result.reason).toBe('no-fixer')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('reports a fixer error instead of looping on it', async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: 'FAIL', stderr: '' })
    const fix = vi.fn().mockRejectedValue(new Error('model offline'))
    const result = await new SelfHealingLoop({ run, fix }).heal('npm test', tmpBase)
    expect(result.reason).toBe('fix-failed')
    expect(result.history[0].error).toContain('model offline')
  })

  it('honours abort before the next attempt', async () => {
    const controller = new AbortController()
    const run = vi.fn().mockImplementation(async () => {
      controller.abort()
      return { code: 1, stdout: 'FAIL', stderr: '' }
    })
    const fix = vi.fn().mockResolvedValue(['a.ts'])
    const result = await new SelfHealingLoop({ run, fix }).heal('npm test', tmpBase, controller.signal)
    expect(result.reason).toBe('aborted')
    expect(fix).not.toHaveBeenCalled()
  })

  it('emits progress events', async () => {
    const emit = vi.fn()
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 1, stdout: 'FAIL', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
    await new SelfHealingLoop({ run, fix: async () => ['a.ts'], emit }).heal('npm test', tmpBase)
    expect(emit.mock.calls.map((c) => c[0].type)).toEqual(['attempt', 'healed'])
  })
})

// ---------------------------------------------------------------------------
// Module 5 — swarm
// ---------------------------------------------------------------------------

describe('swarm — roles and verdicts', () => {
  it('plans all three roles in order with the task in each prompt', () => {
    const plan = buildSwarmPlan({ task: 'add a retry to the updater', constraints: ['no new deps'] })
    expect(plan.map((s) => s.role)).toEqual(['coder', 'tester', 'security'])
    for (const step of plan) expect(step.prompt).toContain('add a retry to the updater')
    expect(plan[0].prompt).toContain('FILES:')
    expect(plan[2].prompt).toContain('BLOCK')
    expect(plan[0].prompt).toContain('no new deps')
  })

  it('parses verdicts conservatively', () => {
    expect(parseVerdict('PASS')).toBe('pass')
    expect(parseVerdict('OK — looks fine')).toBe('pass')
    expect(parseVerdict('BLOCK: writes outside roots')).toBe('block')
    expect(parseVerdict('I think this is probably fine')).toBe('unknown')
  })

  it('extracts proposed files and ignores "none"', () => {
    expect(parseProposedFiles('Some text\nFILES: src/a.ts, src/b.ts')).toEqual(['src/a.ts', 'src/b.ts'])
    expect(parseProposedFiles('FILES: none')).toEqual([])
    expect(parseProposedFiles('no marker here')).toEqual([])
  })

  it('turns reviewer output into findings', () => {
    const findings = extractFindings('Ok overall\nWARNING: logs a token\nBLOCK: writes to C:\\Windows', 'security')
    expect(findings.map((f) => f.severity)).toEqual(['warning', 'blocking'])
    expect(extractFindings('nothing to report', 'security')).toEqual([])
  })

  it('approves when the reviewer does not block', async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce('Do it.\nFILES: src/a.ts')
      .mockResolvedValueOnce('PASS')
      .mockResolvedValueOnce('OK')
    const outcome = await new SwarmRunner({ ask }).run({ task: 't' })
    expect(outcome.approved).toBe(true)
    expect(outcome.proposedFiles).toEqual(['src/a.ts'])
    expect(ask).toHaveBeenCalledTimes(3)
    expect(outcome.results.map((r) => r.role)).toEqual(['coder', 'tester', 'security'])
  })

  it('blocks when the security reviewer blocks, and surfaces the finding', async () => {
    const findings: string[] = []
    const ask = vi
      .fn()
      .mockResolvedValueOnce('FILES: none')
      .mockResolvedValueOnce('PASS')
      .mockResolvedValueOnce('BLOCK: escapes the authorized root')
    const outcome = await new SwarmRunner({ ask, onFinding: (f) => findings.push(f.message) }).run({ task: 't' })
    expect(outcome.approved).toBe(false)
    expect(findings.join(' ')).toContain('authorized root')
    expect(summarizeOutcome(outcome)).toContain('blocked')
  })

  it('warns when the tester gives no clear verdict', async () => {
    const ask = vi.fn().mockResolvedValueOnce('FILES: none').mockResolvedValueOnce('meh').mockResolvedValueOnce('OK')
    const outcome = await new SwarmRunner({ ask }).run({ task: 't' })
    expect(outcome.findings.some((f) => f.role === 'tester')).toBe(true)
    expect(outcome.approved).toBe(true)
  })

  it('passes the coder output into later prompts', async () => {
    const ask = vi.fn().mockResolvedValue('PASS')
    await new SwarmRunner({ ask }).run({ task: 't' })
    expect(ask.mock.calls[1][0]).toContain('PASS')
    expect(ask.mock.calls[2][0]).toContain('Tester verdict')
  })
})

// ---------------------------------------------------------------------------
// Module 2 — watchers and schedules
// ---------------------------------------------------------------------------

describe('watchers — schedule maths', () => {
  const at = (iso: string) => new Date(iso).getTime()

  it('parses daily times and rejects bad ones', () => {
    expect(parseDailyAt('08:30')).toEqual({ hour: 8, minute: 30 })
    expect(parseDailyAt('23:59')).toEqual({ hour: 23, minute: 59 })
    expect(() => parseDailyAt('24:00')).toThrow(WatcherError)
    expect(() => parseDailyAt('8.30')).toThrow()
  })

  it('validates and clamps triggers', () => {
    expect(validateTrigger({ kind: 'interval', everyMinutes: 5 })).toEqual({ kind: 'interval', everyMinutes: 5 })
    expect(() => validateTrigger({ kind: 'interval', everyMinutes: 0 })).toThrow()
    expect(() => validateTrigger({ kind: 'interval', everyMinutes: 99_999 })).toThrow()
    expect(validateTrigger({ kind: 'watch', target: ' C:/proj ', debounceMs: 10 })).toMatchObject({
      target: 'C:/proj',
      debounceMs: 250
    })
    expect(() => validateTrigger({ kind: 'watch', target: '  ' })).toThrow()
    expect(debounceMs({ kind: 'interval', everyMinutes: 1 })).toBe(0)
  })

  it('computes interval due times from the last run', () => {
    const trigger = { kind: 'interval' as const, everyMinutes: 10 }
    const now = at('2026-10-22T10:00:00Z')
    expect(isDue(trigger, undefined, now)).toBe(true)
    expect(isDue(trigger, now - 5 * 60_000, now)).toBe(false)
    expect(isDue(trigger, now - 11 * 60_000, now)).toBe(true)
    expect(nextRunAt(trigger, now, now)).toBe(now + 10 * 60_000)
  })

  it('schedules the next daily occurrence, rolling to tomorrow', () => {
    const trigger = { kind: 'daily' as const, at: '09:00' }
    const morning = new Date(2026, 9, 22, 8, 0, 0).getTime()
    const dueToday = nextRunAt(trigger, undefined, morning)!
    expect(new Date(dueToday).getHours()).toBe(9)
    expect(new Date(dueToday).getDate()).toBe(22)
    const afternoon = new Date(2026, 9, 22, 12, 0, 0).getTime()
    expect(new Date(nextRunAt(trigger, undefined, afternoon)!).getDate()).toBe(23)
    // Already fired today → tomorrow, not again now.
    const fired = new Date(2026, 9, 22, 9, 1, 0).getTime()
    expect(new Date(nextRunAt(trigger, fired, afternoon)!).getDate()).toBe(23)
  })

  it('never schedules an event trigger by clock', () => {
    expect(nextRunAt({ kind: 'watch', target: 'x' }, undefined, Date.now())).toBeNull()
  })
})

describe('watchers — runtime', () => {
  function makeService(overrides: Partial<ConstructorParameters<typeof WatcherService>[0]> = {}) {
    const runs: string[] = []
    let clock = 1_000_000
    const service = new WatcherService({
      file: path.join(tmpBase, `watchers-${Math.random().toString(36).slice(2)}.json`),
      now: () => clock,
      run: async (watcher) => {
        runs.push(watcher.id)
      },
      ...overrides
    })
    return { service, runs, advance: (ms: number) => (clock += ms) }
  }

  it('saves, lists and removes watchers', () => {
    const { service } = makeService()
    const saved = service.save({ name: 'Nightly', prompt: 'summarise', trigger: { kind: 'interval', everyMinutes: 30 }, enabled: true })
    expect(service.list()).toHaveLength(1)
    const updated = service.save({
      id: saved.id,
      name: 'Nightly',
      prompt: 'summarise harder',
      trigger: { kind: 'interval', everyMinutes: 30 },
      enabled: true
    })
    expect(updated.id).toBe(saved.id)
    expect(service.list()).toHaveLength(1)
    expect(service.list()[0].prompt).toBe('summarise harder')
    expect(service.remove(saved.id)).toBe(true)
    expect(service.list()).toEqual([])
    expect(service.remove('nope')).toBe(false)
  })

  it('requires a prompt', () => {
    const { service } = makeService()
    expect(() => service.save({ name: 'x', prompt: '   ', trigger: { kind: 'interval', everyMinutes: 5 }, enabled: true })).toThrow(/prompt/)
  })

  it('fires a due interval once per period, not on every tick', async () => {
    const { service, runs, advance } = makeService()
    service.save({ name: 'Tick', prompt: 'go', trigger: { kind: 'interval', everyMinutes: 5 }, enabled: true })
    expect(await service.tick()).toHaveLength(1)
    expect(await service.tick()).toHaveLength(0)
    advance(5 * 60_000)
    expect(await service.tick()).toHaveLength(1)
    expect(runs).toHaveLength(2)
  })

  it('skips disabled watchers and stays quiet while paused', async () => {
    const { service } = makeService()
    service.save({ name: 'Off', prompt: 'go', trigger: { kind: 'interval', everyMinutes: 1 }, enabled: false })
    expect(await service.tick()).toEqual([])
    const live = service.save({ name: 'On', prompt: 'go', trigger: { kind: 'interval', everyMinutes: 1 }, enabled: true })
    service.pause()
    expect(await service.tick()).toEqual([])
    service.resume()
    expect(await service.tick()).toContain(live.id)
  })

  it('does not start a second run for a watcher already in flight', async () => {
    let release: (() => void) | null = null
    const { service } = makeService({
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    })
    service.save({ name: 'Slow', prompt: 'go', trigger: { kind: 'interval', everyMinutes: 1 }, enabled: true })
    const first = service.tick()
    const second = await service.tick()
    expect(second).toEqual([])
    release?.()
    await first
  })

  it('survives a failing run without killing the scheduler', async () => {
    const events: string[] = []
    const { service } = makeService({
      run: async () => {
        throw new Error('model offline')
      },
      emit: (event) => events.push(event.type)
    })
    service.save({ name: 'Boom', prompt: 'go', trigger: { kind: 'interval', everyMinutes: 1 }, enabled: true })
    await service.tick()
    expect(events).toContain('fired')
    expect(events).toContain('error')
    expect(await service.tick()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Module 4 — local voice
// ---------------------------------------------------------------------------

describe('voice — whisper.cpp adapter', () => {
  it('strips timestamps and noise from whisper output', () => {
    const raw = [
      'whisper_init_from_file_with_params_no_state: loading model',
      '[00:00:00.000 --> 00:00:02.400]   open the settings page',
      '[00:00:02.400 --> 00:00:04.000]  and disable voice',
      'main: processing done'
    ].join('\n')
    expect(parseWhisperOutput(raw)).toBe('open the settings page and disable voice')
    expect(parseWhisperOutput('[00:00:00.000 --> 00:00:01.000] [BLANK_AUDIO]')).toBe('')
  })

  it('builds whisper and ffmpeg args without a shell', () => {
    const args = buildWhisperArgs({ modelPath: 'C:/m/ggml.bin', audioPath: 'C:/t/a.wav', language: 'en', threads: 4 })
    expect(args).toEqual(['-m', 'C:/m/ggml.bin', '-f', 'C:/t/a.wav', '-nt', '-otxt', '-np', '-l', 'en', '-t', '4'])
    expect(buildWhisperArgs({ modelPath: 'm', audioPath: 'a', language: 'auto' })).not.toContain('-l')
    expect(buildWhisperArgs({ modelPath: 'm', audioPath: 'a', threads: 99 }).join(' ')).not.toContain('-t 99')
    expect(buildFfmpegArgs('in.webm', 'out.wav')).toEqual(['-y', '-i', 'in.webm', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', 'out.wav'])
  })

  it('maps browser mime types to extensions', () => {
    expect(extensionFor('audio/webm;codecs=opus')).toBe('.webm')
    expect(extensionFor('audio/wav')).toBe('.wav')
    expect(extensionFor(undefined)).toBe('.webm')
    expect(extensionFor('audio/x-unknown')).toBe('.webm')
  })

  it('decodes base64 payloads and rejects empty audio', () => {
    expect(decodeAudioBase64(`data:audio/webm;base64,${Buffer.from('abc').toString('base64')}`).toString()).toBe('abc')
    expect(() => decodeAudioBase64('')).toThrow(/empty/)
  })

  it('reports exactly what is missing instead of pretending to be ready', () => {
    const missing = new VoiceService({ config: () => ({}) })
    const availability = missing.probe()
    expect(availability.ready).toBe(false)
    expect(availability.message).toContain('whisper-cli binary')
    const ready = new VoiceService({
      config: () => ({ binaryPath: '/bin/whisper', modelPath: '/m.bin', ffmpegPath: '/bin/ffmpeg' }),
      exists: () => true
    })
    expect(ready.probe()).toMatchObject({ ready: true, binary: true, model: true, ffmpeg: true })
  })

  it('transcribes through the injected spawner and cleans up temp audio', async () => {
    const calls: string[] = []
    const spawn = vi.fn(async (command: string) => {
      calls.push(command)
      if (command === '/bin/ffmpeg') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '[00:00:00.000 --> 00:00:01.000]  hello alpha', stderr: '' }
    })
    const tempDir = path.join(tmpBase, 'voice-temp')
    fs.mkdirSync(tempDir, { recursive: true })
    const service = new VoiceService({
      config: () => ({ binaryPath: '/bin/whisper', modelPath: '/m.bin', ffmpegPath: '/bin/ffmpeg', language: 'en' }),
      exists: () => true,
      spawn,
      tempDir: () => tempDir
    })
    const result = await service.transcribe({ audioBase64: Buffer.from('fake-webm').toString('base64'), mimeType: 'audio/webm' })
    expect(result.text).toBe('hello alpha')
    expect(calls).toEqual(['/bin/ffmpeg', '/bin/whisper'])
    expect(fs.readdirSync(tempDir)).toEqual([])
  })

  it('fails loudly rather than falling back to the cloud', async () => {
    const service = new VoiceService({ config: () => ({}), exists: () => false })
    await expect(service.transcribe({ audioBase64: 'YQ==' })).rejects.toThrow(/unavailable/)
  })

  it('surfaces a whisper failure with its stderr', async () => {
    const service = new VoiceService({
      config: () => ({ binaryPath: '/bin/whisper', modelPath: '/m.bin', ffmpegPath: '/bin/ffmpeg' }),
      exists: () => true,
      spawn: async (command: string) =>
        command === '/bin/ffmpeg'
          ? { code: 0, stdout: '', stderr: '' }
          : { code: 3, stdout: '', stderr: 'failed to load model' },
      tempDir: () => tmpBase
    })
    await expect(service.transcribe({ audioBase64: 'YQ==' })).rejects.toThrow(/failed to load model/)
  })

  it('reports silence as a message, not an empty success', async () => {
    const service = new VoiceService({
      config: () => ({ binaryPath: '/bin/whisper', modelPath: '/m.bin', ffmpegPath: '/bin/ffmpeg' }),
      exists: () => true,
      spawn: async (command: string) =>
        command === '/bin/ffmpeg' ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: '[BLANK_AUDIO]', stderr: '' },
      tempDir: () => tmpBase
    })
    await expect(service.transcribe({ audioBase64: 'YQ==' })).rejects.toThrow(/No speech/)
  })
})

// ---------------------------------------------------------------------------
// Module 3 — capturing a finished run as a macro
// ---------------------------------------------------------------------------

describe('macros — capture from a completed run', () => {
  const run = [
    { toolName: 'read_project_file', state: 'completed', args: { path: 'src/a.ts' } },
    {
      toolName: 'run_approved_command',
      state: 'completed',
      args: { command: 'npm test', purpose: 'validate' }
    },
    { toolName: 'create_or_write_file', state: 'completed', args: { path: 'documents/report.md', content: 'fixed' } }
  ]

  it('captures completed steps in order', () => {
    const draft = buildMacroDraft(run)
    expect(draft.steps.map((s) => s.tool)).toEqual([
      'read_project_file',
      'run_approved_command',
      'create_or_write_file'
    ])
  })

  it('turns variable arguments into parameters defaulting to the recorded value', () => {
    const draft = buildMacroDraft(run)
    const commandStep = draft.steps[1]
    expect(commandStep.args.command).toBe('{{command}}')
    const param = draft.params.find((p) => p.name === 'command')
    expect(param?.default).toBe('npm test')
    // Non-variable keys stay literal so the macro keeps its shape.
    expect(commandStep.args.purpose).toBe('validate')
  })

  it('names each parameter uniquely when a key repeats', () => {
    const draft = buildMacroDraft([
      { toolName: 'create_or_write_file', state: 'completed', args: { path: 'a.txt' } },
      { toolName: 'create_or_write_file', state: 'completed', args: { path: 'b.txt' } }
    ])
    expect(draft.steps[0].args.path).toBe('{{path}}')
    expect(draft.steps[1].args.path).toBe('{{path_2}}')
    expect(draft.params.map((p) => p.default)).toEqual(['a.txt', 'b.txt'])
  })

  it('produces a macro that replays exactly and then renders with new values', () => {
    const draft = buildMacroDraft(run)
    const service = new MacroService({ dir: path.join(tmpBase, 'macros-capture') })
    const saved = service.save({ name: 'Validate and report', steps: draft.steps, params: draft.params })
    const replay = renderMacro(saved, {})
    expect(replay.missing).toEqual([])
    expect(replay.steps[1].args.command).toBe('npm test')
    const reused = renderMacro(saved, { command: 'npm run build' })
    expect(reused.steps[1].args.command).toBe('npm run build')
  })

  it('skips failed steps and says why', () => {
    const draft = buildMacroDraft([
      { toolName: 'run_approved_command', state: 'completed', args: { command: 'npm test' } },
      { toolName: 'create_or_write_file', state: 'failed', args: { path: 'x.txt' } }
    ])
    expect(draft.steps).toHaveLength(1)
    expect(draft.skipped).toEqual([{ tool: 'create_or_write_file', reason: 'did not complete' }])
  })

  it('refuses to capture the proposal-based tools', () => {
    const draft = buildMacroDraft([
      { toolName: 'propose_file_patch', state: 'completed', args: {} },
      { toolName: 'apply_approved_patch', state: 'completed', args: { proposalId: 'p_1' } },
      { toolName: 'run_approved_command', state: 'completed', args: { command: 'npm test' } }
    ])
    expect(draft.steps.map((s) => s.tool)).toEqual(['run_approved_command'])
    expect(draft.skipped.every((entry) => entry.reason.includes('proposal id'))).toBe(true)
  })

  it('caps the captured sequence', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      toolName: 'run_approved_command',
      state: 'completed',
      args: { command: `npm test -- ${i}` }
    }))
    expect(buildMacroDraft(many).steps).toHaveLength(20)
    expect(buildMacroDraft(many, { maxSteps: 3 }).steps).toHaveLength(3)
  })

  it('can capture verbatim when parameterisation is off', () => {
    const draft = buildMacroDraft(run, { parameterize: false })
    expect(draft.steps[1].args.command).toBe('npm test')
    expect(draft.params).toEqual([])
  })

  it('suggests a readable name', () => {
    expect(suggestMacroName(run)).toBe('Read file + 2 more')
    expect(suggestMacroName([{ toolName: 'run_approved_command', state: 'completed' }])).toBe('Run command')
    expect(suggestMacroName([])).toBe('Saved workflow')
  })
})
