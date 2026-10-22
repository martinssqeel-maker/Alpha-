import { useEffect, useState } from 'react'
import { normalizeAppearanceSettings, type AppearanceSettings } from '@shared/theme'

/**
 * Battery state as far as the Eco-Saver cares.
 *
 * `getBattery()` is non-standard (Chromium exposes it, Firefox does not) and can
 * disappear from a future Electron, so every read is optional and a machine
 * without the API is treated as "on mains". Guessing the opposite would switch
 * Eco-Saver on for desktop users who never asked for it.
 */
interface BatteryLike extends EventTarget {
  charging: boolean
  level: number
  addEventListener: (type: 'levelchange' | 'chargingchange', listener: () => void) => void
  removeEventListener: (type: 'levelchange' | 'chargingchange', listener: () => void) => void
}

interface NavigatorWithBattery {
  getBattery?: () => Promise<BatteryLike>
}

/** Below this level, a discharging machine is treated as a battery emergency. */
export const ECO_BATTERY_THRESHOLD = 0.25

export interface EcoState {
  /** True when continuous animation and glow must stop. */
  eco: boolean
  /** The user's own switch. */
  manual: boolean
  /** Eco is on because of the battery, not the user. */
  auto: boolean
  /** Battery percentage, when the platform reports one. */
  level: number | null
  charging: boolean | null
}

/**
 * Decide whether Eco-Saver is active.
 *
 * Pure so the rules can be tested without a browser: manual wins, auto applies
 * only when discharging below the threshold, and no battery information means
 * "not on battery".
 */
export function resolveEcoState(
  appearance: Partial<AppearanceSettings> | undefined,
  battery: { level: number; charging: boolean } | null,
  reducedMotion = false
): EcoState {
  const settings = normalizeAppearanceSettings(appearance)
  const onBattery = battery !== null && !battery.charging
  const lowBattery = battery !== null && battery.level <= ECO_BATTERY_THRESHOLD
  const auto = settings.ecoAuto && onBattery && lowBattery
  // Reduced motion is a comfort setting, not a power one: it stops the canvas
  // through `resolveShader` instead of claiming the machine is in eco mode.
  return {
    eco: settings.ecoMode || auto,
    manual: settings.ecoMode,
    auto,
    level: battery ? battery.level : null,
    charging: battery ? battery.charging : null
  }
}

/**
 * Track Eco-Saver state, including the OS battery.
 *
 * The `data-eco` attribute on <html> is what CSS keys off, so the whole visual
 * switch is one attribute rather than a prop threaded through every component.
 */
export function useEcoMode(appearance: Partial<AppearanceSettings> | undefined): EcoState {
  const [battery, setBattery] = useState<{ level: number; charging: boolean } | null>(null)
  const reducedMotion = usePrefersReducedMotion()

  useEffect(() => {
    const nav = navigator as Navigator & NavigatorWithBattery
    if (typeof nav.getBattery !== 'function') return
    let manager: BatteryLike | null = null
    let cancelled = false
    const read = (): void => {
      if (!manager || cancelled) return
      setBattery({ level: manager.level, charging: manager.charging })
    }
    void nav
      .getBattery()
      .then((result) => {
        if (cancelled) return
        manager = result
        read()
        manager.addEventListener('levelchange', read)
        manager.addEventListener('chargingchange', read)
      })
      .catch(() => {
        /* battery API blocked or removed: treat as mains power */
      })
    return () => {
      cancelled = true
      if (manager) {
        manager.removeEventListener('levelchange', read)
        manager.removeEventListener('chargingchange', read)
      }
    }
  }, [])

  const state = resolveEcoState(appearance, battery, reducedMotion)

  useEffect(() => {
    document.documentElement.dataset.eco = state.eco ? 'true' : 'false'
    document.documentElement.dataset.ecoAuto = state.auto ? 'true' : 'false'
  }, [state.eco, state.auto])

  return state
}

/** OS "reduce motion" preference, tracked live. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (): void => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}
