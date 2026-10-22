/**
 * Minimal unified-diff reader for the activity timeline.
 *
 * The edit tool already returns real diffs; until now the UI dumped them into a
 * `<pre>` where additions and deletions were indistinguishable from context. This
 * module only *classifies* text — it never fabricates a diff, and it never claims
 * a change happened. If the text does not look like a unified diff, callers fall
 * back to the plain preformatted block.
 */

export type DiffLineKind = 'added' | 'removed' | 'context' | 'hunk' | 'meta'

export interface DiffLine {
  kind: DiffLineKind
  /** Line content without the leading +/-/space marker. */
  text: string
  /** Old/new file line numbers, when the hunk header made them known. */
  oldLine?: number
  newLine?: number
}

export interface DiffStats {
  added: number
  removed: number
}

/** `@@ -12,7 +12,9 @@` — the only reliable signal that this is a unified diff. */
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * True when `text` contains a hunk header plus at least one changed line.
 *
 * Requiring both matters: a log line can start with `+` or `@@`, and highlighting
 * a shell transcript as a diff would be actively misleading.
 */
export function looksLikeUnifiedDiff(text: string): boolean {
  if (!text || text.length > 400_000) return false
  const lines = text.split('\n')
  let hunks = 0
  let changes = 0
  for (const raw of lines) {
    if (HUNK.test(raw)) hunks += 1
    else if (raw.startsWith('+') && !raw.startsWith('+++')) changes += 1
    else if (raw.startsWith('-') && !raw.startsWith('---')) changes += 1
    if (hunks > 0 && changes > 0) return true
  }
  return false
}

/**
 * Classify every line, numbering context lines from the hunk header.
 *
 * `maxLines` bounds the work: a generated 200k-line diff must not build 200k React
 * elements. Truncation is reported by the caller via `truncated`.
 */
export function parseDiffLines(text: string, maxLines = 600): { lines: DiffLine[]; truncated: boolean } {
  const raw = text.split('\n')
  const truncated = raw.length > maxLines
  const slice = truncated ? raw.slice(0, maxLines) : raw

  const lines: DiffLine[] = []
  let oldLine: number | undefined
  let newLine: number | undefined

  for (const line of slice) {
    const hunk = HUNK.exec(line)
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10)
      newLine = Number.parseInt(hunk[3], 10)
      lines.push({ kind: 'hunk', text: line })
      continue
    }
    // File headers and the "\ No newline" marker are metadata, not content.
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      lines.push({ kind: 'meta', text: line })
      continue
    }
    if (line.startsWith('\\')) {
      lines.push({ kind: 'meta', text: line })
      continue
    }
    if (line.startsWith('+')) {
      lines.push({ kind: 'added', text: line.slice(1), newLine })
      if (newLine !== undefined) newLine += 1
      continue
    }
    if (line.startsWith('-')) {
      lines.push({ kind: 'removed', text: line.slice(1), oldLine })
      if (oldLine !== undefined) oldLine += 1
      continue
    }
    // A single leading space is the context marker; a blank line is too.
    const context = line.startsWith(' ') ? line.slice(1) : line
    lines.push({ kind: 'context', text: context, oldLine, newLine })
    if (oldLine !== undefined) oldLine += 1
    if (newLine !== undefined) newLine += 1
  }

  return { lines, truncated }
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'added') added += 1
    else if (line.kind === 'removed') removed += 1
  }
  return { added, removed }
}
