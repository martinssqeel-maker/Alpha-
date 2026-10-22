/**
 * Multi-agent collaborative swarm.
 *
 * A complex request is decomposed into three sequential roles — Coder, Tester,
 * Security Reviewer — each a plain prompt over the *same* local model, with the
 * previous role's output as context. This is sequential role prompting, not
 * parallel sub-agents: it costs one model call per role, which is the only
 * honest option against a single local Ollama instance.
 *
 * The security reviewer is advisory. It can block a plan by returning a
 * `blocking` finding, but it never *grants* permission: `pathGuard` and
 * `permissionService` remain the only things that authorize execution. Treating
 * a model's opinion as an authorization would undo the entire security model,
 * so `SwarmRunner` refuses to run a plan whose gating it did not perform itself.
 *
 * Pure logic, no Electron import.
 */
import type { FailureReport } from './selfHealing'

export type SwarmRole = 'coder' | 'tester' | 'security'

export interface SwarmRequest {
  task: string
  /** Extra facts the request depends on: paths, commands, constraints. */
  context?: string
  /** What the coder should optimise for. */
  constraints?: string[]
}

export interface SwarmStep {
  role: SwarmRole
  title: string
  prompt: string
}

export interface SwarmFinding {
  role: SwarmRole
  severity: 'info' | 'warning' | 'blocking'
  message: string
}

export interface SwarmRoleResult {
  role: SwarmRole
  text: string
  skipped?: boolean
  reason?: string
}

export interface SwarmOutcome {
  approved: boolean
  results: SwarmRoleResult[]
  findings: SwarmFinding[]
  /** Files the coder proposed to touch, as parsed from its answer. */
  proposedFiles: string[]
}

export interface SwarmDeps {
  /** One model call. Reuses the provider registry; no tool loop of its own. */
  ask: (prompt: string, role: SwarmRole, signal?: AbortSignal) => Promise<string>
  emit?: (event: { role: SwarmRole; phase: 'start' | 'done'; text?: string }) => void
  /** Reviewer output is advisory; a blocking finding stops the plan. */
  onFinding?: (finding: SwarmFinding) => void
}

export const ROLE_TITLES: Record<SwarmRole, string> = {
  coder: 'Coder',
  tester: 'Tester',
  security: 'Security Reviewer'
}

const MAX_CONTEXT_CHARS = 6_000

function contextBlock(request: SwarmRequest): string {
  const parts: string[] = []
  if (request.context) parts.push(request.context.slice(0, MAX_CONTEXT_CHARS))
  if (request.constraints?.length) parts.push(`Constraints:\n${request.constraints.map((c) => `- ${c}`).join('\n')}`)
  return parts.length ? `\n\nAdditional context:\n${parts.join('\n\n')}` : ''
}

/** The three prompts, built up front so they can be reviewed and tested. */
export function buildSwarmPlan(request: SwarmRequest): SwarmStep[] {
  const task = request.task.trim()
  const shared = contextBlock(request)
  return [
    {
      role: 'coder',
      title: ROLE_TITLES.coder,
      prompt: [
        `You are the Coder in a three-role review of one task.`,
        `Task: ${task}${shared}`,
        '',
        'Produce the concrete solution: the exact files to change and the change',
        'for each. Be specific enough that a reviewer could apply it by hand.',
        'End with a line `FILES:` followed by a comma-separated list of paths, or',
        '`FILES: none` if no file needs to change.'
      ].join('\n')
    },
    {
      role: 'tester',
      title: ROLE_TITLES.tester,
      prompt: [
        'You are the Tester. You did not write this solution and you are not here',
        'to praise it.',
        `Task: ${task}`,
        '',
        'Review the Coder output below. Look for: logic that cannot pass the stated',
        'tests, missing edge cases (empty input, null, permission denied, path with',
        'quotes or wildcards), and anything that would leave the app in a broken',
        'state. Reply with `PASS` or `FAIL: <reason>`, then at most three concrete',
        'problems.'
      ].join('\n')
    },
    {
      role: 'security',
      title: ROLE_TITLES.security,
      prompt: [
        'You are the Security Reviewer. Judge only safety, not style.',
        `Task: ${task}`,
        '',
        'Check the proposal for: path escape or traversal, writes outside the',
        'authorized roots, use of OS-protected locations, unescaped input reaching a',
        'shell, secrets in logs or prompts, and permission checks being skipped.',
        'Reply with `BLOCK: <reason>` if it does something unsafe that cannot be',
        'fixed by editing arguments, otherwise `OK` plus any warnings.'
      ].join('\n')
    }
  ]
}

/** Parse the reviewer's verdict without trusting it beyond a boolean opinion. */
export function parseVerdict(text: string): 'block' | 'pass' | 'unknown' {
  const head = text.trim().slice(0, 400)
  if (/^\s*BLOCK\b/i.test(head) || /\bBLOCK:\s*\S/i.test(head)) return 'block'
  if (/^\s*(PASS|OK)\b/i.test(head) || /^\s*(PASS|OK)\s*[.:-]/i.test(head)) return 'pass'
  return 'unknown'
}

export function parseProposedFiles(coderText: string): string[] {
  const match = /FILES:\s*(.+)/i.exec(coderText)
  if (!match) return []
  const raw = match[1].trim()
  if (/^none\b/i.test(raw)) return []
  return raw
    .split(/[,\n]/)
    .map((entry) => entry.trim().replace(/^[-*`\s]+|`+$/g, ''))
    .filter(Boolean)
    .slice(0, 20)
}

/** Warnings the reviewer raised, as structured findings. */
export function extractFindings(reviewText: string, role: SwarmRole): SwarmFinding[] {
  const findings: SwarmFinding[] = []
  for (const line of reviewText.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^(BLOCK|⚠|WARNING|WARN)\b/i.test(trimmed)) {
      const severity = /^BLOCK/i.test(trimmed) ? 'blocking' : 'warning'
      findings.push({ role, severity, message: trimmed.replace(/^[^\w]+/, '').slice(0, 300) })
    }
    if (findings.length >= 6) break
  }
  return findings
}

export class SwarmRunner {
  constructor(private deps: SwarmDeps) {}

  /**
   * Run the three roles in order. The Tester and Security passes see the Coder's
   * output; the Security pass also sees the Tester's verdict, because "the tests
   * pass but it writes to C:\\Windows" is exactly the case worth stopping.
   */
  async run(request: SwarmRequest, signal?: AbortSignal): Promise<SwarmOutcome> {
    const plan = buildSwarmPlan(request)
    const results: SwarmRoleResult[] = []
    const findings: SwarmFinding[] = []
    const emit = this.deps.emit ?? (() => undefined)
    const onFinding = this.deps.onFinding ?? (() => undefined)

    emit({ role: 'coder', phase: 'start' })
    const coder = await this.deps.ask(plan[0].prompt, 'coder', signal)
    results.push({ role: 'coder', text: coder })
    emit({ role: 'coder', phase: 'done', text: coder })
    const proposedFiles = parseProposedFiles(coder)

    emit({ role: 'tester', phase: 'start' })
    const testerText = await this.deps.ask(`${plan[1].prompt}\n\nCoder output:\n${coder}`, 'tester', signal)
    results.push({ role: 'tester', text: testerText })
    emit({ role: 'tester', phase: 'done', text: testerText })
    const testerVerdict = parseVerdict(testerText)

    emit({ role: 'security', phase: 'start' })
    const securityText = await this.deps.ask(
      `${plan[2].prompt}\n\nCoder output:\n${coder}\n\nTester verdict: ${testerVerdict.toUpperCase()}\n${testerText}`,
      'security',
      signal
    )
    results.push({ role: 'security', text: securityText })
    emit({ role: 'security', phase: 'done', text: securityText })

    for (const finding of extractFindings(securityText, 'security')) {
      findings.push(finding)
      onFinding(finding)
    }
    if (testerVerdict === 'unknown') {
      const finding: SwarmFinding = {
        role: 'tester',
        severity: 'warning',
        message: 'Tester did not return a clear PASS/FAIL verdict; treating as advisory only.'
      }
      findings.push(finding)
      onFinding(finding)
    }

    const approved = parseVerdict(securityText) !== 'block' && !findings.some((f) => f.severity === 'blocking')
    return { approved, results, findings, proposedFiles }
  }
}

/** Render a swarm outcome as the activity text shown to the user. */
export function summarizeOutcome(outcome: SwarmOutcome): string {
  const verdict = outcome.approved ? 'approved' : 'blocked'
  const blocking = outcome.findings.filter((f) => f.severity === 'blocking').length
  const files = outcome.proposedFiles.length ? ` · files: ${outcome.proposedFiles.join(', ')}` : ''
  return `Swarm ${verdict} (3 roles, ${blocking} blocking finding(s))${files}`
}

/** Compact failure context for the Tester role when a run just failed. */
export function failureContext(report: FailureReport | null): string {
  if (!report) return ''
  return [`Latest failure (${report.kind}):`, ...report.highlights.map((h) => `- ${h}`)].join('\n')
}
