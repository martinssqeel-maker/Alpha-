/**
 * Autonomous self-healing loops.
 *
 * When a validation command (tests, typecheck, build) exits non-zero, this keeps
 * the failure *inside* the agent instead of bouncing it to the user: classify the
 * output, feed the trace plus file context back to the model, let it propose a
 * fix, re-run, and repeat — at most `maxAttempts` times.
 *
 * Two boundaries this module will not cross:
 *  - it never bypasses `permissionService`. The runner is whatever the caller
 *    injected (which is the same gated path used for any command), and saving a
 *    file goes through the same approval flow. "Autonomous" means the loop is
 *    closed, not that the gate is open.
 *  - it gives up honestly. After the final attempt it returns the last failure
 *    with everything tried, rather than claiming success or looping forever.
 *
 * Pure logic, no Electron import.
 */

export type FailureKind = 'test' | 'typecheck' | 'build' | 'command' | 'timeout'

export interface CommandOutcome {
  code: number
  stdout: string
  stderr: string
}

export interface FailureReport {
  kind: FailureKind
  /** One-line summary for the Activity panel. */
  summary: string
  /** Files implicated by the output, most relevant first (deduped, capped). */
  files: string[]
  /** Assertion / error lines worth putting in the repair prompt. */
  highlights: string[]
  /** Raw output, already truncated by the caller or here. */
  output: string
  timedOut: boolean
}

export interface RepairAttempt {
  attempt: number
  prompt: string
  /** Files the model said it changed. */
  changed: string[]
  outcome: CommandOutcome | null
  error?: string
}

export interface HealResult {
  healed: boolean
  attempts: number
  report: FailureReport | null
  history: RepairAttempt[]
  reason: 'passed' | 'exhausted' | 'no-fixer' | 'aborted' | 'fix-failed'
}

export interface SelfHealingDeps {
  /** Run the validation command through the normal gated path. */
  run: (command: string, cwd: string, signal?: AbortSignal) => Promise<CommandOutcome>
  /**
   * Ask the model for a correction and apply it. Resolves with the files it
   * actually changed; throws if the fix could not be produced or applied.
   */
  fix: (prompt: string, signal?: AbortSignal) => Promise<string[]>
  emit?: (event: { type: 'attempt' | 'healed' | 'gave-up'; detail: string }) => void
  maxAttempts?: number
  /** Hard cap on how much output is fed back to the model. */
  maxFeedbackChars?: number
}

const MAX_ATTEMPTS_CEILING = 3
const DEFAULT_FEEDBACK_CHARS = 6_000
const MAX_FILES = 8

/** Order matters: the first matching signature wins. */
const SIGNATURES: Array<{ kind: FailureKind; re: RegExp }> = [
  { kind: 'timeout', re: /\bETIMEDOUT\b|timed out|timeout of \d+/i },
  { kind: 'typecheck', re: /\bTS\d{4}\b|error TS|tsc --noEmit/i },
  { kind: 'test', re: /\bFAIL\b|✕|AssertionError|Tests?\s+\d+\s+failed|failed \d+/i },
  { kind: 'build', re: /\bbuild failed\b|error during build|Could not resolve|RollupError/i }
]

/** Paths that look like source files, from TS/JS/node stack traces and diffs. */
const FILE_RE = /(?:^|[\s("'[])((?:[A-Za-z]:)?[\w./@-]*[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|html|py|rs|go|java|cs))(?::\d+)?/g

export function classifyFailure(outcome: CommandOutcome, command = ''): FailureReport {
  const output = `${outcome.stderr || ''}\n${outcome.stdout || ''}`.trim()
  let kind: FailureKind = 'command'
  for (const signature of SIGNATURES) {
    if (signature.re.test(output) || (signature.kind === 'typecheck' && /typecheck/i.test(command))) {
      kind = signature.kind
      break
    }
  }
  const files = extractFiles(output)
  const highlights = extractHighlights(output)
  const summary =
    highlights[0] ??
    (outcome.code !== 0 ? `Command exited with code ${outcome.code}` : 'Command produced no diagnostic')
  return {
    kind,
    summary: summary.slice(0, 300),
    files,
    highlights,
    output: truncate(output, DEFAULT_FEEDBACK_CHARS),
    timedOut: kind === 'timeout'
  }
}

export function extractFiles(output: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const match of output.matchAll(FILE_RE)) {
    const raw = match[1]
    if (!raw || raw.includes('node_modules/')) continue
    // Skip version-looking noise like `1.2.3.js`.
    if (/^\d/.test(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    result.push(raw)
    if (result.length >= MAX_FILES) break
  }
  return result
}

export function extractHighlights(output: string): string[] {
  const lines = output.split(/\r?\n/)
  const picked: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (
      /error TS\d+|\bFAIL\b|✕|AssertionError|Expected|Received|Cannot find|not assignable|is not a function|undefined is not|Error:|⨯/.test(
        trimmed
      )
    ) {
      // Strip mojibake box drawing that makes prompts noisy.
      picked.push(trimmed.replace(/^[│|]\s*/, '').slice(0, 400))
      if (picked.length >= 6) break
    }
  }
  return picked
}

export function truncate(text: string, max = DEFAULT_FEEDBACK_CHARS): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.65)
  return `${text.slice(0, head)}\n… ${text.length - max} chars omitted …\n${text.slice(-(max - head))}`
}

/**
 * The repair instruction. Deliberately explicit about *not* weakening the check:
 * a self-healing loop that "fixes" failing tests by deleting them is a bug
 * factory.
 */
export function buildRepairPrompt(input: {
  command: string
  report: FailureReport
  attempt: number
  maxAttempts: number
  previous?: RepairAttempt[]
}): string {
  const { command, report, attempt, maxAttempts } = input
  const lines = [
    `The validation command \`${command}\` failed (attempt ${attempt} of ${maxAttempts}).`,
    `Failure type: ${report.kind}.`,
    '',
    'Diagnostics:',
    ...report.highlights.map((line) => `  ${line}`),
    '',
    `Files implicated: ${report.files.length ? report.files.join(', ') : '(none named in the output)'}`,
    '',
    'Output (truncated):',
    '```',
    report.output,
    '```',
    '',
    'Produce the smallest correction that makes the command pass.',
    'Rules: do not delete or skip failing tests, do not loosen assertions, do not',
    'silence the checker (no `any` casts or ts-ignore to hide a real type error),',
    'and do not modify the validation command itself. If the failure is in your',
    'previous fix, correct that instead of starting over.'
  ]
  if (input.previous?.length) {
    lines.push('', 'Already attempted (do not repeat these):')
    for (const prior of input.previous) {
      lines.push(`  ${prior.attempt}. changed: ${prior.changed.join(', ') || '(nothing)'}`)
    }
  }
  return lines.join('\n')
}

/**
 * The loop. `run` and `fix` are injected so the same controller works against
 * the real terminal service in production and a fake in tests.
 */
export class SelfHealingLoop {
  private maxAttempts: number

  constructor(private deps: SelfHealingDeps) {
    this.maxAttempts = Math.min(Math.max(1, deps.maxAttempts ?? MAX_ATTEMPTS_CEILING), MAX_ATTEMPTS_CEILING)
  }

  async heal(command: string, cwd: string, signal?: AbortSignal): Promise<HealResult> {
    const history: RepairAttempt[] = []
    const emit = this.deps.emit ?? (() => undefined)
    let outcome = await this.deps.run(command, cwd, signal)
    if (outcome.code === 0) {
      return { healed: true, attempts: 0, report: null, history, reason: 'passed' }
    }
    let report = classifyFailure(outcome, command)

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (signal?.aborted) {
        return { healed: false, attempts: attempt - 1, report, history, reason: 'aborted' }
      }
      emit({ type: 'attempt', detail: `${report.kind} failure, repair attempt ${attempt}` })
      const prompt = buildRepairPrompt({
        command,
        report,
        attempt,
        maxAttempts: this.maxAttempts,
        previous: history
      })
      const record: RepairAttempt = { attempt, prompt, changed: [], outcome: null }
      try {
        record.changed = await this.deps.fix(prompt, signal)
      } catch (error) {
        record.error = (error as Error).message
        history.push(record)
        return { healed: false, attempts: attempt, report, history, reason: 'fix-failed' }
      }
      history.push(record)
      if (!record.changed.length) {
        // A fix that touched nothing cannot change the outcome; stop early
        // rather than burning the remaining attempts on identical runs.
        return { healed: false, attempts: attempt, report, history, reason: 'no-fixer' }
      }
      outcome = await this.deps.run(command, cwd, signal)
      record.outcome = outcome
      if (outcome.code === 0) {
        emit({ type: 'healed', detail: `passed after ${attempt} repair(s)` })
        return { healed: true, attempts: attempt, report: null, history, reason: 'passed' }
      }
      report = classifyFailure(outcome, command)
    }

    emit({ type: 'gave-up', detail: `still failing after ${this.maxAttempts} attempts` })
    return { healed: false, attempts: this.maxAttempts, report, history, reason: 'exhausted' }
  }
}
