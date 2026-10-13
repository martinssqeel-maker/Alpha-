/**
 * Alpha's semantic color palettes. Components consume the semantic variables;
 * each preset remaps the same variables without changing component styles.
 */
export const THEME_OPTIONS = [
  { id: 'dark', label: 'Dark', description: 'Quiet charcoal with Alpha indigo.' },
  { id: 'light', label: 'Light', description: 'Clear neutral surfaces for bright rooms.' },
  { id: 'system', label: 'System', description: 'Follow the Windows appearance setting.' },
  { id: 'alpine', label: 'Alpine', description: 'Cool graphite with a crisp mineral accent.' },
  { id: 'dune', label: 'Dune', description: 'Warm stone with a restrained amber accent.' },
  { id: 'tide', label: 'Tide', description: 'Deep blue-green surfaces with a clear aqua accent.' },
  { id: 'ember', label: 'Ember', description: 'Warm charcoal with a measured coral accent.' }
] as const

export type ThemePreference = (typeof THEME_OPTIONS)[number]['id']
export const RESOLVED_THEME_OPTIONS = ['dark', 'light', 'alpine', 'dune', 'tide', 'ember'] as const
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
  })
}

export function resolveTheme(theme: ThemePreference, prefersDark: boolean): ResolvedTheme {
  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme
}
