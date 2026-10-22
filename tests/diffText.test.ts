import { describe, expect, it } from 'vitest'
import { diffStats, looksLikeUnifiedDiff, parseDiffLines } from '../src/shared/diffText'

const SAMPLE = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' export { a }'
].join('\n')

describe('looksLikeUnifiedDiff', () => {
  it('accepts a real diff', () => {
    expect(looksLikeUnifiedDiff(SAMPLE)).toBe(true)
  })

  it('rejects ordinary output that happens to start with +/-', () => {
    expect(looksLikeUnifiedDiff('+ installed 42 packages\n- removed 1 package')).toBe(false)
    expect(looksLikeUnifiedDiff('npm WARN + something')).toBe(false)
  })

  it('rejects a hunk header with no changes', () => {
    expect(looksLikeUnifiedDiff('@@ -1,2 +1,2 @@\n a\n b')).toBe(false)
  })

  it('rejects empty and oversized input', () => {
    expect(looksLikeUnifiedDiff('')).toBe(false)
    expect(looksLikeUnifiedDiff('x'.repeat(400_001))).toBe(false)
  })

  it('rejects plain prose', () => {
    expect(looksLikeUnifiedDiff('Everything applied successfully.')).toBe(false)
  })
})

describe('parseDiffLines', () => {
  const { lines } = parseDiffLines(SAMPLE)
  const find = (text: string) => lines.find((line) => line.text === text)

  it('classifies headers as metadata, not as additions', () => {
    const headers = lines.filter((line) => line.kind === 'meta').map((line) => line.text)
    expect(headers).toContain('--- a/src/app.ts')
    expect(headers).toContain('+++ b/src/app.ts')
    // The `+++`/`---` markers must never be counted as content changes.
    expect(lines.some((line) => line.kind === 'added' && line.text.startsWith('++'))).toBe(false)
  })

  it('marks the hunk header', () => {
    expect(lines.some((line) => line.kind === 'hunk' && line.text.startsWith('@@'))).toBe(true)
  })

  it('counts additions and deletions', () => {
    const stats = diffStats(lines)
    expect(stats.added).toBe(2)
    expect(stats.removed).toBe(1)
  })

  it('numbers lines from the hunk header', () => {
    expect(find('const a = 1')?.oldLine).toBe(1)
    expect(find('const a = 1')?.newLine).toBe(1)
    expect(find('const b = 2')?.oldLine).toBe(2)
    expect(find('const b = 3')?.newLine).toBe(2)
    expect(find('const c = 4')?.newLine).toBe(3)
    // The context line after the changes moves on in both files.
    expect(find('export { a }')?.oldLine).toBe(3)
    expect(find('export { a }')?.newLine).toBe(4)
  })

  it('strips the leading marker from content', () => {
    expect(find('const b = 3')).toBeDefined()
    // Only content lines lose their marker; metadata keeps the raw header text.
    expect(lines.filter((line) => line.kind !== 'meta').every((line) => !line.text.startsWith('+') || line.kind === 'hunk')).toBe(true)
  })

  it('handles the no-newline marker as metadata', () => {
    const parsed = parseDiffLines('@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file')
    expect(parsed.lines[parsed.lines.length - 1].kind).toBe('meta')
    expect(diffStats(parsed.lines)).toEqual({ added: 1, removed: 1 })
  })

  it('keeps a deleted blank line distinguishable from context', () => {
    const parsed = parseDiffLines('@@ -1,2 +1 @@\n-\n keep')
    expect(parsed.lines[1].kind).toBe('removed')
    expect(parsed.lines[1].text).toBe('')
    expect(parsed.lines[2].kind).toBe('context')
  })

  it('truncates instead of building an unbounded list', () => {
    const huge = ['@@ -1,600 +1,600 @@', ...Array.from({ length: 5000 }, () => '+line')].join('\n')
    const parsed = parseDiffLines(huge, 100)
    expect(parsed.truncated).toBe(true)
    expect(parsed.lines).toHaveLength(100)
  })

  it('reports truncation even when the diff is exactly at the limit', () => {
    const exact = ['@@ -1 +1 @@', '+one', '+two'].join('\n')
    expect(parseDiffLines(exact, 3).truncated).toBe(false)
    expect(parseDiffLines(exact, 2).truncated).toBe(true)
  })
})
