/**
 * Premium theme engine: the shader and resource-policy layer over Alpha's
 * palette system.
 *
 * The twelve palettes already exist in `@shared/theme` (`THEME_OPTIONS`) and are
 * applied by `useApp.applyTheme()` through `data-theme` plus generated CSS
 * tokens. This module deliberately does **not** define a second palette set —
 * a parallel theme list is how an app ends up with two "Solar Flare"s that drift
 * apart. It adds the two things the palettes lacked:
 *
 *   1. a category and a live-background shader per theme, and
 *   2. a resource policy (`resolveShader`) that decides whether that shader may
 *      run at all — Eco-Saver, reduced-motion and the user's own switch all win
 *      over the theme's preference.
 *
 * Everything here is pure: no canvas, no DOM, no `electron`. The canvas renderer
 * consumes these decisions; the tests assert them without a browser.
 */
import { RESOLVED_THEME_OPTIONS, type ResolvedTheme } from '@shared/theme'

export type ThemeId = ResolvedTheme

/** Categories the presets are grouped under in the Appearance panel. */
export type ThemeCategory = 'neon' | 'nature' | 'warm' | 'minimal'

/** Live background renderers. `none` means the static glass gradient only. */
export type ShaderKind = 'galaxy' | 'matrix' | 'solar' | 'none'

/** Card-sized names for each shader, used by the preset thumbnails. */
export const SHADER_LABELS: Record<ShaderKind, string> = {
  galaxy: 'Galaxy',
  matrix: 'Code rain',
  solar: 'Solar',
  none: 'Static'
}

export interface ThemeConfig {
  id: ThemeId
  /** Human label, matching `THEME_OPTIONS` so the two never disagree. */
  label: string
  category: ThemeCategory
  /** The shader this theme *would* like to run. */
  shader: ShaderKind
  /** Short line shown on the preset card. */
  description: string
}

/**
 * The nine named presets from the brief map onto existing palettes:
 * Galaxy Pulse → cosmic-indigo, Matrix Core → phosphor, Glass Elegance →
 * arctic-glass, Dark Pro → obsidian, and so on. Aurora, Neon Crystal and Liquid
 * Glass keep their own identities rather than being renamed.
 */
export const THEME_CONFIGS: Readonly<Record<ThemeId, ThemeConfig>> = {
  'solar-flare': {
    id: 'solar-flare',
    label: 'Solar Flare',
    category: 'warm',
    shader: 'solar',
    description: 'Molten amber over blackened glass.'
  },
  'cosmic-indigo': {
    id: 'cosmic-indigo',
    label: 'Galaxy Pulse',
    category: 'neon',
    shader: 'galaxy',
    description: 'Starfield depth with spectral violet.'
  },
  'forest-haven': {
    id: 'forest-haven',
    label: 'Forest Haven',
    category: 'nature',
    shader: 'none',
    description: 'Quiet jade and botanical greens.'
  },
  'sunset-breeze': {
    id: 'sunset-breeze',
    label: 'Sunset Breeze',
    category: 'warm',
    shader: 'solar',
    description: 'Burnished coral with dusk plum.'
  },
  'cyber-matrix': {
    id: 'cyber-matrix',
    label: 'Cyber Matrix',
    category: 'neon',
    shader: 'matrix',
    description: 'Electric blue with hot-pink signals.'
  },
  'arctic-glass': {
    id: 'arctic-glass',
    label: 'Glass Elegance',
    category: 'minimal',
    shader: 'none',
    description: 'Icy porcelain and lucid glass.'
  },
  'neon-wave': {
    id: 'neon-wave',
    label: 'Neon Wave',
    category: 'neon',
    shader: 'matrix',
    description: 'Ion cyan with a magenta edge.'
  },
  obsidian: {
    id: 'obsidian',
    label: 'Dark Pro',
    category: 'minimal',
    shader: 'none',
    description: 'Quiet graphite and steel blue.'
  },
  aurora: {
    id: 'aurora',
    label: 'Aurora Glass',
    category: 'nature',
    shader: 'galaxy',
    description: 'Prismatic cyan over obsidian.'
  },
  'neon-crystal': {
    id: 'neon-crystal',
    label: 'Neon Crystal',
    category: 'neon',
    shader: 'galaxy',
    description: 'Glacial blue with focused violet.'
  },
  'liquid-glass': {
    id: 'liquid-glass',
    label: 'Liquid Glass',
    category: 'minimal',
    shader: 'solar',
    description: 'Fluid sapphire reflections.'
  },
  phosphor: {
    id: 'phosphor',
    label: 'Matrix Core',
    category: 'neon',
    shader: 'matrix',
    description: 'Terminal emerald on graphite.'
  }
}

/** Category metadata for grouping the preset grid. */
export const THEME_CATEGORIES: ReadonlyArray<{ id: ThemeCategory; label: string }> = [
  { id: 'neon', label: 'Neon' },
  { id: 'nature', label: 'Nature' },
  { id: 'warm', label: 'Warm' },
  { id: 'minimal', label: 'Minimal' }
]

const FALLBACK: ThemeConfig = {
  id: 'obsidian',
  label: 'Dark Pro',
  category: 'minimal',
  shader: 'none',
  description: 'Quiet graphite and steel blue.'
}

export function themeConfig(id: string): ThemeConfig {
  return (THEME_CONFIGS as Record<string, ThemeConfig>)[id] ?? FALLBACK
}

export interface ShaderPolicy {
  /** The user's Live background switch. */
  liveBackground: boolean
  /** Effective Eco-Saver state (manual switch or battery auto-detect). */
  eco: boolean
  /** OS-level reduced-motion preference. */
  reducedMotion: boolean
}

export interface ShaderDecision {
  shader: ShaderKind
  /** Why the shader is off, so the UI can explain it instead of looking broken. */
  reason: 'active' | 'theme-static' | 'disabled' | 'eco' | 'reduced-motion'
}

/**
 * Decide whether a live background may run.
 *
 * Precedence is deliberate: the user's off switch beats everything, then
 * Eco-Saver, then reduced-motion, and only then the theme's own preference. A
 * theme must never be able to outvote a power-saving decision — that is the
 * whole point of the inverter safeguard.
 */
export function resolveShader(id: string, policy: ShaderPolicy): ShaderDecision {
  const config = themeConfig(id)
  if (!policy.liveBackground) return { shader: 'none', reason: 'disabled' }
  if (policy.eco) return { shader: 'none', reason: 'eco' }
  if (policy.reducedMotion) return { shader: 'none', reason: 'reduced-motion' }
  if (config.shader === 'none') return { shader: 'none', reason: 'theme-static' }
  return { shader: config.shader, reason: 'active' }
}

export interface BackdropDecision extends ShaderDecision {
  /** What the canvas paints: the animated shader, a static frame, or nothing. */
  paintShader: ShaderKind
  /** True when the canvas must draw once and never request another frame. */
  paused: boolean
}

/**
 * Turn a shader decision into what the canvas should actually paint.
 *
 * A paused backdrop is still worth one themed frame — it keeps glass surfaces
 * looking lit without a single repaint. Only an explicit "off" (or a theme that
 * has no shader of its own) removes the canvas entirely, which keeps the
 * Eco-Saver from costing beauty it does not have to.
 */
export function resolveBackdrop(id: string, policy: ShaderPolicy): BackdropDecision {
  const decision = resolveShader(id, policy)
  const themeShader = themeConfig(id).shader
  const paused = decision.shader === 'none' && policy.liveBackground && themeShader !== 'none'
  const paintShader: ShaderKind = decision.shader !== 'none' ? decision.shader : paused ? themeShader : 'none'
  return { ...decision, paintShader, paused }
}

// ---------------------------------------------------------------------------
// Shader geometry — pure, so the renderers stay a thin drawing layer
// ---------------------------------------------------------------------------

/** Cap on device-pixel-ratio scaling: beyond 2 the cost buys nothing visible. */
export const MAX_DPR = 2

export function pixelRatio(devicePixelRatio: number | undefined): number {
  const ratio = typeof devicePixelRatio === 'number' && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1
  return Math.min(Math.max(ratio, 1), MAX_DPR)
}

/**
 * Star count for a viewport area.
 *
 * Density is per megapixel and bounded at both ends: a 4K window must not spawn
 * 40k particles on an integrated GPU, and a small window should not look empty.
 */
export function starCount(width: number, height: number, densityPerMegapixel = 260): number {
  const megapixels = Math.max((width * height) / 1_000_000, 0)
  return Math.round(Math.min(Math.max(megapixels * densityPerMegapixel, 40), 900))
}

/**
 * Number of Matrix rain columns for a viewport.
 *
 * Column width follows the font size, so a narrow window gets fewer, wider
 * columns rather than unreadable slivers.
 */
export function matrixColumns(width: number, fontSize = 15): number {
  const size = Math.max(fontSize, 8)
  return Math.max(Math.floor(width / size), 4)
}

/**
 * Code-rain glyphs: halfwidth katakana plus digits.
 *
 * They are deliberately all single-width, so a column keeps a stable footprint
 * and the rain cannot jitter the layout as characters are swapped.
 */
export const MATRIX_GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'

export function randomGlyph(rand: () => number = Math.random): string {
  return MATRIX_GLYPHS[Math.floor(rand() * MATRIX_GLYPHS.length)] ?? '0'
}

/**
 * Frame-rate independent fall speed.
 *
 * Particles are advanced with `speed * delta / 16.7`, so a 144 Hz display does
 * not animate three times faster than a 60 Hz one.
 */
export function advance(position: number, speed: number, deltaMs: number): number {
  const step = Math.min(Math.max(deltaMs, 0), 64) / 16.6667
  return position + speed * step
}

/** Clamp a `deltaMs` from rAF so a stalled tab does not teleport particles. */
export function clampDelta(deltaMs: number): number {
  return Math.min(Math.max(deltaMs, 0), 64)
}
