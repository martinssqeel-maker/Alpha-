import { useCallback, useEffect, useState } from 'react'
import { Play, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { useApp } from '../store/useApp'
import type { MacroSummary } from '@shared/types'

/**
 * Macro manager.
 *
 * Shows what is saved and runs it on one click. Two deliberate choices:
 *  - parameters are collected up front, because a macro that renders to an empty
 *    command is worse than a prompt asking for the missing value;
 *  - running is asynchronous — the main process executes the steps through the
 *    normal tool pipeline, so approvals still appear in the Activity panel and a
 *    macro never bypasses a permission check.
 */
export default function MacroManager() {
  const toast = useApp((s) => s.toast)
  const revision = useApp((s) => s.macrosRevision)
  const [macros, setMacros] = useState<MacroSummary[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, Record<string, string>>>({})

  const load = useCallback(async () => {
    try {
      const list = await api.macros.list()
      setMacros(list)
    } catch (error) {
      toast(`Could not load macros: ${(error as Error).message}`, 'error')
      setMacros([])
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load, revision])

  const setParam = (slug: string, name: string, value: string) =>
    setValues((prev) => ({ ...prev, [slug]: { ...(prev[slug] ?? {}), [name]: value } }))

  const run = async (macro: MacroSummary) => {
    const missing = macro.params.filter((p) => p.required && !p.default && !values[macro.slug]?.[p.name])
    if (missing.length) {
      toast(`Fill in ${missing.map((p) => p.name).join(', ')} first.`, 'error')
      return
    }
    setBusy(macro.slug)
    try {
      const result = await api.macros.run({ slug: macro.slug, params: values[macro.slug] ?? {} })
      if (!result.ok) {
        toast(result.error ?? 'That macro could not be run.', 'error')
      } else {
        toast(`Running "${macro.name}" — steps appear in Activity.`, 'success')
      }
    } catch (error) {
      toast(`Macro failed: ${(error as Error).message}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const remove = async (macro: MacroSummary) => {
    try {
      const result = await api.macros.remove(macro.slug)
      if (result.ok) {
        toast(`Deleted "${macro.name}".`, 'success')
        await load()
      } else {
        toast('That macro no longer exists.', 'error')
      }
    } catch (error) {
      toast(`Could not delete: ${(error as Error).message}`, 'error')
    }
  }

  if (macros === null) {
    return (
      <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
        Loading macros…
      </div>
    )
  }

  if (macros.length === 0) {
    return (
      <div className="flex items-start gap-3">
        <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
          No macros saved yet. After a multi-step task runs successfully, save it as a macro so the
          next occurrence is one click instead of a dozen tool calls.
        </div>
        <button className="btn" onClick={() => void load()} title="Reload">
          <RefreshCw size={13} />
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {macros.map((macro) => {
        const required = macro.params.filter((p) => p.required && !p.default)
        return (
          <div key={macro.slug} className="macro-card">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">{macro.name}</div>
                {macro.description ? (
                  <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {macro.description}
                  </div>
                ) : null}
                <div className="text-xs mono" style={{ color: 'var(--muted)' }}>
                  {macro.slug}.alpha · {macro.stepCount} step{macro.stepCount === 1 ? '' : 's'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="btn"
                  disabled={busy === macro.slug}
                  onClick={() => void run(macro)}
                  title="Run this macro now"
                >
                  <Play size={13} /> {busy === macro.slug ? 'Running…' : 'Run'}
                </button>
                <button
                  className="btn"
                  onClick={() => void remove(macro)}
                  title="Delete this macro"
                  aria-label={`Delete ${macro.name}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {macro.params.length > 0 ? (
              <div className="flex flex-wrap gap-2 mt-2">
                {macro.params.map((param) => (
                  <label key={param.name} className="flex flex-col text-xs" style={{ minWidth: 160 }}>
                    <span style={{ color: 'var(--text-tertiary)' }}>
                      {param.name}
                      {param.required ? ' *' : ''}
                      {param.default ? ` (default: ${param.default})` : ''}
                    </span>
                    <input
                      className="input"
                      value={values[macro.slug]?.[param.name] ?? ''}
                      placeholder={param.description ?? param.default ?? ''}
                      onChange={(event) => setParam(macro.slug, param.name, event.target.value)}
                    />
                  </label>
                ))}
              </div>
            ) : null}

            {required.length > 0 ? (
              <div className="text-xs mt-2" style={{ color: 'var(--warning, #fbbf24)' }}>
                Requires: {required.map((p) => p.name).join(', ')}
              </div>
            ) : null}
          </div>
        )
      })}
      <div>
        <button className="btn" onClick={() => void load()} title="Reload macros from disk">
          <RefreshCw size={13} /> Reload
        </button>
      </div>
    </div>
  )
}
