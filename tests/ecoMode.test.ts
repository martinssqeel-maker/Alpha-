import { describe, expect, it } from 'vitest'
import { ECO_BATTERY_THRESHOLD, resolveEcoState } from '../src/renderer/src/hooks/useEcoMode'
import { DEFAULT_APPEARANCE_SETTINGS, normalizeAppearanceSettings } from '../src/shared/theme'

const onBattery = (level: number) => ({ level, charging: false })
const charging = (level: number) => ({ level, charging: true })

describe('Eco-Saver defaults', () => {
  it('ships with the backdrop on and the saver off but ready to engage', () => {
    expect(DEFAULT_APPEARANCE_SETTINGS.liveBackground).toBe(true)
    expect(DEFAULT_APPEARANCE_SETTINGS.ecoMode).toBe(false)
    expect(DEFAULT_APPEARANCE_SETTINGS.ecoAuto).toBe(true)
  })

  it('survives settings written before these fields existed', () => {
    const legacy = { mode: 'dark' as const, glassIntensity: 50 }
    const normalized = normalizeAppearanceSettings(legacy as never)
    expect(normalized.liveBackground).toBe(DEFAULT_APPEARANCE_SETTINGS.liveBackground)
    expect(normalized.ecoMode).toBe(DEFAULT_APPEARANCE_SETTINGS.ecoMode)
    expect(normalized.ecoAuto).toBe(DEFAULT_APPEARANCE_SETTINGS.ecoAuto)
  })

  it('keeps an explicit user choice', () => {
    const normalized = normalizeAppearanceSettings({ ecoMode: true, liveBackground: false, ecoAuto: false } as never)
    expect(normalized.ecoMode).toBe(true)
    expect(normalized.liveBackground).toBe(false)
    expect(normalized.ecoAuto).toBe(false)
  })
})

describe('resolveEcoState', () => {
  it('stays off on mains power at any level', () => {
    for (const level of [0.05, 0.3, 1]) {
      const state = resolveEcoState({}, charging(level))
      expect(state.eco).toBe(false)
      expect(state.auto).toBe(false)
      expect(state.level).toBe(level)
      expect(state.charging).toBe(true)
    }
  })

  it('treats a machine with no battery API as plugged in', () => {
    const state = resolveEcoState({}, null)
    expect(state.eco).toBe(false)
    expect(state.auto).toBe(false)
    expect(state.level).toBeNull()
    expect(state.charging).toBeNull()
  })

  it('engages automatically when discharging at or below the threshold', () => {
    expect(resolveEcoState({}, onBattery(ECO_BATTERY_THRESHOLD)).eco).toBe(true)
    expect(resolveEcoState({}, onBattery(0.1)).auto).toBe(true)
  })

  it('stays off when discharging but still above the threshold', () => {
    const state = resolveEcoState({}, onBattery(ECO_BATTERY_THRESHOLD + 0.01))
    expect(state.eco).toBe(false)
    expect(state.auto).toBe(false)
  })

  it('never auto-engages when the user disabled auto', () => {
    const state = resolveEcoState({ ecoAuto: false } as never, onBattery(0.05))
    expect(state.eco).toBe(false)
    expect(state.auto).toBe(false)
  })

  it('honours the manual switch even on mains power', () => {
    const state = resolveEcoState({ ecoMode: true } as never, charging(0.9))
    expect(state.eco).toBe(true)
    expect(state.manual).toBe(true)
    expect(state.auto).toBe(false)
  })

  it('reports manual and auto separately so the UI can explain itself', () => {
    const both = resolveEcoState({ ecoMode: true } as never, onBattery(0.1))
    expect(both.eco).toBe(true)
    expect(both.manual).toBe(true)
    expect(both.auto).toBe(true)
  })

  it('does not treat reduced motion as a power event', () => {
    const state = resolveEcoState({}, charging(1), true)
    expect(state.eco).toBe(false)
    expect(state.auto).toBe(false)
  })
})
