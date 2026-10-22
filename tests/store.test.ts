import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { Db } from '@main/services/db'
import { SettingsRepo, DEFAULT_SETTINGS } from '@main/services/store'
import { initLogger } from '@main/services/logger'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-store-test-'))

beforeAll(() => {
  initLogger(path.join(tmpRoot, 'logs'))
})

describe('SettingsRepo', () => {
  it('survives a persisted snapshot row (regression: deepMerge crash on "root")', async () => {
    const db = await Db.open(path.join(tmpRoot, 'regression.db'))
    try {
      const repo = new SettingsRepo(db)
      // set() writes both a full 'root' snapshot and per-key rows; get() must
      // skip 'root' instead of merging it and dying on missing base keys.
      repo.set({ theme: 'light' })
      const out = repo.get()
      expect(out.theme).toBe('light')
      expect(out.privacy.logLevel).toBe(DEFAULT_SETTINGS.privacy.logLevel)
      expect(out.ollamaUrl).toBe(DEFAULT_SETTINGS.ollamaUrl)
      expect(out.permissions.mode).toBe(DEFAULT_SETTINGS.permissions.mode)
    } finally {
      db.close()
    }
  })

  it('keeps defaults intact on an empty store', async () => {
    const db = await Db.open(path.join(tmpRoot, 'empty.db'))
    try {
      const out = new SettingsRepo(db).get()
      expect(out).toEqual(DEFAULT_SETTINGS)
    } finally {
      db.close()
    }
  })
})
describe('SettingsRepo appearance persistence', () => {
  it('round-trips the Phase 11 live-background and Eco-Saver fields', async () => {
    const db = await Db.open(path.join(tmpRoot, 'appearance.db'))
    try {
      const repo = new SettingsRepo(db)
      // The renderer sends a *partial* appearance patch; deepMerge has to keep the
      // untouched fields, or toggling Eco would reset the user's glass intensity.
      repo.set({ appearance: { ecoMode: true, liveBackground: false, ecoAuto: false } })
      const out = repo.get()
      expect(out.appearance.ecoMode).toBe(true)
      expect(out.appearance.liveBackground).toBe(false)
      expect(out.appearance.ecoAuto).toBe(false)
      expect(out.appearance.glassIntensity).toBe(DEFAULT_SETTINGS.appearance.glassIntensity)
      expect(out.appearance.accent).toBe(DEFAULT_SETTINGS.appearance.accent)

      // A second patch must not resurrect a previous value.
      repo.set({ appearance: { ecoMode: false } })
      expect(repo.get().appearance.ecoMode).toBe(false)
      expect(repo.get().appearance.liveBackground).toBe(false)
    } finally {
      db.close()
    }
  })
})
