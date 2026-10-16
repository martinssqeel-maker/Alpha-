/**
 * Alpha's semantic palette system. Curated presets share one token
 * contract; legacy preference IDs remain resolvable so existing settings never
 * strand a user on an unknown palette.
 */
export const THEME_OPTIONS = [
  { id: 'system', label: 'System', group: 'System', description: 'Follow your Windows light or dark preference.' },
  { id: 'solar-flare', label: 'Solar Flare', group: 'Cinematic', description: 'Molten amber, champagne light, and blackened glass.' },
  { id: 'cosmic-indigo', label: 'Galaxy Pulse', group: 'Cinematic', description: 'Ultramarine depth with spectral violet and magenta.' },
  { id: 'forest-haven', label: 'Forest Haven', group: 'Organic', description: 'Emerald glass, quiet jade, and deep botanical greens.' },
  { id: 'sunset-breeze', label: 'Sunset Breeze', group: 'Cinematic', description: 'Burnished coral, apricot light, and dusk plum.' },
  { id: 'cyber-matrix', label: 'Cyber Matrix', group: 'Neon', description: 'Electric blue, ultraviolet, and precise hot-pink signals.' },
  { id: 'arctic-glass', label: 'Glass Elegance', group: 'Light', description: 'Icy porcelain, clear blue, and lucid glass surfaces.' },
  { id: 'neon-wave', label: 'Neon Wave', group: 'Neon', description: 'Ion cyan and deep-ocean blue with a magenta edge.' },
  { id: 'obsidian', label: 'Dark Pro', group: 'Studio', description: 'Quiet graphite, steel blue, and uncompromising contrast.' },
  { id: 'aurora', label: 'Aurora Glass', group: 'Signature', description: 'Prismatic cyan and ultraviolet over obsidian.' },
  { id: 'neon-crystal', label: 'Neon Crystal', group: 'Neon', description: 'Glacial blue, cut-glass surfaces, and focused violet.' },
  { id: 'liquid-glass', label: 'Liquid Glass', group: 'Glass', description: 'Fluid sapphire reflections and cool translucent layers.' },
  { id: 'phosphor', label: 'Matrix Core', group: 'Studio', description: 'Terminal emerald, blackened graphite, and focused clarity.' }
] as const

export const RESOLVED_THEME_OPTIONS = [
  'solar-flare',
  'forest-haven',
  'sunset-breeze',
  'cyber-matrix',
  'neon-wave',
  'neon-crystal',
  'liquid-glass',
  'aurora',
  'obsidian',
  'cosmic-indigo',
  'phosphor',
  'arctic-glass'
] as const

export type ResolvedTheme = (typeof RESOLVED_THEME_OPTIONS)[number]
export type AppearanceMode = 'system' | 'dark' | 'light'
export type AccentChoice = 'theme' | 'gold' | 'amber' | 'cyan' | 'blue' | 'violet' | 'magenta' | 'emerald' | 'rose' | 'custom'
export interface AppearanceSettings {
  mode: AppearanceMode
  accent: AccentChoice
  customAccent: string
  density: 'comfortable' | 'compact'
  corners: 'soft' | 'crisp'
  glassIntensity: number
  glowIntensity: number
  ambientLighting: boolean
  animations: boolean
  animatedGradients: boolean
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  mode: 'system',
  accent: 'theme',
  customAccent: '#ffb52e',
  density: 'comfortable',
  corners: 'soft',
  glassIntensity: 55,
  glowIntensity: 42,
  ambientLighting: true,
  animations: true,
  animatedGradients: false
}

export function normalizeAppearanceSettings(value: unknown): AppearanceSettings {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<AppearanceSettings>
    : {}
  const modes: AppearanceMode[] = ['system', 'dark', 'light']
  const accents: AccentChoice[] = ['theme', 'gold', 'amber', 'cyan', 'blue', 'violet', 'magenta', 'emerald', 'rose', 'custom']
  const clamp = (number: unknown, fallback: number): number =>
    typeof number === 'number' && Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : fallback
  return {
    mode: modes.includes(input.mode as AppearanceMode) ? input.mode as AppearanceMode : DEFAULT_APPEARANCE_SETTINGS.mode,
    accent: accents.includes(input.accent as AccentChoice) ? input.accent as AccentChoice : DEFAULT_APPEARANCE_SETTINGS.accent,
    customAccent: typeof input.customAccent === 'string' && /^#[\da-f]{6}$/i.test(input.customAccent) ? input.customAccent : DEFAULT_APPEARANCE_SETTINGS.customAccent,
    density: input.density === 'compact' || input.density === 'comfortable' ? input.density : DEFAULT_APPEARANCE_SETTINGS.density,
    corners: input.corners === 'crisp' || input.corners === 'soft' ? input.corners : DEFAULT_APPEARANCE_SETTINGS.corners,
    glassIntensity: clamp(input.glassIntensity, DEFAULT_APPEARANCE_SETTINGS.glassIntensity),
    glowIntensity: clamp(input.glowIntensity, DEFAULT_APPEARANCE_SETTINGS.glowIntensity),
    ambientLighting: typeof input.ambientLighting === 'boolean' ? input.ambientLighting : DEFAULT_APPEARANCE_SETTINGS.ambientLighting,
    animations: typeof input.animations === 'boolean' ? input.animations : DEFAULT_APPEARANCE_SETTINGS.animations,
    animatedGradients: typeof input.animatedGradients === 'boolean' ? input.animatedGradients : DEFAULT_APPEARANCE_SETTINGS.animatedGradients
  }
}
type LegacyTheme =
  | 'dark'
  | 'light'
  | 'alpine'
  | 'tide'
  | 'after-rain'
  | 'kanagawa'
  | 'orbit'
  | 'violet-hour'
  | 'dune'
  | 'ember'
  | 'blossom'
  | 'mirage'
export type ThemePreference = (typeof THEME_OPTIONS)[number]['id'] | LegacyTheme

export type ThemeTokens = Record<
  | '--surface-0'
  | '--surface-1'
  | '--surface-2'
  | '--surface-3'
  | '--surface-glass'
  | '--text-primary'
  | '--text-secondary'
  | '--text-tertiary'
  | '--text-disabled'
  | '--text-on-accent'
  | '--border-subtle'
  | '--border-strong'
  | '--glass-border'
  | '--ambient-light'
  | '--accent'
  | '--accent-hover'
  | '--accent-active'
  | '--accent-secondary'
  | '--accent-gradient'
  | '--accent-glow'
  | '--accent-subtle-bg'
  | '--success'
  | '--success-subtle-bg'
  | '--warning'
  | '--warning-subtle-bg'
  | '--danger'
  | '--danger-subtle-bg'
  | '--info'
  | '--info-subtle-bg'
  | '--focus-ring'
  | '--modal-scrim'
  | '--composer-bg'
  | '--terminal-bg'
  | '--diff-add-bg'
  | '--diff-delete-bg'
  | '--shadow-raised'
  | '--shadow-popover'
  | '--shadow-modal'
  | '--code-keyword'
  | '--code-string'
  | '--code-number'
  | '--code-title'
  | '--code-comment'
  | '--code-attribute',
  string
>

interface Palette {
  surfaces: [string, string, string, string]
  text: [string, string, string, string]
  textOnAccent: string
  borders: [string, string]
  accent: [string, string, string]
  accentSecondary: string
  semantic: { success: string; warning: string; danger: string; info: string }
  code: { keyword: string; string: string; number: string; title: string; comment: string; attribute: string }
  shadow: string
  ambient: string
}

function palette(p: Palette): ThemeTokens {
  const [surface0, surface1, surface2, surface3] = p.surfaces
  const [accent, accentHover, accentActive] = p.accent
  const tint = (color: string, amount: number): string =>
    `color-mix(in srgb, ${color} ${amount}%, ${surface1})`

  return {
    '--surface-0': surface0,
    '--surface-1': surface1,
    '--surface-2': surface2,
    '--surface-3': surface3,
    '--surface-glass': `color-mix(in srgb, ${surface1} 84%, transparent)`,
    '--text-primary': p.text[0],
    '--text-secondary': p.text[1],
    '--text-tertiary': p.text[2],
    '--text-disabled': p.text[3],
    '--text-on-accent': p.textOnAccent,
    '--border-subtle': p.borders[0],
    '--border-strong': p.borders[1],
    '--glass-border': `color-mix(in srgb, ${p.accentSecondary} 24%, ${p.borders[0]})`,
    '--ambient-light': p.ambient,
    '--accent': accent,
    '--accent-hover': accentHover,
    '--accent-active': accentActive,
    '--accent-secondary': p.accentSecondary,
    '--accent-gradient': `linear-gradient(112deg, ${accent} 0%, ${p.accentSecondary} 100%)`,
    '--accent-glow': `color-mix(in srgb, ${accent} 28%, transparent)`,
    '--accent-subtle-bg': tint(accent, 14),
    '--success': p.semantic.success,
    '--success-subtle-bg': tint(p.semantic.success, 12),
    '--warning': p.semantic.warning,
    '--warning-subtle-bg': tint(p.semantic.warning, 12),
    '--danger': p.semantic.danger,
    '--danger-subtle-bg': tint(p.semantic.danger, 12),
    '--info': p.semantic.info,
    '--info-subtle-bg': tint(p.semantic.info, 12),
    '--focus-ring': p.accentSecondary,
    '--modal-scrim': 'rgba(1, 3, 9, 0.68)',
    '--composer-bg': `color-mix(in srgb, ${surface1} 94%, ${accent} 6%)`,
    '--terminal-bg': surface0,
    '--diff-add-bg': tint(p.semantic.success, 12),
    '--diff-delete-bg': tint(p.semantic.danger, 12),
    '--shadow-raised': `0 1px 2px ${p.shadow}, 0 10px 28px ${p.shadow}`,
    '--shadow-popover': `0 16px 40px ${p.shadow}`,
    '--shadow-modal': `0 24px 64px ${p.shadow}`,
    '--code-keyword': p.code.keyword,
    '--code-string': p.code.string,
    '--code-number': p.code.number,
    '--code-title': p.code.title,
    '--code-comment': p.code.comment,
    '--code-attribute': p.code.attribute
  }
}

export const THEME_TOKENS: Record<ResolvedTheme, ThemeTokens> = {
  aurora: palette({
    surfaces: ['#070a12', '#0c1220', '#111a2a', '#172335'],
    text: ['#f1f6ff', '#cad6ea', '#9badca', '#8495b2'],
    textOnAccent: '#041519',
    borders: ['#202b3d', '#35445b'],
    accent: ['#55f3e8', '#7df8f4', '#3dd8dd'],
    accentSecondary: '#9b72ff',
    semantic: { success: '#50e3a0', warning: '#ffd276', danger: '#ff8795', info: '#7ec5ff' },
    code: { keyword: '#bd9cff', string: '#67e7ad', number: '#f3c976', title: '#84c8ff', comment: '#8798b2', attribute: '#6de3e5' },
    shadow: 'rgba(0, 0, 0, 0.44)', ambient: 'rgba(67, 207, 232, 0.14)'
  }),
  obsidian: palette({
    surfaces: ['#08090c', '#101319', '#181d26', '#202833'],
    text: ['#f2f5f9', '#cbd2dc', '#a6b0bf', '#8d98a9'],
    textOnAccent: '#071022',
    borders: ['#252c37', '#3a4554'],
    accent: ['#4d7cff', '#77a0ff', '#4e80ff'],
    accentSecondary: '#77c8ff',
    semantic: { success: '#55dda0', warning: '#f4c768', danger: '#ff858d', info: '#79c7ff' },
    code: { keyword: '#b7a1ff', string: '#68d8a2', number: '#eebe72', title: '#84bbff', comment: '#8994a4', attribute: '#76cbd9' },
    shadow: 'rgba(0, 0, 0, 0.46)', ambient: 'rgba(80, 126, 255, 0.08)'
  }),
  'cosmic-indigo': palette({
    surfaces: ['#090817', '#111027', '#191837', '#242246'],
    text: ['#f3f1ff', '#d2cff4', '#aeaddd', '#9694c4'],
    textOnAccent: '#0b0b25',
    borders: ['#2b294c', '#413e70'],
    accent: ['#9295ff', '#b4b4ff', '#7378ed'],
    accentSecondary: '#bd78ff',
    semantic: { success: '#63dda5', warning: '#f4ce78', danger: '#ff899c', info: '#88bfff' },
    code: { keyword: '#c9a4ff', string: '#77dda9', number: '#f1c77a', title: '#96b6ff', comment: '#9693bb', attribute: '#80d5e8' },
    shadow: 'rgba(2, 1, 15, 0.5)', ambient: 'rgba(126, 89, 255, 0.16)'
  }),
  phosphor: palette({
    surfaces: ['#060a08', '#0d1510', '#142019', '#1c2a20'],
    text: ['#ecf7ef', '#c8dfcd', '#a2c3aa', '#8eae97'],
    textOnAccent: '#05130a',
    borders: ['#26382b', '#3d5945'],
    accent: ['#42e887', '#78f6a8', '#31c96c'],
    accentSecondary: '#a0f6bd',
    semantic: { success: '#55e795', warning: '#f2cf75', danger: '#ff8d8c', info: '#82c8e7' },
    code: { keyword: '#c0a5ff', string: '#65e69b', number: '#edc77e', title: '#88c8f1', comment: '#8ca391', attribute: '#7dd5ce' },
    shadow: 'rgba(0, 0, 0, 0.48)', ambient: 'rgba(66, 232, 135, 0.1)'
  }),
  'arctic-glass': palette({
    surfaces: ['#f3f7fc', '#fbfdff', '#eaf0f8', '#dfe8f3'],
    text: ['#101827', '#26364b', '#435671', '#51627a'],
    textOnAccent: '#061522',
    borders: ['#d5deeb', '#b9c8dc'],
    accent: ['#4e82ff', '#6998ff', '#4e82ff'],
    accentSecondary: '#24bada',
    semantic: { success: '#08754e', warning: '#815000', danger: '#b42332', info: '#1757a5' },
    code: { keyword: '#6842ad', string: '#08754e', number: '#855019', title: '#1559a8', comment: '#65748a', attribute: '#087a8d' },
    shadow: 'rgba(20, 39, 70, 0.12)', ambient: 'rgba(74, 163, 255, 0.12)'
  }),
  'solar-flare': palette({
    surfaces: ['#0b0907', '#15110d', '#21190f', '#2d2113'],
    text: ['#fff7e8', '#e8d9c0', '#c5b392', '#a89673'], textOnAccent: '#241506',
    borders: ['#382919', '#594020'], accent: ['#ffb52e', '#ffd16c', '#e89116'], accentSecondary: '#ff791f',
    semantic: { success: '#67d59b', warning: '#ffcf70', danger: '#ff8885', info: '#86c8ff' },
    code: { keyword: '#e9a4ff', string: '#75dc9a', number: '#ffd177', title: '#83c9ff', comment: '#a69377', attribute: '#ffb64e' },
    shadow: 'rgba(0, 0, 0, 0.5)', ambient: 'rgba(255, 151, 35, 0.19)'
  }),
  'forest-haven': palette({
    surfaces: ['#07100d', '#0d1914', '#14241c', '#1c3025'],
    text: ['#effaf1', '#cce4d1', '#a4c4ad', '#8cae97'], textOnAccent: '#062016',
    borders: ['#21392c', '#365844'], accent: ['#4de29a', '#7df2b5', '#30bf78'], accentSecondary: '#b1df62',
    semantic: { success: '#6bea9e', warning: '#e9d17b', danger: '#ff898d', info: '#83c9e6' },
    code: { keyword: '#c6a0ff', string: '#70e1a0', number: '#e9cf7a', title: '#85c8ea', comment: '#89a997', attribute: '#a3e47a' },
    shadow: 'rgba(0, 0, 0, 0.48)', ambient: 'rgba(56, 221, 134, 0.15)'
  }),
  'sunset-breeze': palette({
    surfaces: ['#11090d', '#1b1017', '#29151e', '#361b26'],
    text: ['#fff4f1', '#f0d5d2', '#c9aaa9', '#b29396'], textOnAccent: '#2b1114',
    borders: ['#44232a', '#66323a'], accent: ['#ff8a65', '#ffa98b', '#ed694b'], accentSecondary: '#f36bad',
    semantic: { success: '#6cdda1', warning: '#ffd176', danger: '#ff7b83', info: '#82c9ee' },
    code: { keyword: '#d5a1ff', string: '#78dfa4', number: '#ffd17f', title: '#8cc7ff', comment: '#ac929d', attribute: '#ff9a7f' },
    shadow: 'rgba(10, 0, 8, 0.5)', ambient: 'rgba(255, 91, 99, 0.17)'
  }),
  'cyber-matrix': palette({
    surfaces: ['#080912', '#10111e', '#181a2a', '#22243a'],
    text: ['#f4f5ff', '#d1d5f0', '#a8afd2', '#939abc'], textOnAccent: '#0a1023',
    borders: ['#282b47', '#3d4268'], accent: ['#58b9ff', '#88d3ff', '#388ee8'], accentSecondary: '#ec62e8',
    semantic: { success: '#55dfa2', warning: '#f3cc76', danger: '#ff7f94', info: '#78c6ff' },
    code: { keyword: '#dc8bff', string: '#68e5a5', number: '#f0cb78', title: '#71c4ff', comment: '#9299bd', attribute: '#ff77d1' },
    shadow: 'rgba(0, 0, 0, 0.48)', ambient: 'rgba(82, 91, 255, 0.15)'
  }),
  'neon-wave': palette({
    surfaces: ['#061019', '#0b1722', '#102330', '#173140'],
    text: ['#edfaff', '#c5e4f0', '#9dc1d2', '#86aebf'], textOnAccent: '#041a22',
    borders: ['#1d3945', '#2d5260'], accent: ['#35e4eb', '#6cf2f4', '#16b9d1'], accentSecondary: '#698dff',
    semantic: { success: '#52dfa5', warning: '#f1cf76', danger: '#ff8292', info: '#79c7ff' },
    code: { keyword: '#bba5ff', string: '#66e4a4', number: '#f1ca77', title: '#75d1ff', comment: '#83a4b8', attribute: '#43e5e5' },
    shadow: 'rgba(0, 0, 0, 0.46)', ambient: 'rgba(40, 204, 235, 0.17)'
  }),
  'neon-crystal': palette({
    surfaces: ['#080b16', '#101526', '#171e33', '#202a43'],
    text: ['#f1f5ff', '#d0daef', '#a9bad6', '#91a4c4'], textOnAccent: '#091428',
    borders: ['#25324d', '#384a6b'], accent: ['#79c9ff', '#a2ddff', '#51a7eb'], accentSecondary: '#a58aff',
    semantic: { success: '#53dda0', warning: '#f2ce76', danger: '#ff8797', info: '#78c5ff' },
    code: { keyword: '#c397ff', string: '#67dda1', number: '#efc974', title: '#7fc9ff', comment: '#8c9fbd', attribute: '#8be3ed' },
    shadow: 'rgba(0, 0, 0, 0.46)', ambient: 'rgba(101, 160, 255, 0.16)'
  }),
  'liquid-glass': palette({
    surfaces: ['#071019', '#0d1824', '#142231', '#1b2c3e'],
    text: ['#eff8ff', '#ccdfef', '#a4bfd5', '#8caac3'], textOnAccent: '#051725',
    borders: ['#213a4d', '#35556c'], accent: ['#58c4ff', '#8bdbff', '#35a8e3'], accentSecondary: '#5fddcf',
    semantic: { success: '#50dda3', warning: '#f0cf78', danger: '#ff8792', info: '#71c4ff' },
    code: { keyword: '#b7a4ff', string: '#66dda6', number: '#f1ca79', title: '#7ccfff', comment: '#88a8bf', attribute: '#5de0d6' },
    shadow: 'rgba(0, 0, 0, 0.44)', ambient: 'rgba(48, 177, 241, 0.16)'
  })
}

const LEGACY_THEME_MAP: Record<LegacyTheme, ResolvedTheme> = {
  dark: 'obsidian',
  light: 'arctic-glass',
  alpine: 'phosphor',
  tide: 'aurora',
  'after-rain': 'obsidian',
  kanagawa: 'cosmic-indigo',
  orbit: 'cosmic-indigo',
  'violet-hour': 'cosmic-indigo',
  dune: 'arctic-glass',
  ember: 'aurora',
  blossom: 'cosmic-indigo',
  mirage: 'arctic-glass'
}

export function resolveTheme(theme: ThemePreference | string, prefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return prefersDark ? 'obsidian' : 'arctic-glass'
  if (RESOLVED_THEME_OPTIONS.includes(theme as ResolvedTheme)) return theme as ResolvedTheme
  return LEGACY_THEME_MAP[theme as LegacyTheme] ?? 'solar-flare'
}

export function isLightTheme(theme: ResolvedTheme): boolean {
  return theme === 'arctic-glass'
}

const ACCENT_COLORS: Record<Exclude<AccentChoice, 'theme' | 'custom'>, string> = {
  gold: '#ffd166', amber: '#ff9f43', cyan: '#52e6e8', blue: '#5b9dff',
  violet: '#a98aff', magenta: '#ed72dc', emerald: '#50dc98', rose: '#ff7f9e'
}

function readableAccentText(hex: string): string {
  const color = hex.replace('#', '')
  if (!/^[\da-f]{6}$/i.test(color)) return '#10151f'
  const channels = [0, 2, 4].map((index) => Number.parseInt(color.slice(index, index + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2] > 0.48 ? '#10151f' : '#ffffff'
}

/** Resolve palette plus optional appearance-studio overrides into renderer tokens. */
export function createThemeTokens(theme: ResolvedTheme, appearance: AppearanceSettings = DEFAULT_APPEARANCE_SETTINGS, prefersDark = true): ThemeTokens {
  appearance = normalizeAppearanceSettings(appearance)
  const tokens: ThemeTokens = { ...THEME_TOKENS[theme] }
  const mode = appearance.mode === 'system'
    ? (prefersDark ? 'dark' : 'light')
    : appearance.mode

  const modePalette = mode === 'light'
    ? THEME_TOKENS['arctic-glass']
    : theme === 'arctic-glass' ? THEME_TOKENS.obsidian : null
  if (modePalette) {
    for (const key of [
      '--surface-0', '--surface-1', '--surface-2', '--surface-3', '--surface-glass',
      '--text-primary', '--text-secondary', '--text-tertiary', '--text-disabled',
      '--border-subtle', '--border-strong', '--glass-border', '--modal-scrim',
      '--composer-bg', '--terminal-bg', '--shadow-raised', '--shadow-popover', '--shadow-modal',
      '--code-keyword', '--code-string', '--code-number', '--code-title', '--code-comment', '--code-attribute'
    ] as const) tokens[key] = modePalette[key]
    tokens['--success'] = modePalette['--success']
    tokens['--warning'] = modePalette['--warning']
    tokens['--danger'] = modePalette['--danger']
    tokens['--info'] = modePalette['--info']
    tokens['--text-on-accent'] = modePalette['--text-on-accent']
    tokens['--ambient-light'] = modePalette['--ambient-light']
  }

  let accent: string | undefined
  if (appearance.accent === 'custom') {
    if (/^#[\da-f]{6}$/i.test(appearance.customAccent)) accent = appearance.customAccent
  } else if (appearance.accent !== 'theme') {
    accent = ACCENT_COLORS[appearance.accent]
  }
  if (accent) {
    const onAccent = readableAccentText(accent)
    tokens['--accent'] = accent
    tokens['--accent-hover'] = `color-mix(in srgb, ${accent} 82%, white)`
    tokens['--accent-active'] = `color-mix(in srgb, ${accent} 82%, black)`
    tokens['--accent-secondary'] = `color-mix(in srgb, ${accent} 48%, ${THEME_TOKENS[theme]['--accent-secondary']})`
    tokens['--accent-gradient'] = `linear-gradient(112deg, ${accent} 0%, ${tokens['--accent-secondary']} 100%)`
    tokens['--accent-subtle-bg'] = `color-mix(in srgb, ${accent} 13%, ${tokens['--surface-1']})`
    tokens['--glass-border'] = `color-mix(in srgb, ${accent} 28%, ${tokens['--border-subtle']})`
    tokens['--focus-ring'] = accent
    tokens['--text-on-accent'] = onAccent
  }

  const glassMix = Math.round(44 + Math.max(0, Math.min(100, appearance.glassIntensity)) * 0.5)
  tokens['--surface-glass'] = `color-mix(in srgb, ${tokens['--surface-1']} ${glassMix}%, transparent)`
  tokens['--glass-border'] = `color-mix(in srgb, ${tokens['--accent-secondary']} 24%, ${tokens['--border-subtle']})`
  tokens['--accent-subtle-bg'] = `color-mix(in srgb, ${tokens['--accent']} 14%, ${tokens['--surface-1']})`
  tokens['--success-subtle-bg'] = `color-mix(in srgb, ${tokens['--success']} 12%, ${tokens['--surface-1']})`
  tokens['--warning-subtle-bg'] = `color-mix(in srgb, ${tokens['--warning']} 12%, ${tokens['--surface-1']})`
  tokens['--danger-subtle-bg'] = `color-mix(in srgb, ${tokens['--danger']} 12%, ${tokens['--surface-1']})`
  tokens['--info-subtle-bg'] = `color-mix(in srgb, ${tokens['--info']} 12%, ${tokens['--surface-1']})`
  tokens['--composer-bg'] = `color-mix(in srgb, ${tokens['--surface-1']} 94%, ${tokens['--accent']} 6%)`
  tokens['--diff-add-bg'] = `color-mix(in srgb, ${tokens['--success']} 12%, ${tokens['--surface-1']})`
  tokens['--diff-delete-bg'] = `color-mix(in srgb, ${tokens['--danger']} 12%, ${tokens['--surface-1']})`
  tokens['--accent-glow'] = `color-mix(in srgb, ${tokens['--accent']} ${Math.round(Math.max(0, Math.min(100, appearance.glowIntensity)) * 0.5)}%, transparent)`
  tokens['--ambient-light'] = appearance.ambientLighting ? (modePalette?.['--ambient-light'] ?? THEME_TOKENS[theme]['--ambient-light']) : 'transparent'
  return tokens
}
