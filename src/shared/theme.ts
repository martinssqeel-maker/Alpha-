/**
 * Alpha's semantic color palettes. Components consume the semantic variables;
 * each preset remaps the same variables without changing component styles.
 *
 * `group` is presentation-only: it groups the gallery cards in Settings →
 * Appearance. Every concrete entry below is validated by `tests/theme.test.ts`
 * against the same contrast gates, so adding a preset cannot quietly ship an
 * unreadable palette.
 */
export const THEME_OPTIONS = [
  { id: 'system', label: 'System', group: 'Essentials', description: 'Follow the Windows appearance setting.' },
  { id: 'dark', label: 'Dark', group: 'Essentials', description: 'Quiet charcoal with Alpha indigo.' },
  { id: 'light', label: 'Light', group: 'Essentials', description: 'Clear neutral surfaces for bright rooms.' },
  { id: 'alpine', label: 'Alpine', group: 'Dark', description: 'Cool graphite with a crisp mineral accent.' },
  { id: 'tide', label: 'Tide', group: 'Dark', description: 'Deep blue-green surfaces with a clear aqua accent.' },
  { id: 'after-rain', label: 'After Rain', group: 'Dark', description: 'Washed slate blue, cool and low-contrast by design.' },
  { id: 'kanagawa', label: 'Kanagawa', group: 'Dark', description: 'Sumi-ink navy with a classic indigo accent.' },
  { id: 'orbit', label: 'Orbit', group: 'Dark', description: 'Deep space indigo with an electric violet accent.' },
  { id: 'violet-hour', label: 'Violet Hour', group: 'Dark', description: 'Dusk plum with a soft orchid accent.' },
  { id: 'aurora', label: 'Aurora', group: 'Dark', description: 'Near-black polar sky with a northern-green accent.' },
  { id: 'phosphor', label: 'Phosphor', group: 'Dark', description: 'CRT terminal black with a phosphor-green accent.' },
  { id: 'dune', label: 'Dune', group: 'Warm', description: 'Warm stone with a restrained amber accent.' },
  { id: 'ember', label: 'Ember', group: 'Warm', description: 'Warm charcoal with a measured coral accent.' },
  { id: 'blossom', label: 'Blossom', group: 'Warm', description: 'Muted rose surfaces with a soft pink accent.' },
  { id: 'mirage', label: 'Mirage', group: 'Light', description: 'Warm sand light theme with a deep teal accent.' }
] as const

export type ThemePreference = (typeof THEME_OPTIONS)[number]['id']
export const RESOLVED_THEME_OPTIONS = [
  'dark',
  'light',
  'alpine',
  'tide',
  'after-rain',
  'kanagawa',
  'orbit',
  'violet-hour',
  'aurora',
  'phosphor',
  'dune',
  'ember',
  'blossom',
  'mirage'
] as const
export type ResolvedTheme = (typeof RESOLVED_THEME_OPTIONS)[number]

export type ThemeTokens = Record<
  | '--surface-0'
  | '--surface-1'
  | '--surface-2'
  | '--surface-3'
  | '--text-primary'
  | '--text-secondary'
  | '--text-tertiary'
  | '--text-disabled'
  | '--text-on-accent'
  | '--border-subtle'
  | '--border-strong'
  | '--accent'
  | '--accent-hover'
  | '--accent-active'
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
  semantic: { success: string; warning: string; danger: string; info: string }
  code: { keyword: string; string: string; number: string; title: string; comment: string; attribute: string }
  shadow: string
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
    '--text-primary': p.text[0],
    '--text-secondary': p.text[1],
    '--text-tertiary': p.text[2],
    '--text-disabled': p.text[3],
    '--text-on-accent': p.textOnAccent,
    '--border-subtle': p.borders[0],
    '--border-strong': p.borders[1],
    '--accent': accent,
    '--accent-hover': accentHover,
    '--accent-active': accentActive,
    '--accent-subtle-bg': tint(accent, 14),
    '--success': p.semantic.success,
    '--success-subtle-bg': tint(p.semantic.success, 12),
    '--warning': p.semantic.warning,
    '--warning-subtle-bg': tint(p.semantic.warning, 12),
    '--danger': p.semantic.danger,
    '--danger-subtle-bg': tint(p.semantic.danger, 12),
    '--info': p.semantic.info,
    '--info-subtle-bg': tint(p.semantic.info, 12),
    '--focus-ring': accentHover,
    '--modal-scrim': 'rgba(0, 0, 0, 0.48)',
    '--composer-bg': surface1,
    '--terminal-bg': surface0,
    '--diff-add-bg': tint(p.semantic.success, 12),
    '--diff-delete-bg': tint(p.semantic.danger, 12),
    '--shadow-raised': `0 1px 2px ${p.shadow}, 0 8px 20px ${p.shadow}`,
    '--shadow-popover': `0 12px 32px ${p.shadow}`,
    '--shadow-modal': `0 20px 56px ${p.shadow}`,
    '--code-keyword': p.code.keyword,
    '--code-string': p.code.string,
    '--code-number': p.code.number,
    '--code-title': p.code.title,
    '--code-comment': p.code.comment,
    '--code-attribute': p.code.attribute
  }
}

export const THEME_TOKENS: Record<ResolvedTheme, ThemeTokens> = {
  dark: palette({
    surfaces: ['#0b0d12', '#11141d', '#161a25', '#1c2130'],
    text: ['#eff2f8', '#c7cfde', '#98a2b5', '#7e899d'],
    textOnAccent: '#101322',
    borders: ['#252b38', '#374052'],
    accent: ['#8995ff', '#a5aeff', '#727ff0'],
    semantic: { success: '#50d7a1', warning: '#ffd06b', danger: '#ff8588', info: '#7bbcff' },
    code: { keyword: '#b4a0ff', string: '#87d7b0', number: '#edbd78', title: '#87b8ff', comment: '#8793a6', attribute: '#8ad4e6' },
    shadow: 'rgba(0, 0, 0, 0.28)'
  }),
  light: palette({
    surfaces: ['#f5f6f8', '#ffffff', '#f1f3f7', '#e8ebf1'],
    text: ['#171a22', '#384252', '#566174', '#5d6879'],
    textOnAccent: '#ffffff',
    borders: ['#dfe3e9', '#c8ced9'],
    accent: ['#4d58c7', '#404ab4', '#333da3'],
    semantic: { success: '#087a53', warning: '#8b5b08', danger: '#b4232d', info: '#2457a6' },
    code: { keyword: '#674bb2', string: '#087a53', number: '#92551b', title: '#2457a6', comment: '#687487', attribute: '#08758a' },
    shadow: 'rgba(22, 31, 49, 0.10)'
  }),
  alpine: palette({
    surfaces: ['#0a1013', '#10191d', '#172328', '#203037'],
    text: ['#eff8f8', '#c6d8da', '#9bb4b7', '#829c9f'],
    textOnAccent: '#0a191a',
    borders: ['#26383c', '#385054'],
    accent: ['#73c8c7', '#91ddda', '#59b0b2'],
    semantic: { success: '#66d5a5', warning: '#f4ca70', danger: '#ff8b8a', info: '#83c8f1' },
    code: { keyword: '#b8a8ff', string: '#83d9b1', number: '#e9c77e', title: '#8dc6ff', comment: '#8da1a4', attribute: '#80d4df' },
    shadow: 'rgba(0, 0, 0, 0.32)'
  }),
  dune: palette({
    surfaces: ['#15110d', '#1d1813', '#282019', '#342a20'],
    text: ['#fff7eb', '#e4d3bd', '#b9a78f', '#a29682'],
    textOnAccent: '#27180b',
    borders: ['#3a3025', '#514332'],
    accent: ['#e7ae69', '#f5c17e', '#d59650'],
    semantic: { success: '#79d0a2', warning: '#ffd078', danger: '#ff9587', info: '#83c7df' },
    code: { keyword: '#d2a5ff', string: '#8bd6a9', number: '#f4c37c', title: '#8fc6ec', comment: '#a39889', attribute: '#89d2d8' },
    shadow: 'rgba(0, 0, 0, 0.34)'
  }),
  tide: palette({
    surfaces: ['#091219', '#0e1b24', '#142631', '#1b3441'],
    text: ['#eff8ff', '#c8d9e8', '#96afc1', '#86a2b4'],
    textOnAccent: '#07171b',
    borders: ['#233946', '#345263'],
    accent: ['#6ac8d9', '#8ad9e5', '#4bb0c4'],
    semantic: { success: '#62d2a0', warning: '#f6cb6e', danger: '#ff898d', info: '#7bbdf5' },
    code: { keyword: '#c3a4ff', string: '#7edcaf', number: '#f1c374', title: '#8ac6ff', comment: '#89a3b2', attribute: '#70d2dc' },
    shadow: 'rgba(0, 0, 0, 0.34)'
  }),
  ember: palette({
    surfaces: ['#151010', '#1e1615', '#2a1e1c', '#382522'],
    text: ['#fff4f0', '#e5cbc4', '#bda39b', '#a68a82'],
    textOnAccent: '#28120e',
    borders: ['#3c2c29', '#563b35'],
    accent: ['#f39a78', '#ffb08f', '#dc805f'],
    semantic: { success: '#78cf9d', warning: '#f8cb6f', danger: '#ff9089', info: '#83c4df' },
    code: { keyword: '#d2a0ff', string: '#88d6a6', number: '#f5bf77', title: '#8bc2f4', comment: '#a58d85', attribute: '#83cfd7' },
    shadow: 'rgba(0, 0, 0, 0.36)'
  }),
  'after-rain': palette({
    surfaces: ['#0a0f13', '#111a1f', '#18242b', '#213039'],
    text: ['#eef4f6', '#c8d5da', '#a2b3bb', '#94a7af'],
    textOnAccent: '#08161b',
    borders: ['#243139', '#35454e'],
    accent: ['#8fc7d9', '#aadcec', '#6fb0c6'],
    semantic: { success: '#64d3a5', warning: '#f4cc74', danger: '#ff8f92', info: '#85c3ee' },
    code: { keyword: '#b9a8ff', string: '#86dcb4', number: '#eec47c', title: '#8ec7ff', comment: '#8ea1a9', attribute: '#7cd3dd' },
    shadow: 'rgba(0, 0, 0, 0.34)'
  }),
  kanagawa: palette({
    surfaces: ['#10101a', '#16161f', '#1f1f2c', '#2a2a3a'],
    text: ['#f8f4e3', '#cdc7af', '#aaa692', '#9e9a86'],
    textOnAccent: '#13131a',
    borders: ['#2c2c3b', '#3d3d52'],
    accent: ['#8fb0e6', '#a8c4f2', '#7199d6'],
    semantic: { success: '#9ac06e', warning: '#e8c786', danger: '#ec7c88', info: '#83b8ce' },
    code: { keyword: '#c9a6ff', string: '#9dc47c', number: '#e8c787', title: '#8fb4e6', comment: '#94907c', attribute: '#86c6d2' },
    shadow: 'rgba(0, 0, 0, 0.38)'
  }),
  orbit: palette({
    surfaces: ['#0c0b18', '#131228', '#1b1a37', '#252349'],
    text: ['#eef0ff', '#ccceef', '#a6a8d4', '#989ac8'],
    textOnAccent: '#0e0b26',
    borders: ['#2b2a4e', '#3f3e6b'],
    accent: ['#9a9bff', '#b2b3ff', '#8283ec'],
    semantic: { success: '#68d6a6', warning: '#f6cd74', danger: '#ff8d93', info: '#8bb8ff' },
    code: { keyword: '#cbb0ff', string: '#8adeb8', number: '#f2c882', title: '#8fb6ff', comment: '#9295bd', attribute: '#86d0e4' },
    shadow: 'rgba(0, 0, 0, 0.4)'
  }),
  'violet-hour': palette({
    surfaces: ['#120e1a', '#1a1426', '#241c34', '#302543'],
    text: ['#f2ecff', '#d6cbea', '#aca0c7', '#a094b9'],
    textOnAccent: '#1a0f2c',
    borders: ['#332847', '#493a60'],
    accent: ['#b792f0', '#cbaaff', '#9d76da'],
    semantic: { success: '#6dd6a4', warning: '#f7cb76', danger: '#ff8f9c', info: '#8fbcf7' },
    code: { keyword: '#d9aaff', string: '#8adfb6', number: '#f3c67f', title: '#93beff', comment: '#9689ab', attribute: '#88d0e2' },
    shadow: 'rgba(0, 0, 0, 0.38)'
  }),
  aurora: palette({
    surfaces: ['#080d0e', '#0e1617', '#142123', '#1b2c2f'],
    text: ['#e9f7f4', '#c0e0da', '#93bfb8', '#86b2ab'],
    textOnAccent: '#06170f',
    borders: ['#1f2f32', '#2f4549'],
    accent: ['#63d8b2', '#81ecc8', '#45c098'],
    semantic: { success: '#63d8b2', warning: '#f3cd76', danger: '#ff8f8f', info: '#83c8e8' },
    code: { keyword: '#b7a8ff', string: '#74e0b4', number: '#ecc57c', title: '#88c6f6', comment: '#8aa4a0', attribute: '#7ad4d6' },
    shadow: 'rgba(0, 0, 0, 0.36)'
  }),
  phosphor: palette({
    surfaces: ['#050806', '#0a0f0b', '#111810', '#182218'],
    text: ['#def8e4', '#b9ddc2', '#90bb9e', '#85af93'],
    textOnAccent: '#04170a',
    borders: ['#1a261c', '#28402d'],
    accent: ['#54e887', '#72ffa4', '#38c96d'],
    semantic: { success: '#54e887', warning: '#f0cd78', danger: '#ff8b8b', info: '#82c8e6' },
    code: { keyword: '#bda8ff', string: '#6ee39a', number: '#eec57a', title: '#88c8f4', comment: '#87a48e', attribute: '#78d2cf' },
    shadow: 'rgba(0, 0, 0, 0.42)'
  }),
  blossom: palette({
    surfaces: ['#140e13', '#1c141b', '#271c26', '#342431'],
    text: ['#fdf2f7', '#e7d3dc', '#c5a8b7', '#b79dab'],
    textOnAccent: '#2b0d1c',
    borders: ['#3a2833', '#553b4b'],
    accent: ['#f58fb9', '#ffaacc', '#dd6f9e'],
    semantic: { success: '#67d3a3', warning: '#f7cd76', danger: '#ff8f99', info: '#86c6ea' },
    code: { keyword: '#d9a8ff', string: '#8cdcb2', number: '#f2c47c', title: '#8fc6ff', comment: '#a48d9a', attribute: '#86d3da' },
    shadow: 'rgba(0, 0, 0, 0.36)'
  }),
  mirage: palette({
    surfaces: ['#faf6ef', '#ffffff', '#f4ede1', '#eadfcd'],
    text: ['#1d1710', '#463b2d', '#685c48', '#655845'],
    textOnAccent: '#ffffff',
    borders: ['#e2d8c6', '#cdbfa6'],
    accent: ['#0f766e', '#0d625c', '#0a4f4a'],
    semantic: { success: '#0f6f46', warning: '#8a5a06', danger: '#b03030', info: '#1f5f96' },
    code: { keyword: '#6a4fa8', string: '#0f6f46', number: '#8f5414', title: '#1f5f96', comment: '#6d6350', attribute: '#0f6a72' },
    shadow: 'rgba(60, 40, 12, 0.12)'
  })
}

export function resolveTheme(theme: ThemePreference, prefersDark: boolean): ResolvedTheme {
  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme
}
