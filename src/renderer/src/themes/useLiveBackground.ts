import { useEffect, useState } from 'react'
import {
  normalizeAppearanceSettings,
  resolveAccentHex,
  resolveTheme,
  type AppearanceSettings,
  type ResolvedTheme,
  type ThemePreference
} from '@shared/theme'
import { resolveBackdrop, type BackdropDecision } from './themeEngine'
import { useEcoMode, usePrefersReducedMotion, type EcoState } from '../hooks/useEcoMode'

/** Track the OS light/dark preference, so `system` themes follow it live. */
export function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return dark
}

export interface LiveBackgroundState {
  theme: ResolvedTheme
  /** Shader choice plus what the canvas paints; `paintShader` is never guessed. */
  decision: BackdropDecision
  paintShader: BackdropDecision['paintShader']
  paused: boolean
  /** Canvas-safe hex, not `var(--accent)` and not `color-mix()`. */
  accent: string
  secondary: string
  eco: EcoState
}

/**
 * Everything the live background needs, recomputed when the palette, the accent,
 * the Eco-Saver state or the OS colour scheme changes.
 *
 * This exists because the first version read `document.documentElement.dataset.theme`
 * during render: dataset is not React state, so switching theme repainted the
 * app but left the canvas on the old palette until some unrelated re-render.
 * Deriving the theme from settings + `matchMedia` makes the dependency explicit.
 */
export function useLiveBackground(
  preference: ThemePreference | undefined,
  appearance: Partial<AppearanceSettings> | undefined
): LiveBackgroundState {
  const prefersDark = usePrefersDark()
  const reducedMotion = usePrefersReducedMotion()
  const eco = useEcoMode(appearance)
  const settings = normalizeAppearanceSettings(appearance)
  const theme = resolveTheme(preference ?? 'solar-flare', prefersDark)
  const colors = resolveAccentHex(theme, settings)
  const decision = resolveBackdrop(theme, {
    liveBackground: settings.liveBackground,
    eco: eco.eco,
    reducedMotion
  })
  return { theme, decision, paintShader: decision.paintShader, paused: decision.paused, accent: colors.accent, secondary: colors.secondary, eco }
}
