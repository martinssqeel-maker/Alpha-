import { useEffect, useState } from 'react'
import { Check, Sparkles } from 'lucide-react'
import type { ProductSkill } from '@shared/types'
import { api } from '../lib/api'

export default function SkillsPage() {
  const [skills, setSkills] = useState<ProductSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<Set<string>>(() => new Set())

  const loadSkills = async (): Promise<void> => {
    setLoading(true)
    try {
      setSkills(await api.skills.list())
      setError('')
    } catch (cause) {
      setError((cause as Error).message || 'Could not load agent skills.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadSkills() }, [])

  const setEnabled = async (skill: ProductSkill, enabled: boolean): Promise<void> => {
    setPending((current) => new Set(current).add(skill.id))
    try {
      setSkills(await api.skills.setEnabled(skill.id, enabled))
      setError('')
    } catch (cause) {
      setError((cause as Error).message || `Could not update ${skill.name}.`)
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(skill.id)
        return next
      })
    }
  }

  const enabledCount = skills.filter((skill) => skill.enabled).length

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Agent Skills</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>
            Focused guidance Alpha can use while helping with your work.
          </p>
        </div>
        {!loading && !error && <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{enabledCount} of {skills.length} enabled</span>}
      </div>

      <div className="page-scroll" style={{ maxWidth: 920 }}>
        <div className="card mb-3 flex items-start gap-3">
          <Sparkles size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <div className="text-sm font-semibold">Skills guide the assistant; they do not grant permissions.</div>
            <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
              Changes apply to new requests. File, terminal, and Git actions still follow your permission settings and approval choices.
            </div>
          </div>
        </div>

        {loading ? (
          <div className="card text-sm" style={{ color: 'var(--text-tertiary)' }}>Loading agent skills…</div>
        ) : error && skills.length === 0 ? (
          <div className="card flex items-center gap-3" role="alert">
            <span className="text-sm flex-1" style={{ color: 'var(--danger)' }}>{error}</span>
            <button className="btn" onClick={() => void loadSkills()}>Retry</button>
          </div>
        ) : skills.length === 0 ? (
          <div className="card">
            <div className="text-sm font-semibold">No skills available</div>
            <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
              Alpha could not find any bundled skill definitions.
            </div>
          </div>
        ) : (
          <>
            {error && <div className="text-sm mb-3" role="alert" style={{ color: 'var(--danger)' }}>{error}</div>}
            <div className="flex flex-col gap-3">
              {skills.map((skill) => {
                const busy = pending.has(skill.id)
                const toggleId = `skill-enabled-${skill.id}`
                return (
                  <article key={skill.id} className="card">
                    <div className="flex items-start gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-sm font-semibold">{skill.name}</h2>
                          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{skill.category}</span>
                          <span className="text-xs mono" style={{ color: 'var(--text-disabled)' }}>v{skill.version}</span>
                        </div>
                        <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>{skill.description}</p>
                      </div>
                      <label className="flex items-center gap-2 text-xs" htmlFor={toggleId} style={{ flexShrink: 0, color: skill.enabled ? 'var(--accent)' : 'var(--text-tertiary)' }}>
                        <input
                          id={toggleId}
                          type="checkbox"
                          checked={skill.enabled}
                          disabled={busy}
                          onChange={(event) => void setEnabled(skill, event.target.checked)}
                          aria-label={`${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`}
                        />
                        {busy ? 'Saving…' : skill.enabled ? <><Check size={13} /> Enabled</> : 'Disabled'}
                      </label>
                    </div>
                    <details className="mt-3">
                      <summary className="text-xs" style={{ color: 'var(--text-secondary, var(--muted))', cursor: 'pointer' }}>View instructions</summary>
                      <pre className="mono text-xs mt-2 p-3" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--text-secondary, var(--muted))', background: 'var(--surface-2)', borderRadius: 'var(--radius-md)' }}>{skill.instructions}</pre>
                    </details>
                  </article>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
