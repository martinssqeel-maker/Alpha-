import { describe, expect, it } from 'vitest'
import {
  MAX_DPR,
  MATRIX_GLYPHS,
  SHADER_LABELS,
  THEME_CATEGORIES,
  THEME_CONFIGS,
  advance,
  clampDelta,
  matrixColumns,
  pixelRatio,
  randomGlyph,
  resolveBackdrop,
  resolveShader,
  starCount,
  themeConfig,
  type ShaderPolicy
} from '../src/renderer/src/themes/themeEngine'
import { RESOLVED_THEME_OPTIONS, THEME_TOKENS, createThemeTokens, resolveAccentHex } from '../src/shared/theme'
import { withAlpha } from '../src/renderer/src/components/LiveBackgroundCanvas'

const policy = (overrides: Partial<ShaderPolicy> = {}): ShaderPolicy => ({
  liveBackground: true,
  eco: false,
  reducedMotion: false,
  ...overrides
})

describe('theme configuration', () => {
  it('describes every real palette exactly once', () => {
    for (const id of RESOLVED_THEME_OPTIONS) {
      const config = themeConfig(id)
      expect(config.id).toBe(id)
      expect(config.label.length).toBeGreaterThan(0)
      expect(config.description.length).toBeGreaterThan(0)
    }
    expect(Object.keys(THEME_CONFIGS)).toHaveLength(RESOLVED_THEME_OPTIONS.length)
  })

  it('only uses declared categories and shaders', () => {
    const categories = THEME_CATEGORIES.map((c) => c.id)
    for (const config of Object.values(THEME_CONFIGS)) {
      expect(categories).toContain(config.category)
      expect(Object.keys(SHADER_LABELS)).toContain(config.shader)
    }
  })

  it('maps the nine brief presets onto existing palette ids', () => {
    // The request named nine presets; they are aliases over palettes that already
    // ship. Asserting the alias table keeps the names honest without introducing a
    // second list that would drift from `THEME_OPTIONS`.
    const presets: Array<[string, string, string]> = [
      ['Galaxy Pulse', 'cosmic-indigo', 'galaxy'],
      ['Matrix Core', 'phosphor', 'matrix'],
      ['Solar Flare', 'solar-flare', 'solar'],
      ['Forest Haven', 'forest-haven', 'none'],
      ['Cyber Matrix', 'cyber-matrix', 'matrix'],
      ['Glass Elegance', 'arctic-glass', 'none'],
      ['Dark Pro', 'obsidian', 'none'],
      ['Neon Wave', 'neon-wave', 'matrix'],
      ['Sunset Breeze', 'sunset-breeze', 'solar']
    ]
    expect(presets).toHaveLength(9)
    for (const [preset, id, shader] of presets) {
      expect(preset.length).toBeGreaterThan(0)
      expect(themeConfig(id).shader).toBe(shader)
      expect(themeConfig(id).id).toBe(id)
    }
    // Every alias target must be a palette the theme picker actually offers.
    for (const [, id] of presets) {
      expect(RESOLVED_THEME_OPTIONS).toContain(id as (typeof RESOLVED_THEME_OPTIONS)[number])
    }
  })

  it('falls back instead of throwing on an unknown theme', () => {
    const config = themeConfig('not-a-theme')
    expect(config.id).toBe('obsidian')
    expect(config.shader).toBe('none')
  })
})

describe('resolveShader precedence', () => {
  it('runs an animated theme when nothing blocks it', () => {
    expect(resolveShader('cosmic-indigo', policy())).toEqual({ shader: 'galaxy', reason: 'active' })
    expect(resolveShader('phosphor', policy())).toEqual({ shader: 'matrix', reason: 'active' })
  })

  it('honours the user off switch above everything', () => {
    const decision = resolveShader('phosphor', policy({ liveBackground: false, eco: true, reducedMotion: true }))
    expect(decision).toEqual({ shader: 'none', reason: 'disabled' })
  })

  it('lets Eco-Saver outrank reduced motion and the theme', () => {
    expect(resolveShader('phosphor', policy({ eco: true }))).toEqual({ shader: 'none', reason: 'eco' })
    expect(resolveShader('phosphor', policy({ eco: true, reducedMotion: true })).reason).toBe('eco')
  })

  it('turns the canvas off for reduced motion', () => {
    expect(resolveShader('cosmic-indigo', policy({ reducedMotion: true }))).toEqual({
      shader: 'none',
      reason: 'reduced-motion'
    })
  })

  it('reports a static theme honestly rather than as disabled', () => {
    expect(resolveShader('obsidian', policy())).toEqual({ shader: 'none', reason: 'theme-static' })
  })

  it('never returns a shader for a theme without one', () => {
    for (const id of RESOLVED_THEME_OPTIONS) {
      const decision = resolveShader(id, policy())
      if (themeConfig(id).shader === 'none') expect(decision.shader).toBe('none')
    }
  })
})

describe('resolveBackdrop', () => {
  it('animates when nothing blocks it', () => {
    const backdrop = resolveBackdrop('cosmic-indigo', policy())
    expect(backdrop.shader).toBe('galaxy')
    expect(backdrop.paintShader).toBe('galaxy')
    expect(backdrop.paused).toBe(false)
  })

  it('paints one static theme frame under Eco-Saver instead of going blank', () => {
    const backdrop = resolveBackdrop('phosphor', policy({ eco: true }))
    expect(backdrop.reason).toBe('eco')
    expect(backdrop.paused).toBe(true)
    expect(backdrop.paintShader).toBe('matrix')
  })

  it('paints one static frame for reduced motion too', () => {
    const backdrop = resolveBackdrop('solar-flare', policy({ reducedMotion: true }))
    expect(backdrop.reason).toBe('reduced-motion')
    expect(backdrop.paused).toBe(true)
    expect(backdrop.paintShader).toBe('solar')
  })

  it('removes the canvas entirely when the user turned it off', () => {
    const backdrop = resolveBackdrop('phosphor', policy({ liveBackground: false, eco: true }))
    expect(backdrop.paintShader).toBe('none')
    expect(backdrop.paused).toBe(false)
  })

  it('does not invent a frame for a theme without a shader', () => {
    const backdrop = resolveBackdrop('obsidian', policy({ eco: true }))
    expect(backdrop.paintShader).toBe('none')
    expect(backdrop.paused).toBe(false)
    expect(backdrop.reason).toBe('eco')
  })

  it('never paints while paused', () => {
    for (const id of RESOLVED_THEME_OPTIONS) {
      for (const eco of [true, false]) {
        for (const reducedMotion of [true, false]) {
          const backdrop = resolveBackdrop(id, policy({ eco, reducedMotion }))
          if (backdrop.paused) expect(backdrop.shader).toBe('none')
          expect(backdrop.paintShader === 'none' || !backdrop.paused || backdrop.shader === 'none').toBe(true)
        }
      }
    }
  })
})

describe('shader geometry', () => {
  it('clamps the device pixel ratio', () => {
    expect(pixelRatio(undefined)).toBe(1)
    expect(pixelRatio(Number.NaN)).toBe(1)
    expect(pixelRatio(0.5)).toBe(1)
    expect(pixelRatio(1.5)).toBe(1.5)
    expect(pixelRatio(3)).toBe(MAX_DPR)
  })

  it('bounds star density at both ends', () => {
    expect(starCount(0, 0)).toBe(40)
    expect(starCount(1920, 1080)).toBeGreaterThan(300)
    // A 4K window must not spawn tens of thousands of particles.
    expect(starCount(3840, 2160)).toBeLessThanOrEqual(900)
    expect(starCount(3840, 2160)).toBe(900)
  })

  it('scales columns with width and never drops below four', () => {
    expect(matrixColumns(0)).toBe(4)
    expect(matrixColumns(1200, 15)).toBe(80)
    // A tiny font must not produce thousands of columns.
    expect(matrixColumns(1200, 2)).toBe(150)
  })

  it('advances particles independently of frame rate', () => {
    const at60 = advance(0, 2, 16.6667)
    // Two 8ms frames land in roughly the same place as one 16ms frame.
    const twoSteps = advance(advance(0, 2, 8.3333), 2, 8.3334)
    expect(at60).toBeCloseTo(2, 2)
    expect(twoSteps).toBeCloseTo(at60, 1)
  })

  it('refuses to teleport after a stalled frame', () => {
    expect(advance(0, 2, 5000)).toBe(advance(0, 2, 64))
    expect(advance(0, 2, -50)).toBe(0)
    expect(clampDelta(5000)).toBe(64)
    expect(clampDelta(-1)).toBe(0)
  })

  it('picks glyphs from the declared set using the supplied generator', () => {
    expect(randomGlyph(() => 0)).toBe(MATRIX_GLYPHS[0])
    expect(randomGlyph(() => 0.999999)).toBe(MATRIX_GLYPHS[MATRIX_GLYPHS.length - 1])
    expect(MATRIX_GLYPHS).not.toContain(' ')
  })
})

describe('withAlpha', () => {
  it('expands shorthand hex', () => {
    expect(withAlpha('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)')
    expect(withAlpha('#0a0', 1)).toBe('rgba(0, 170, 0, 1)')
  })

  it('reads full hex', () => {
    expect(withAlpha('#52e6e8', 0.25)).toBe('rgba(82, 230, 232, 0.25)')
    expect(withAlpha('  #FFD166  ', 0)).toBe('rgba(255, 209, 102, 0)')
  })

  it('passes rgb() through with a new alpha', () => {
    expect(withAlpha('rgb(10, 20, 30)', 0.4)).toBe('rgba(10, 20, 30, 0.4)')
    expect(withAlpha('rgba(10, 20, 30, 0.9)', 0.2)).toBe('rgba(10, 20, 30, 0.2)')
  })

  it('clamps alpha above and below range', () => {
    expect(withAlpha('#000000', 5)).toBe('rgba(0, 0, 0, 1)')
    expect(withAlpha('#000000', -2)).toBe('rgba(0, 0, 0, 0)')
  })

  it('falls back instead of emitting an invalid colour for color-mix()', () => {
    // This is the exact bug class that made the canvas render blank: a
    // `color-mix()` value is not a valid fillStyle.
    const fallback = withAlpha('color-mix(in srgb, #ff0000 50%, #0000ff)', 1)
    expect(fallback.startsWith('rgba(')).toBe(true)
    expect(fallback).not.toContain('color-mix')
    expect(fallback).toBe('rgba(120, 160, 255, 0.6)')
  })

  it('never returns a bare CSS keyword', () => {
    for (const value of ['', 'red', 'var(--accent)', 'linear-gradient(#fff, #000)']) {
      expect(withAlpha(value, 0.5)).toMatch(/^rgba\(/)
    }
  })
})

describe('resolveAccentHex (canvas-safe colours)', () => {
  it('returns the palette hex when the accent follows the theme', () => {
    const colors = resolveAccentHex('cosmic-indigo', { accent: 'theme' } as never)
    expect(colors.accent).toMatch(/^#[\da-f]{6}$/i)
    expect(colors.secondary).toMatch(/^#[\da-f]{6}$/i)
    expect(colors.secondary).toBe(THEME_TOKENS['cosmic-indigo']['--accent-secondary'])
  })

  it('uses a named accent and mixes the secondary like the CSS token does', () => {
    const colors = resolveAccentHex('phosphor', { accent: 'rose' } as never)
    expect(colors.accent).toBe('#ff7f9e')
    expect(colors.secondary).toMatch(/^#[\da-f]{6}$/i)
    // Never the palette's untouched secondary: that would ignore the user's accent.
    expect(colors.secondary).not.toBe(THEME_TOKENS.phosphor['--accent-secondary'])
  })

  it('accepts a valid custom accent', () => {
    const colors = resolveAccentHex('obsidian', { accent: 'custom', customAccent: '#123456' } as never)
    expect(colors.accent).toBe('#123456')
  })

  it('repairs a malformed custom accent exactly as the token pipeline does', () => {
    const input = { accent: 'custom', customAccent: 'red' } as never
    const colors = resolveAccentHex('obsidian', input)
    // `normalizeAppearanceSettings` replaces an invalid hex before either path
    // reads it, so canvas and CSS must agree on the repaired value.
    expect(colors.accent).toBe(createThemeTokens('obsidian', input)['--accent'])
  })

  it('always agrees with the token pipeline on the accent colour', () => {
    for (const id of RESOLVED_THEME_OPTIONS) {
      for (const accent of ['theme', 'gold', 'cyan', 'custom'] as const) {
        const input = { accent, customAccent: '#abcdef' } as never
        expect(resolveAccentHex(id, input).accent).toBe(createThemeTokens(id, input)['--accent'])
      }
    }
  })

  it('never hands the canvas a color-mix() expression', () => {
    for (const id of RESOLVED_THEME_OPTIONS) {
      for (const accent of ['theme', 'gold', 'custom'] as const) {
        const colors = resolveAccentHex(id, { accent, customAccent: '#abcdef' } as never)
        expect(colors.accent).not.toContain('color-mix')
        expect(colors.secondary).not.toContain('color-mix')
        expect(withAlpha(colors.accent, 0.5)).toMatch(/^rgba\(/)
      }
    }
  })
})
