import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isLightTheme,
  createThemeTokens,
  normalizeAppearanceSettings,
  RESOLVED_THEME_OPTIONS,
  THEME_OPTIONS,
  THEME_TOKENS,
  resolveTheme
} from '../src/shared/theme'

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
  it('ships twelve curated palettes plus System and resolves System to an appropriate surface', () => {
    expect(THEME_OPTIONS.filter((option) => option.id !== 'system').map((option) => option.id)).toEqual([
      'solar-flare', 'cosmic-indigo', 'forest-haven', 'sunset-breeze', 'cyber-matrix', 'arctic-glass',
      'neon-wave', 'obsidian', 'aurora', 'neon-crystal', 'liquid-glass', 'phosphor'
    ])
    expect(RESOLVED_THEME_OPTIONS).toHaveLength(12)
    expect(new Set(RESOLVED_THEME_OPTIONS).size).toBe(12)
    for (const option of THEME_OPTIONS) {
      expect(option.group, `${option.id} needs a gallery group`).toBeTruthy()
      expect(option.description, `${option.id} needs a description`).toBeTruthy()
    }
    expect(resolveTheme('system', true)).toBe('obsidian')
    expect(resolveTheme('system', false)).toBe('arctic-glass')
    expect(isLightTheme(resolveTheme('system', false))).toBe(true)
    expect(isLightTheme(resolveTheme('aurora', true))).toBe(false)
  })

  it('maps every previously saved preset to a supported palette', () => {
    const legacy: Record<string, string> = {
      dark: 'obsidian', light: 'arctic-glass', alpine: 'phosphor', tide: 'aurora',
      'after-rain': 'obsidian', kanagawa: 'cosmic-indigo', orbit: 'cosmic-indigo',
      'violet-hour': 'cosmic-indigo', dune: 'arctic-glass', ember: 'aurora',
      blossom: 'cosmic-indigo', mirage: 'arctic-glass'
    }
    for (const [saved, resolved] of Object.entries(legacy)) {
      expect(resolveTheme(saved, true), `saved theme ${saved}`).toBe(resolved)
    }
    expect(resolveTheme('unknown-saved-value', true)).toBe('solar-flare')
  })

  it('defines complete and genuinely distinct token sets for all twelve palettes', () => {
    for (const theme of RESOLVED_THEME_OPTIONS) {
      const tokens = THEME_TOKENS[theme]
      for (const key of [
        '--surface-0', '--surface-1', '--surface-2', '--surface-3', '--surface-glass',
        '--text-primary', '--text-secondary', '--text-tertiary', '--text-disabled',
        '--border-subtle', '--border-strong', '--glass-border', '--ambient-light', '--accent',
        '--accent-secondary', '--accent-gradient', '--accent-glow',
        '--success', '--warning', '--danger', '--info', '--focus-ring', '--modal-scrim',
        '--composer-bg', '--terminal-bg', '--diff-add-bg', '--diff-delete-bg'
      ] as const) {
        expect(tokens[key], `${theme} ${key}`).toBeTruthy()
      }
    }
    expect(new Set(RESOLVED_THEME_OPTIONS.map((theme) => THEME_TOKENS[theme]['--accent'])).size).toBe(12)
    expect(THEME_TOKENS.aurora['--accent-secondary']).not.toBe(THEME_TOKENS.aurora['--accent'])
    expect(THEME_TOKENS['cosmic-indigo']['--surface-0']).not.toBe(THEME_TOKENS.obsidian['--surface-0'])
    expect(THEME_TOKENS['arctic-glass']['--surface-0']).not.toBe(THEME_TOKENS.obsidian['--surface-0'])
  })

  it('normalizes old or malformed appearance settings and applies real mode/accent overrides', () => {
    const recovered = normalizeAppearanceSettings({ mode: 'unexpected', density: 'huge', glowIntensity: 140, animations: false })
    expect(recovered.mode).toBe('system')
    expect(recovered.density).toBe('comfortable')
    expect(recovered.glowIntensity).toBe(100)
    expect(recovered.animations).toBe(false)
    expect(normalizeAppearanceSettings(null).glassIntensity).toBe(55)

    const light = createThemeTokens('solar-flare', { ...recovered, mode: 'light', accent: 'cyan' }, true)
    expect(light['--surface-0']).toBe(THEME_TOKENS['arctic-glass']['--surface-0'])
    expect(light['--accent']).toBe('#52e6e8')
    expect(light['--text-on-accent']).toBe('#10151f')
    expect(light['--surface-glass']).toContain('color-mix')
    const darkGlass = createThemeTokens('arctic-glass', { ...recovered, mode: 'dark' }, false)
    expect(darkGlass['--surface-0']).toBe(THEME_TOKENS.obsidian['--surface-0'])
  })

  it('meets text and semantic contrast gates on all palette surfaces', () => {
    for (const theme of RESOLVED_THEME_OPTIONS) {
      const tokens = THEME_TOKENS[theme]
      const surfaces = [tokens['--surface-0'], tokens['--surface-1'], tokens['--surface-2'], tokens['--surface-3']]
      for (const surface of surfaces) {
        expect(contrast(tokens['--text-primary'], surface), `${theme} primary on ${surface}`).toBeGreaterThanOrEqual(12)
        expect(contrast(tokens['--text-secondary'], surface), `${theme} secondary on ${surface}`).toBeGreaterThanOrEqual(7)
        expect(contrast(tokens['--text-tertiary'], surface), `${theme} tertiary on ${surface}`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(tokens['--text-disabled'], surface), `${theme} disabled on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
      for (const accent of [tokens['--accent'], tokens['--accent-hover'], tokens['--accent-active'], tokens['--accent-secondary']]) {
        expect(contrast(tokens['--text-on-accent'], accent), `${theme} button text on ${accent}`).toBeGreaterThanOrEqual(4.5)
      }
      for (const status of ['--success', '--warning', '--danger', '--info'] as const) {
        expect(contrast(tokens[status], tokens['--surface-1']), `${theme} ${status}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps shared design primitives and the Aurora first-paint fallback in sync', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    for (const token of ['--neutral-0', '--neutral-1000', '--space-1', '--space-10', '--primitive-radius-md', '--duration-fast', '--easing-standard']) {
      expect(css, token).toContain(token)
    }
    expect(css).toContain('@theme {')
    expect(css).toContain('--color-surface-0: var(--surface-0)')
    expect(css).toContain('--surface-0: #070a12')
    expect(css).toContain('background: var(--modal-scrim)')
    expect(css).toContain('color: var(--text-disabled)')
    expect(css).toContain('.btn.primary:active:not(:disabled)')
    expect(css).toContain('.composer-input-card:focus-within')
    expect(css).not.toContain('opacity: 0.45')
  })
})
