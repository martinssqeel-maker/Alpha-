import { useMemo } from 'react'
import { Check } from 'lucide-react'
import { RESOLVED_THEME_OPTIONS, THEME_OPTIONS, THEME_TOKENS, resolveTheme, type ThemePreference } from '@shared/theme'

const GROUP_ORDER = ['Essentials', 'Dark', 'Warm', 'Light']

const GROUP_NOTES: Record<string, string> = {
  Essentials: 'The default Alpha palettes. System follows Windows.',
  Dark: 'Deep, low-glare surfaces built for long sessions.',
  Warm: 'Ink and clay tones with a warmer accent.',
  Light: 'Bright surfaces for daylight rooms.'
}

/**
 * Visual theme picker. Each card renders a miniature of the real palette from
 * `THEME_TOKENS`, so selecting a preset is a genuine preview rather than a
 * decorative swatch: the same tokens paint the application.
 */
export default function ThemeGallery({
  value,
  onChange
}: {
  value: ThemePreference
  onChange: (theme: ThemePreference) => void
}) {
  const prefersDark = useMemo(
    () => (typeof window === 'undefined' ? true : window.matchMedia('(prefers-color-scheme: dark)').matches),
    []
  )

  const grouped = useMemo(() => {
    const groups = new Map<string, typeof THEME_OPTIONS[number][]>()
    for (const option of THEME_OPTIONS) {
      const list = groups.get(option.group) ?? []
      list.push(option)
      groups.set(option.group, list)
    }
    return [...groups.entries()].sort(
      ([a], [b]) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b)
    )
  }, [])

  return (
    <div className="theme-gallery">
      {grouped.map(([group, options]) => (
        <div key={group} className="theme-group">
          <div className="theme-group-head">
            <span className="theme-group-title">{group}</span>
            {GROUP_NOTES[group] && <span className="theme-group-note">{GROUP_NOTES[group]}</span>}
          </div>
          <div className="theme-grid">
            {options.map((option) => {
              const resolved = option.id === 'system' ? resolveTheme('system', prefersDark) : option.id
              const tokens = THEME_TOKENS[resolved as (typeof RESOLVED_THEME_OPTIONS)[number]]
              const selected = value === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`theme-card ${selected ? 'selected' : ''}`}
                  aria-pressed={selected}
                  title={option.description}
                  onClick={() => onChange(option.id)}
                >
                  <span className="theme-preview" aria-hidden="true">
                    <span className="theme-preview-rail" style={{ background: tokens['--surface-0'] }}>
                      <span className="theme-preview-dot" style={{ background: tokens['--accent'] }} />
                      <span className="theme-preview-line" style={{ background: tokens['--text-tertiary'] }} />
                      <span className="theme-preview-line short" style={{ background: tokens['--text-disabled'] }} />
                    </span>
                    <span className="theme-preview-body" style={{ background: tokens['--surface-1'] }}>
                      <span className="theme-preview-card" style={{ background: tokens['--surface-2'], borderColor: tokens['--border-subtle'] }}>
                        <span className="theme-preview-bar" style={{ background: tokens['--text-primary'] }} />
                        <span className="theme-preview-bar short" style={{ background: tokens['--text-tertiary'] }} />
                      </span>
                      <span className="theme-preview-bar short" style={{ background: tokens['--text-tertiary'] }} />
                      <span className="theme-preview-chip" style={{ background: tokens['--accent'] }} />
                    </span>
                  </span>
                  <span className="theme-card-meta">
                    <span className="theme-card-label">
                      {option.label}
                      {selected && <Check size={13} className="theme-card-check" />}
                    </span>
                    <span className="theme-card-desc">{option.description}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
