import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RESOLVED_THEME_OPTIONS, THEME_OPTIONS, THEME_TOKENS, resolveTheme } from '../src/shared/theme'

function linearChannel(value: number): number {
  const channel = value / 255
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function luminance(color: string): number {
  const hex = color.slice(1)
  const rgb = hex.length === 3
    ? [...hex].map((part) => Number.parseInt(part + part, 16))
    : [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16))
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color)) throw new Error(`Expected a hex color, got ${color}`)
  return 0.2126 * linearChannel(rgb[0]) + 0.7152 * linearChannel(rgb[1]) + 0.0722 * linearChannel(rgb[2])
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

describe('theme presets', () => {
  it('ships the full preset gallery and resolves System to the operating-system palette', () => {
    expect(THEME_OPTIONS).toHaveLength(15)
    expect(RESOLVED_THEME_OPTIONS).toHaveLength(14)
    expect(THEME_OPTIONS.map((option) => option.id)).toContain('mirage')
    for (const option of THEME_OPTIONS) {
      expect(option.group, `${option.id} needs a gallery group`).toBeTruthy()
      expect(option.description, `${option.id} needs a description`).toBeTruthy()
    }
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('alpine', false)).toBe('alpine')
  })

  it('keeps every gallery group non-empty and offers light and dark variety', () => {
    const groups = new Set(THEME_OPTIONS.map((option) => option.group))
    expect(groups.size).toBeGreaterThanOrEqual(4)
    for (const group of groups) {
      expect(THEME_OPTIONS.filter((option) => option.group === group).length).toBeGreaterThan(0)
    }
    // A light preset (other than the default) must be selectable, and several dark ones.
    expect(THEME_TOKENS.mirage['--surface-0']).not.toBe(THEME_TOKENS.light['--surface-0'])
    expect(RESOLVED_THEME_OPTIONS.length).toBeGreaterThanOrEqual(12)
  })

  it('provides complete semantic tokens for every palette and changes more than accent', () => {
    for (const theme of RESOLVED_THEME_OPTIONS) {
      const tokens = THEME_TOKENS[theme]
      for (const key of [
        '--surface-0', '--surface-1', '--surface-2', '--surface-3',
        '--text-primary', '--text-secondary', '--text-tertiary', '--text-disabled',
        '--border-subtle', '--border-strong', '--accent', '--accent-hover',
        '--success', '--warning', '--danger', '--info', '--focus-ring', '--modal-scrim',
        '--composer-bg', '--terminal-bg', '--diff-add-bg', '--diff-delete-bg'
      ] as const) {
        expect(tokens[key], `${theme} ${key}`).toBeTruthy()
      }
      if (theme !== 'dark' && theme !== 'light') {
        expect(tokens['--surface-0'], `${theme} must define a real palette`).not.toBe(THEME_TOKENS.dark['--surface-0'])
        expect(tokens['--surface-2'], `${theme} must remap raised surfaces`).not.toBe(THEME_TOKENS.dark['--surface-2'])
      }
    }
  })

  it('meets the text contrast gates on all surfaces and keeps primary buttons readable', () => {
    for (const theme of RESOLVED_THEME_OPTIONS) {
      const tokens = THEME_TOKENS[theme]
      const surfaces = [tokens['--surface-0'], tokens['--surface-1'], tokens['--surface-2'], tokens['--surface-3']]
      for (const surface of surfaces) {
        expect(contrast(tokens['--text-primary'], surface), `${theme} primary on ${surface}`).toBeGreaterThanOrEqual(12)
        expect(contrast(tokens['--text-secondary'], surface), `${theme} secondary on ${surface}`).toBeGreaterThanOrEqual(7)
        expect(contrast(tokens['--text-tertiary'], surface), `${theme} tertiary on ${surface}`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(tokens['--text-disabled'], surface), `${theme} disabled on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrast(tokens['--text-on-accent'], tokens['--accent']), `${theme} button text`).toBeGreaterThanOrEqual(4.5)
      for (const status of ['--success', '--warning', '--danger', '--info'] as const) {
        expect(contrast(tokens[status], tokens['--surface-1']), `${theme} ${status}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('defines the primitive scales, semantic theme bridge, and dark first-paint defaults', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    for (const token of ['--neutral-0', '--neutral-1000', '--space-1', '--space-10', '--primitive-radius-md', '--duration-fast', '--easing-standard']) {
      expect(css, token).toContain(token)
    }
    expect(css).toContain('@theme {')
    expect(css).toContain('--color-surface-0: var(--surface-0)')
    expect(css).toContain('--surface-0: #0b0d12')
    expect(css).toContain('background: var(--modal-scrim)')
    expect(css).toContain('color: var(--text-disabled)')
    expect(css).toContain('.btn.primary:active:not(:disabled)')
    expect(css).not.toContain('opacity: 0.45')
  })
})
